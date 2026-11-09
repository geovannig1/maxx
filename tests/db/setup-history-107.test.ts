import { beforeEach, describe, expect, it } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { freshSchemaDb, insertAdAccount } from './schema-db'

const ACCOUNT = '00000000-0000-4000-8000-000000000107'
const OTHER = '00000000-0000-4000-8000-000000000108'
const SYNC_LOG = '00000000-0000-4000-8000-000000001107'
let db: PGlite

beforeEach(async () => {
  db = await freshSchemaDb()
  await insertAdAccount(db, ACCOUNT)
  await insertAdAccount(db, OTHER)
  await db.query(`INSERT INTO public.api_sync_logs(id,ad_account_id) VALUES ($1,$2)`, [SYNC_LOG, ACCOUNT])
})

async function seedGeneration(id: string, account = ACCOUNT, syncLog: string | null = null) {
  await db.query(`
    INSERT INTO public.meta_setup_generations (
      id, ad_account_id, sync_log_id, contract_version, observed_at, complete,
      blocker_codes, entity_count, generation_fingerprint
    ) VALUES ($1,$2,$3,1,'2026-08-16T12:00:00Z',true,'{}',1,
      'sha256:1111111111111111111111111111111111111111111111111111111111111111')
  `, [id, account, syncLog])
}

describe('setup-history lineage', () => {
  it('creates append-only service-role tables with browser-role access revoked', async () => {
    await seedGeneration('00000000-0000-4000-8000-000000002107', ACCOUNT, SYNC_LOG)

    await expect(db.query(`
      UPDATE public.meta_setup_generations SET entity_count=2
      WHERE id='00000000-0000-4000-8000-000000002107'
    `)).rejects.toThrow(/append-only/i)
    await expect(db.query(`
      DELETE FROM public.meta_setup_generations
      WHERE id='00000000-0000-4000-8000-000000002107'
    `)).rejects.toThrow(/append-only/i)
    await expect(db.query(`TRUNCATE public.setup_material_changes`)).rejects.toThrow(/append-only/i)

    const privileges = await db.query<{
      authenticated: boolean
      anon: boolean
      service_insert: boolean
      service_update: boolean
      service_truncate: boolean
      service_references: boolean
      service_trigger: boolean
    }>(`
      SELECT
        has_table_privilege('authenticated','public.meta_setup_generations','SELECT') authenticated,
        has_table_privilege('anon','public.meta_setup_generations','SELECT') anon,
        has_table_privilege('service_role','public.meta_setup_generations','INSERT') service_insert,
        has_table_privilege('service_role','public.meta_setup_generations','UPDATE') service_update,
        has_table_privilege('service_role','public.meta_setup_generations','TRUNCATE') service_truncate,
        has_table_privilege('service_role','public.meta_setup_generations','REFERENCES') service_references,
        has_table_privilege('service_role','public.meta_setup_generations','TRIGGER') service_trigger
    `)
    expect(privileges.rows[0]).toEqual({
      authenticated: false,
      anon: false,
      service_insert: true,
      service_update: false,
      service_truncate: false,
      service_references: false,
      service_trigger: false,
    })
  })

  it('enforces account scope across snapshots and material changes', async () => {
    await seedGeneration('00000000-0000-4000-8000-000000002107', ACCOUNT)
    await seedGeneration('00000000-0000-4000-8000-000000003107', OTHER)

    await expect(db.query(`
      INSERT INTO public.meta_setup_entity_snapshots (
        generation_id, ad_account_id, entity_level, meta_entity_id,
        config, config_fingerprint
      ) VALUES (
        '00000000-0000-4000-8000-000000002107',$1,'adset','238',
        '{"status":"ACTIVE"}','sha256:2222222222222222222222222222222222222222222222222222222222222222')
    `, [OTHER])).rejects.toThrow(/account scope/i)

    await expect(db.query(`
      INSERT INTO public.setup_material_changes (
        ad_account_id, from_generation_id, to_generation_id, entity_level, meta_entity_id,
        change_type, field_path, before_value, after_value, reason_status
      ) VALUES (
        $1,
        '00000000-0000-4000-8000-000000002107',
        '00000000-0000-4000-8000-000000003107',
        'adset','238','updated','daily_budget','50','75','reason_unknown')
    `, [ACCOUNT])).rejects.toThrow(/account scope/i)
  })

  it('requires complete-generation fingerprints and reason evidence for approved-plan matches', async () => {
    await expect(db.query(`
      INSERT INTO public.meta_setup_generations (
        ad_account_id, contract_version, observed_at, complete,
        blocker_codes, entity_count, generation_fingerprint
      ) VALUES ($1,1,'2026-08-16T12:00:00Z',true,'{}',1,'bad-fingerprint')
    `, [ACCOUNT])).rejects.toThrow()

    await seedGeneration('00000000-0000-4000-8000-000000002107', ACCOUNT)
    await seedGeneration('00000000-0000-4000-8000-000000004107', ACCOUNT)

    await expect(db.query(`
      INSERT INTO public.setup_material_changes (
        ad_account_id, from_generation_id, to_generation_id, entity_level, meta_entity_id,
        change_type, field_path, before_value, after_value, reason_status
      ) VALUES (
        $1,
        '00000000-0000-4000-8000-000000002107',
        '00000000-0000-4000-8000-000000004107',
        'adset','238','updated','daily_budget','50','75','matched_approved_plan')
    `, [ACCOUNT])).rejects.toThrow(/approved_plan|reason_contract/i)
  })

  it('commits a generation atomically and rolls back mismatched complete rows', async () => {
    const generation = {
      id: '00000000-0000-4000-8000-000000005107',
      ad_account_id: ACCOUNT,
      sync_log_id: null,
      contract_version: 1,
      observed_at: '2026-08-16T12:00:00Z',
      source_kind: 'meta_sync_snapshot',
      complete: true,
      blocker_codes: [],
      entity_count: 2,
      generation_fingerprint: 'sha256:3333333333333333333333333333333333333333333333333333333333333333',
    }
    const snapshots = [{
      ad_account_id: ACCOUNT,
      contract_version: 1,
      entity_level: 'campaign',
      entity_db_id: null,
      meta_entity_id: '238-campaign',
      parent_meta_ids: {},
      config: { status: 'ACTIVE' },
      config_fingerprint: 'sha256:4444444444444444444444444444444444444444444444444444444444444444',
      observed_synced_at: '2026-08-16T12:00:00Z',
    }]

    await expect(db.query(
      `SELECT public.commit_meta_setup_generation($1::jsonb,$2::jsonb,'[]'::jsonb)`,
      [JSON.stringify(generation), JSON.stringify(snapshots)],
    )).rejects.toThrow(/entity count mismatch/i)

    const count = await db.query<{ count: number }>(`SELECT count(*)::int count FROM public.meta_setup_generations`)
    expect(count.rows[0].count).toBe(0)

    await expect(db.query(
      `SELECT public.commit_meta_setup_generation($1::jsonb,$2::jsonb,'[]'::jsonb)`,
      [JSON.stringify({ ...generation, entity_count: 1 }), JSON.stringify(snapshots)],
    )).resolves.toBeDefined()
  })
})
