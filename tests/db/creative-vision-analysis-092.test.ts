import type { PGlite } from '@electric-sql/pglite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { freshSchemaDb, insertAdAccount } from './schema-db'

const ACCOUNT = '00000000-0000-4000-8000-000000000921'
const OTHER_ACCOUNT = '00000000-0000-4000-8000-000000000922'
const CREATIVE = '00000000-0000-4000-8000-000000000923'
const OTHER_CREATIVE = '00000000-0000-4000-8000-000000000924'

let db: PGlite

const fingerprint = (character: string) => `sha256:${character.repeat(64)}`

async function insertVersion(overrides: Record<string, unknown> = {}) {
  const values = {
    ad_account_id: ACCOUNT,
    creative_id: CREATIVE,
    meta_creative_id: '1000000000000005',
    analysis_schema_version: 1,
    prompt_version: 'creative-attributes-v1',
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    source_asset_fingerprint: fingerprint('a'),
    prompt_fingerprint: fingerprint('b'),
    analysis_fingerprint: fingerprint('c'),
    analysis: {
      format: 'video',
      has_text_overlay: false,
      hook_text: null,
      shows_price: false,
      talent_type: 'solo',
      setting: 'studio',
      color_mood: 'bright',
      cta_visible: true,
      hook_strength_score: 3,
      notes: null,
    },
    analyzed_at: '2026-08-12T12:00:00.000Z',
    ...overrides,
  }

  return db.query(`
    INSERT INTO public.creative_vision_analysis_versions(
      ad_account_id,creative_id,meta_creative_id,analysis_schema_version,
      prompt_version,provider,model,source_asset_fingerprint,prompt_fingerprint,
      analysis_fingerprint,analysis,analyzed_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
    RETURNING id
  `, [
    values.ad_account_id,
    values.creative_id,
    values.meta_creative_id,
    values.analysis_schema_version,
    values.prompt_version,
    values.provider,
    values.model,
    values.source_asset_fingerprint,
    values.prompt_fingerprint,
    values.analysis_fingerprint,
    values.analysis,
    values.analyzed_at,
  ])
}

beforeEach(async () => {
  db = await freshSchemaDb()
  await insertAdAccount(db, ACCOUNT)
  await insertAdAccount(db, OTHER_ACCOUNT)
  await db.exec(`
    INSERT INTO public.creatives(id,ad_account_id,creative_id) VALUES
      ('${CREATIVE}','${ACCOUNT}','1000000000000005'),
      ('${OTHER_CREATIVE}','${OTHER_ACCOUNT}','1000000000000006');
  `)
})

afterEach(async () => {
  await db.close()
})

describe('versioned creative vision evidence', () => {
  it('stores complete source, prompt, provider, model, schema, and analysis lineage', async () => {
    await insertVersion()

    const result = await db.query<Record<string, unknown>>(`
      SELECT ad_account_id::text,creative_id::text,meta_creative_id,
        analysis_schema_version,prompt_version,provider,model,
        source_asset_fingerprint,prompt_fingerprint,analysis_fingerprint,
        analysis,analyzed_at,created_at
      FROM public.creative_vision_analysis_versions
    `)

    expect(result.rows).toEqual([expect.objectContaining({
      ad_account_id: ACCOUNT,
      creative_id: CREATIVE,
      meta_creative_id: '1000000000000005',
      analysis_schema_version: 1,
      prompt_version: 'creative-attributes-v1',
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      source_asset_fingerprint: fingerprint('a'),
      prompt_fingerprint: fingerprint('b'),
      analysis_fingerprint: fingerprint('c'),
      analysis: expect.objectContaining({ format: 'video', setting: 'studio' }),
      analyzed_at: new Date('2026-08-12T12:00:00.000Z'),
      created_at: expect.any(Date),
    })])
  })

  it('is append-only and idempotent for one exact analysis identity', async () => {
    await insertVersion()
    await expect(insertVersion()).rejects.toThrow(/unique|duplicate/i)
    await expect(insertVersion({
      analysis_fingerprint: fingerprint('d'),
      analysis: {
        format: 'static', has_text_overlay: true, hook_text: null, shows_price: false,
        talent_type: 'none', setting: 'other', color_mood: 'neutral', cta_visible: false,
        hook_strength_score: 2, notes: null,
      },
    })).rejects.toThrow(/unique|duplicate/i)
    await expect(db.exec(`UPDATE public.creative_vision_analysis_versions
      SET model='different-model'`)).rejects.toThrow(/append-only|immutable/i)
    await expect(db.exec('DELETE FROM public.creative_vision_analysis_versions'))
      .rejects.toThrow(/append-only|immutable/i)
    await expect(db.exec('TRUNCATE public.creative_vision_analysis_versions'))
      .rejects.toThrow(/append-only|truncate|immutable/i)
  })

  it('rejects cross-account ownership and malformed evidence metadata', async () => {
    await expect(insertVersion({
      creative_id: OTHER_CREATIVE,
      meta_creative_id: '1000000000000006',
    })).rejects.toThrow(/foreign key|constraint/i)
    await expect(insertVersion({ source_asset_fingerprint: 'not-a-fingerprint' }))
      .rejects.toThrow(/constraint/i)
    await expect(insertVersion({ analysis: [] })).rejects.toThrow(/constraint/i)
    await expect(insertVersion({ provider: 'unknown-provider' })).rejects.toThrow(/constraint/i)
  })

  it('allows only service-role reads and appends', async () => {
    const boundary = (await db.query<{
      rls: boolean
      service_select: boolean
      service_insert: boolean
      service_update: boolean
      service_delete: boolean
      authenticated_privileges: number
      anon_privileges: number
    }>(`
      SELECT
        (SELECT relrowsecurity FROM pg_catalog.pg_class
          WHERE oid='public.creative_vision_analysis_versions'::pg_catalog.regclass) rls,
        has_table_privilege('service_role','public.creative_vision_analysis_versions','SELECT') service_select,
        has_table_privilege('service_role','public.creative_vision_analysis_versions','INSERT') service_insert,
        has_table_privilege('service_role','public.creative_vision_analysis_versions','UPDATE') service_update,
        has_table_privilege('service_role','public.creative_vision_analysis_versions','DELETE') service_delete,
        (SELECT count(*)::int FROM (VALUES ('SELECT'),('INSERT'),('UPDATE'),('DELETE')) p(privilege)
          WHERE has_table_privilege('authenticated','public.creative_vision_analysis_versions',privilege))
          authenticated_privileges,
        (SELECT count(*)::int FROM (VALUES ('SELECT'),('INSERT'),('UPDATE'),('DELETE')) p(privilege)
          WHERE has_table_privilege('anon','public.creative_vision_analysis_versions',privilege))
          anon_privileges
    `)).rows[0]

    expect(boundary).toEqual({
      rls: true,
      service_select: true,
      service_insert: true,
      service_update: false,
      service_delete: false,
      authenticated_privileges: 0,
      anon_privileges: 0,
    })
  })
})
