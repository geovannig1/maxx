import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { freshSchemaDb, insertAdAccount } from './schema-db'
import { insertActionDecision } from './decision-fixture'

// Security review L1: change_requests.status moves only along governed edges, in the database.
// executed, rejected and expired are terminal; failed -> executed is the campaign-plan resume path only,
// and never while a rollback of that creation is pending or approved. ADR-059 flows stay intact.

const ACCOUNT = '00000000-0000-4000-8000-000000000671'
const OWNER = '00000000-0000-4000-8000-0000000000aa'
const AD = '120000000000000671'
let db: PGlite
let seq = 0

const setStatus = (id: string, status: string) => db.query(`UPDATE public.change_requests SET status = $2 WHERE id = $1`, [id, status])
const review = (id: string, approve: boolean) => db.query('SELECT * FROM public.review_change_request_with_decision($1, $2, $3)', [id, 'owner@example.com', approve])

async function ownerPause(): Promise<string> {
  seq += 1
  const decision = await insertActionDecision(db, ACCOUNT, {
    action_kind: 'pause', target_level: 'ad', target_id: `${AD}${seq}`.slice(0, 18), authority_tier: 'owner_review',
    direction_ceiling: 'owner_review', evidence_plane: 'meta_modelled', evidence_basis: 'meta_modelled_association',
    pragmatic_media_buyer: true, source_kind: 'recommendation',
  })
  const { rows } = await db.query<{ id: string }>('SELECT id FROM public.create_owner_change_request($1, $2, $3)', [decision, OWNER, JSON.stringify({
    ad_account_id: ACCOUNT, action_type: 'pause_ad', entity_level: 'ad', meta_entity_id: `${AD}${seq}`.slice(0, 18), params: {},
    before_state: { id: AD }, preview: 'Pause', risk_level: 'medium', rollback_plan: 'activate', idempotency_key: `guard-671-${seq}`, requested_by: 'owner',
  })])
  return rows[0].id
}

async function planCreation(): Promise<{ versionId: string; id: string }> {
  seq += 1
  const { rows: v } = await db.query<{ id: string }>('SELECT id FROM public.create_campaign_plan_version(NULL, $1, $2, $3, $4, $5)', [ACCOUNT, OWNER, 'Plan', '{}', JSON.stringify({
    spec: { campaign: { name: 'x' } }, spec_hash: 'b'.repeat(64), currency: 'USD', total_daily_budget_minor: 3000, validation: [], readiness: [], notes: [], source: 'template',
  })])
  const { rows } = await db.query<{ id: string }>('SELECT id FROM public.create_campaign_plan_change_request($1, $2, $3)', [v[0].id, OWNER, JSON.stringify({
    ad_account_id: ACCOUNT, action_type: 'create_campaign_paused', preview: 'Create', risk_level: 'high', rollback_plan: 'Archive', idempotency_key: `guard-plan-671-${seq}`, requested_by: 'owner',
  })])
  await review(rows[0].id, true)
  return { versionId: v[0].id, id: rows[0].id }
}

beforeAll(async () => {
  db = await freshSchemaDb()
  await insertAdAccount(db, ACCOUNT, 'act_671')
}, 120_000)
afterAll(async () => db.close())

describe('change request status transitions (security review L1)', () => {
  it('keeps the ADR-059 path: pending -> approved -> executed, and approved -> failed', async () => {
    const a = await ownerPause()
    await review(a, true)
    await expect(setStatus(a, 'executed')).resolves.toBeDefined()
    const b = await ownerPause()
    await review(b, true)
    await expect(setStatus(b, 'failed')).resolves.toBeDefined()
  })

  it('makes executed terminal: never back to failed, approved or pending', async () => {
    const a = await ownerPause()
    await review(a, true)
    await setStatus(a, 'executed')
    for (const next of ['failed', 'approved', 'pending']) {
      await expect(setStatus(a, next)).rejects.toThrow(/change_request_illegal_status_transition/)
    }
  })

  it('never lets an ADR-059 failure run again, nor a pending request skip approval', async () => {
    const a = await ownerPause()
    await expect(setStatus(a, 'executed')).rejects.toThrow(/change_request_illegal_status_transition/)
    await review(a, true)
    await setStatus(a, 'failed')
    await expect(setStatus(a, 'executed')).rejects.toThrow(/change_request_illegal_status_transition/)
  })

  it('lets a failed campaign-plan creation resume (failed -> executed), but not while its rollback is pending', async () => {
    const plan = await planCreation()
    await setStatus(plan.id, 'failed')
    const { rows } = await db.query<{ id: string }>('SELECT id FROM public.create_campaign_plan_change_request($1, $2, $3)', [plan.versionId, OWNER, JSON.stringify({
      ad_account_id: ACCOUNT, action_type: 'archive_campaign_plan_objects', rollback_of: plan.id, meta_ids: ['1200001'], preview: 'Archive',
      risk_level: 'medium', rollback_plan: 'none', idempotency_key: `guard-rb-671-${seq}`, requested_by: 'owner',
    })])
    await expect(setStatus(plan.id, 'executed')).rejects.toThrow(/change_request_resume_blocked_by_pending_rollback/)
    await review(rows[0].id, false)
    await expect(setStatus(plan.id, 'executed')).resolves.toBeDefined()
  })
})
