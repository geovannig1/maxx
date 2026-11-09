import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { freshSchemaDb, insertAdAccount } from './schema-db'
import { insertActionDecision } from './decision-fixture'

// ADR-059: owner-initiated change requests on the SHIPPED schema, every trigger enabled. An owner may
// propose on an owner_review decision; an agent may not; diagnostic_only never; the initiator is
// frozen; an expired request cannot be approved; a rollback reverses only an executed original.

const ACCOUNT = '00000000-0000-4000-8000-000000000591'
const OWNER = '00000000-0000-4000-8000-0000000000aa'
const ADSET = '120000000000000591'
const AD = '120000000000000592'
let db: PGlite
let seq = 0

const ownerReviewMoney = (kind: string, level: 'ad' | 'adset', target: string, extra: Record<string, unknown> = {}) =>
  insertActionDecision(db, ACCOUNT, {
    action_kind: kind, target_level: level, target_id: target, authority_tier: 'owner_review',
    direction_ceiling: 'owner_review', evidence_plane: 'meta_modelled', evidence_basis: 'meta_modelled_association',
    pragmatic_media_buyer: true, source_kind: 'recommendation', ...extra,
  })

function request(actionType: string, level: string, target: string, params: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  seq += 1
  return {
    ad_account_id: ACCOUNT, action_type: actionType, entity_level: level, meta_entity_id: target, params,
    before_state: { id: target }, preview: 'preview', risk_level: 'high', rollback_plan: 'inverse',
    idempotency_key: `owner-591-${seq}`, requested_by: 'owner@example.com', ...extra,
  }
}

async function ownerCreate(decisionId: string, body: Record<string, unknown>, owner: string | null = OWNER) {
  const { rows } = await db.query<{ id: string; status: string; initiated_by: string; requested_by_user_id: string }>(
    'SELECT * FROM public.create_owner_change_request($1, $2, $3)', [decisionId, owner, JSON.stringify(body)])
  return rows[0]
}

const agentCreate = (decisionId: string, body: Record<string, unknown>) =>
  db.query('SELECT * FROM public.create_change_request_from_decision($1, $2)', [decisionId, JSON.stringify(body)])

const review = (id: string, approve: boolean) =>
  db.query('SELECT * FROM public.review_change_request_with_decision($1, $2, $3)', [id, 'owner@example.com', approve])

const approval = async (decisionId: string) =>
  (await db.query<{ approval_state: string }>('SELECT approval_state FROM public.action_decisions WHERE id = $1', [decisionId])).rows[0].approval_state

beforeAll(async () => {
  db = await freshSchemaDb()
  await insertAdAccount(db, ACCOUNT, 'act_591')
}, 120_000)
afterAll(async () => db.close())

