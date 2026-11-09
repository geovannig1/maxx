import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { freshSchemaDb, insertAdAccount } from './schema-db'
import { insertActionDecision } from './decision-fixture'
import { metaCurrencyOffset } from '@/lib/platforms/meta/currency-offset'

// Security review L5: the database repeats the owner budget rules wherever the before-state is known.
// An owner adjust_budget request must move in its decision's direction, and a step above the per-change
// limit (the limit the RPC is given, 50% when none) or any step from a zero budget needs step_override.

const ACCOUNT = '00000000-0000-4000-8000-000000000681'
const JPY_ACCOUNT = '00000000-0000-4000-8000-000000000682'
const OWNER = '00000000-0000-4000-8000-0000000000aa'
const ADSET = '120000000000000681'
let db: PGlite
let seq = 0

async function propose(kind: 'budget_scale' | 'budget_cut', beforeMinor: string | null, amount: number, extra: Record<string, unknown> = {}, account = ACCOUNT) {
  seq += 1
  const decision = await insertActionDecision(db, account, {
    action_kind: kind, target_level: 'adset', target_id: ADSET, authority_tier: 'owner_review', direction_ceiling: 'owner_review',
    evidence_plane: 'meta_modelled', evidence_basis: 'meta_modelled_association', pragmatic_media_buyer: true, source_kind: 'recommendation',
  })
  const before = beforeMinor === null ? { id: ADSET } : { id: ADSET, daily_budget: beforeMinor }
  return db.query('SELECT * FROM public.create_owner_change_request($1, $2, $3)', [decision, OWNER, JSON.stringify({
    ad_account_id: account, action_type: 'adjust_budget', entity_level: 'adset', meta_entity_id: ADSET, params: { new_daily_budget: amount },
    before_state: before, preview: 'Budget', risk_level: 'high', rollback_plan: 'restore', idempotency_key: `budget-681-${seq}`, requested_by: 'owner', ...extra,
  })])
}

beforeAll(async () => {
  db = await freshSchemaDb()
  await insertAdAccount(db, ACCOUNT, 'act_681')
  await insertAdAccount(db, JPY_ACCOUNT, 'act_682')
  await db.query(`UPDATE public.ad_accounts SET currency = 'USD' WHERE id = $1`, [ACCOUNT])
  await db.query(`UPDATE public.ad_accounts SET currency = 'JPY' WHERE id = $1`, [JPY_ACCOUNT])
}, 120_000)
afterAll(async () => db.close())

describe('owner budget direction and step in the database (security review L5)', () => {
  it('accepts a raise within the limit (control) and a request with no recorded budget', async () => {
    await expect(propose('budget_scale', '2000', 25)).resolves.toBeDefined()
    await expect(propose('budget_scale', null, 25)).resolves.toBeDefined()
  })

  it('refuses a budget that moves against the decision direction', async () => {
    await expect(propose('budget_scale', '2000', 15)).rejects.toThrow(/owner_change_budget_direction_mismatch/)
    await expect(propose('budget_cut', '2000', 25)).rejects.toThrow(/owner_change_budget_direction_mismatch/)
  })

  it('needs step_override above the limit, honouring the limit the RPC is given', async () => {
    await expect(propose('budget_scale', '2000', 40)).rejects.toThrow(/owner_change_step_override_required/)
    await expect(propose('budget_scale', '2000', 40, { step_override: true })).resolves.toBeDefined()
    await expect(propose('budget_scale', '2000', 40, { max_step_percent: 150 })).resolves.toBeDefined()
    await expect(propose('budget_scale', '2000', 40, { max_step_percent: 10 })).rejects.toThrow(/owner_change_step_override_required/)
  })

  it('treats any step from a zero budget as needing the override', async () => {
    await expect(propose('budget_scale', '0', 5)).rejects.toThrow(/owner_change_step_override_required/)
    await expect(propose('budget_scale', '0', 5, { step_override: true })).resolves.toBeDefined()
  })

  it('reads the before-state in the account currency\'s Meta minor units (JPY has none)', async () => {
    await expect(propose('budget_scale', '2000', 2500, {}, JPY_ACCOUNT)).resolves.toBeDefined()
    await expect(propose('budget_scale', '2000', 25, {}, JPY_ACCOUNT)).rejects.toThrow(/owner_change_budget_direction_mismatch/)
  })

  it('uses the same Meta currency offsets as the application, for every three-letter code', async () => {
    const { rows } = await db.query<{ code: string; offset: number | null }>(`
      SELECT chr(a) || chr(b) || chr(c) AS code, public.meta_currency_offset(chr(a) || chr(b) || chr(c)) AS offset
        FROM generate_series(65, 90) a, generate_series(65, 90) b, generate_series(65, 90) c`)
    expect(rows).toHaveLength(26 ** 3)
    const mismatches = rows.filter((r) => r.offset !== metaCurrencyOffset(r.code)).map((r) => r.code)
    expect(mismatches).toEqual([])
    expect(rows.filter((r) => r.offset !== null).length).toBeGreaterThan(60)
  })
})
