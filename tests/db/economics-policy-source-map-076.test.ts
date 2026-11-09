import { beforeEach, describe, expect, it } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { freshSchemaDb, insertAdAccount } from './schema-db'

const ACCOUNT = '00000000-0000-4000-8000-000000000076'
const HASH = `sha256:${'a'.repeat(64)}`
let db: PGlite

async function commit(map: Record<string, string>) {
  return db.query<Record<string, unknown>>(`
    SELECT (public.commit_economics_policy_version(
      $1,1,'maximize_incremental_contribution_from_ad_attributed_collected_revenue',
      'USD','unknown_processor','merchant_1',30,'outcome_actual_entries',
      ARRAY['owner_actual_cost_export','payroll_actual_export'],
      ARRAY['consumables','provider_commission'],$2::jsonb,'excluded_from_contribution',
      $3,'owner_entry','owner worksheet','2026-08-02T12:00:00Z','mapped-policy-v1'
    )).*`, [ACCOUNT, JSON.stringify(map), HASH])
}

beforeEach(async () => {
  db = await freshSchemaDb()
  await insertAdAccount(db, ACCOUNT)
})

describe('economics category/source ownership', () => {
  it('stores an exact one-source-per-category mapping in the approved artifact', async () => {
    const result = await commit({
      consumables: 'owner_actual_cost_export',
      provider_commission: 'payroll_actual_export',
    })
    expect(result.rows[0]).toMatchObject({
      variable_cost_category_sources: {
        consumables: 'owner_actual_cost_export',
        provider_commission: 'payroll_actual_export',
      },
    })
  })

  it('rejects missing categories, unused required sources, and unknown mapped sources', async () => {
    await expect(commit({ consumables: 'owner_actual_cost_export' }))
      .rejects.toThrow(/economics_policy_cost_source_map|check constraint/i)
    await expect(commit({
      consumables: 'owner_actual_cost_export',
      provider_commission: 'owner_actual_cost_export',
    })).rejects.toThrow(/economics_policy_cost_source_map|check constraint/i)
    await expect(commit({
      consumables: 'owner_actual_cost_export',
      provider_commission: 'unknown_export',
    })).rejects.toThrow(/economics_policy_cost_source_map|check constraint/i)
  })

  it('removes the unmapped RPC signature so callers cannot bypass category ownership', async () => {
    const old = await db.query<{ n: number }>(`
      SELECT count(*)::int n FROM pg_proc
      WHERE oid=to_regprocedure(
        'public.commit_economics_policy_version(uuid,integer,text,text,text,text,integer,text,text[],text[],text,text,text,text,timestamptz,text)')
    `)
    expect(old.rows[0].n).toBe(0)
    expect(await db.query(`SELECT has_function_privilege(
      'service_role',
      'public.commit_economics_policy_version(uuid,integer,text,text,text,text,integer,text,text[],text[],jsonb,text,text,text,text,timestamptz,text)',
      'EXECUTE') AS allowed`)).toMatchObject({ rows: [{ allowed: true }] })
  })
})
