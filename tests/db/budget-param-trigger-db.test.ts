import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { freshSchemaDb, insertAdAccount } from './schema-db'
import { insertActionDecision } from './decision-fixture'

// Migration 20261115000100: the change-request trigger validates the budget parameter under its
// current name new_daily_budget (account currency) and still accepts new_daily_budget_usd, the deprecated
// name, for one release: exactly one of the two, matching the key the ActionDecision was authorised with.
// Only the trigger under test is enabled on change_requests; the decisions are inserted directly.

const ACCOUNT = '00000000-0000-4000-8000-000000000515'
const ADSET = 'adset-515'

let db: PGlite
let seq = 0

async function decision(kind: string, mutation: Record<string, unknown>): Promise<string> {
  return insertActionDecision(db, ACCOUNT, {
    action_kind: kind, target_level: 'adset', target_id: ADSET, authority_tier: 'execution_eligible',
    proposed_mutation: JSON.stringify(mutation),
  })
}

function changeRequest(decisionId: string, actionType: string, params: Record<string, unknown>) {
  seq += 1
  return db.query(
    `INSERT INTO public.change_requests (ad_account_id, action_decision_id, status, action_type, entity_level,
       meta_entity_id, params, preview, idempotency_key)
     VALUES ($1, $2, 'pending', $3, 'adset', $4, $5, 'preview', $6)`,
    [ACCOUNT, decisionId, actionType, ADSET, JSON.stringify(params), `p5f-${seq}`])
}

beforeAll(async () => {
  db = await freshSchemaDb()
  await insertAdAccount(db, ACCOUNT, 'act_515')
  await db.exec('ALTER TABLE public.action_decisions DISABLE TRIGGER USER')
  // The decision's own lineage CHECKs (causal estimate, cohort, ceiling) are not under test here.
  await db.exec(`DO $$ DECLARE c record; BEGIN
    FOR c IN SELECT conname FROM pg_constraint WHERE conrelid = 'public.action_decisions'::regclass AND contype IN ('c', 'f') LOOP
      EXECUTE format('ALTER TABLE public.action_decisions DROP CONSTRAINT %I', c.conname);
    END LOOP; END $$`)
  await db.exec('ALTER TABLE public.change_requests DISABLE TRIGGER USER')
  const { rows } = await db.query<{ t: string }>(
    `SELECT tgname t FROM pg_trigger WHERE tgrelid = 'public.change_requests'::regclass
       AND tgfoid = 'public.enforce_change_request_action_decision'::regproc`)
  expect(rows).toHaveLength(1)
  await db.exec(`ALTER TABLE public.change_requests ENABLE TRIGGER ${rows[0].t}`)
  await db.query(`UPDATE public.action_decisions SET approval_state = 'pending'`)
}, 120_000)
afterAll(async () => db.close())

async function pendingDecision(kind: string, mutation: Record<string, unknown>): Promise<string> {
  const id = await decision(kind, mutation)
  await db.query(`UPDATE public.action_decisions SET approval_state = 'pending' WHERE id = $1`, [id])
  return id
}

describe('change-request budget parameter', () => {
  it('accepts an adjust_budget request under the new name', async () => {
    const id = await pendingDecision('budget_scale', { action_type: 'adjust_budget', new_daily_budget: 60 })
    await expect(changeRequest(id, 'adjust_budget', { new_daily_budget: 60 })).resolves.toBeTruthy()
  })

  it('still accepts the deprecated name for a decision authorised under it', async () => {
    const id = await pendingDecision('budget_scale', { action_type: 'adjust_budget', new_daily_budget_usd: 60 })
    await expect(changeRequest(id, 'adjust_budget', { new_daily_budget_usd: 60 })).resolves.toBeTruthy()
  })

  it('refuses both names at once, a key that differs from the decision, and a non-numeric amount (controls)', async () => {
    const id = await pendingDecision('budget_scale', { action_type: 'adjust_budget', new_daily_budget: 60 })
    await expect(changeRequest(id, 'adjust_budget', { new_daily_budget: 60, new_daily_budget_usd: 60 })).rejects.toThrow(/budget/)
    await expect(changeRequest(id, 'adjust_budget', { new_daily_budget_usd: 60 })).rejects.toThrow(/does_not_match_action_decision/)
    await expect(changeRequest(id, 'adjust_budget', { new_daily_budget: '60' })).rejects.toThrow(/must_be_numeric/)
    await expect(changeRequest(id, 'adjust_budget', { new_daily_budget: 61 })).rejects.toThrow(/does_not_match_action_decision/)
  })

  it('accepts a duplicate under either name, with or without a budget', async () => {
    const current = await pendingDecision('structural', { action_type: 'duplicate_adset', new_name: 'Copy', new_daily_budget: null })
    await expect(changeRequest(current, 'duplicate_adset', { new_name: 'Copy', new_daily_budget: null })).resolves.toBeTruthy()
    const legacy = await pendingDecision('structural', { action_type: 'duplicate_adset', new_name: 'Copy', new_daily_budget_usd: 25 })
    await expect(changeRequest(legacy, 'duplicate_adset', { new_name: 'Copy', new_daily_budget_usd: 25 })).resolves.toBeTruthy()
  })

  it('refuses a duplicate carrying both names (control)', async () => {
    const id = await pendingDecision('structural', { action_type: 'duplicate_adset', new_name: 'Copy', new_daily_budget: 25 })
    await expect(changeRequest(id, 'duplicate_adset', { new_name: 'Copy', new_daily_budget: 25, new_daily_budget_usd: 25 }))
      .rejects.toThrow(/duplicate_params_invalid/)
  })
})