describe('owner-initiated change requests (ADR-059)', () => {
  it('creates an owner request on an owner_review budget decision with no engine mutation, then approves it', async () => {
    const decision = await ownerReviewMoney('budget_scale', 'adset', ADSET)
    const row = await ownerCreate(decision, request('adjust_budget', 'adset', ADSET, { new_daily_budget: 30 }))
    expect(row).toMatchObject({ status: 'pending', initiated_by: 'owner', requested_by_user_id: OWNER })
    expect(await approval(decision)).toBe('pending')
    // Double-click safe: the same decision returns the same request.
    expect((await ownerCreate(decision, request('adjust_budget', 'adset', ADSET, { new_daily_budget: 30 }))).id).toBe(row.id)
    await review(row.id, true)
    expect(await approval(decision)).toBe('approved')
  })

  it('refuses the same owner_review decision on the agent path (control: agent rules unchanged)', async () => {
    const decision = await ownerReviewMoney('pause', 'ad', AD)
    await expect(agentCreate(decision, request('pause_ad', 'ad', AD, {}))).rejects.toThrow(/not_execution_eligible/)
  })

  it('refuses a diagnostic_only decision even for the owner', async () => {
    const decision = await insertActionDecision(db, ACCOUNT, {
      action_kind: 'pause', target_level: 'ad', target_id: AD, source_kind: 'recommendation',
    })
    await expect(ownerCreate(decision, request('pause_ad', 'ad', AD, {}))).rejects.toThrow(/not_execution_eligible/)
  })

  it('refuses a request without an owner identity, and a kind the decision does not authorize', async () => {
    const decision = await ownerReviewMoney('pause', 'ad', AD)
    await expect(ownerCreate(decision, request('pause_ad', 'ad', AD, {}), null)).rejects.toThrow(/owner_identity/)
    await expect(ownerCreate(decision, request('activate_ad', 'ad', AD, {}))).rejects.toThrow(/kind_mismatch/)
  })

  it('requires the owner params to equal an engine-proposed mutation when one exists', async () => {
    const decision = await insertActionDecision(db, ACCOUNT, {
      action_kind: 'structural', target_level: 'adset', target_id: ADSET, authority_tier: 'owner_review',
      direction_ceiling: 'owner_review', source_kind: 'recommendation',
      proposed_mutation: JSON.stringify({ action_type: 'duplicate_adset', new_name: 'Engine copy', new_daily_budget: null }),
    })
    await expect(ownerCreate(decision, request('duplicate_adset', 'adset', ADSET, { new_name: 'Other', new_daily_budget: null })))
      .rejects.toThrow(/does_not_match_action_decision/)
    await expect(ownerCreate(decision, request('duplicate_adset', 'adset', ADSET, { new_name: 'Engine copy', new_daily_budget: null })))
      .resolves.toMatchObject({ status: 'pending' })
  })

  it('never lets an owner_review decision be approved without an owner request (guard)', async () => {
    const decision = await ownerReviewMoney('pause', 'ad', AD)
    await db.query(`UPDATE public.action_decisions SET approval_state = 'pending' WHERE id = $1`, [decision])
    await expect(db.query(`UPDATE public.action_decisions SET approval_state = 'approved' WHERE id = $1`, [decision]))
      .rejects.toThrow(/only execution_eligible may be approved/)
  })

  it('freezes the initiator and owner identity after insert', async () => {
    const decision = await ownerReviewMoney('pause', 'ad', AD)
    const row = await ownerCreate(decision, request('pause_ad', 'ad', AD, {}))
    await expect(db.query(`UPDATE public.change_requests SET initiated_by = 'agent', requested_by_user_id = NULL WHERE id = $1`, [row.id]))
      .rejects.toThrow()
    await expect(db.query(`UPDATE public.change_requests SET step_override = true WHERE id = $1`, [row.id]))
      .rejects.toThrow(/initiator_is_immutable/)
  })

  it('refuses to approve an expired request but still lets it be rejected', async () => {
    const decision = await ownerReviewMoney('pause', 'ad', AD)
    const row = await ownerCreate(decision, request('pause_ad', 'ad', AD, {}))
    await db.exec(`ALTER TABLE public.change_requests DISABLE TRIGGER trg_change_request_approval_context`)
    await db.query(`UPDATE public.change_requests SET expires_at = now() - interval '1 minute' WHERE id = $1`, [row.id])
    await db.exec(`ALTER TABLE public.change_requests ENABLE TRIGGER trg_change_request_approval_context`)
    await expect(review(row.id, true)).rejects.toThrow(/change_request_expired/)
    await expect(review(row.id, false)).resolves.toBeTruthy()
    expect(await approval(decision)).toBe('rejected')
  })

  it('creates one inverse rollback for an executed change, reviewed on its own', async () => {
    const decision = await ownerReviewMoney('pause', 'ad', AD)
    const original = await ownerCreate(decision, request('pause_ad', 'ad', AD, {}))
    // Not executed yet: no rollback.
    await expect(ownerCreate(decision, request('activate_ad', 'ad', AD, {}, { rollback_of: original.id })))
      .rejects.toThrow(/rollback_original_invalid/)
    await review(original.id, true)
    await db.query(`UPDATE public.change_requests SET status = 'executed', executed_at = now() WHERE id = $1`, [original.id])

    await expect(ownerCreate(decision, request('pause_ad', 'ad', AD, {}, { rollback_of: original.id })))
      .rejects.toThrow(/kind_mismatch/)
    const rollback = await ownerCreate(decision, request('activate_ad', 'ad', AD, {}, { rollback_of: original.id }))
    expect(rollback).toMatchObject({ status: 'pending', initiated_by: 'owner' })
    expect((await ownerCreate(decision, request('activate_ad', 'ad', AD, {}, { rollback_of: original.id }))).id).toBe(rollback.id)
    await review(rollback.id, true)
    expect(await approval(decision)).toBe('approved')
    const { rows } = await db.query<{ status: string }>('SELECT status FROM public.change_requests WHERE id = $1', [rollback.id])
    expect(rows[0].status).toBe('approved')
  })

  it('grants the owner RPC to the service role only', async () => {
    const { rows } = await db.query<{ anon: boolean; authed: boolean; service: boolean }>(`
      SELECT has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
             has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authed,
             has_function_privilege('service_role', p.oid, 'EXECUTE') AS service
        FROM pg_proc p WHERE p.proname = 'create_owner_change_request'`)
    expect(rows).toEqual([{ anon: false, authed: false, service: true }])
  })
})
