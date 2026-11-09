import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import type { SupabaseClient } from '@supabase/supabase-js'
import { freshSchemaDb, insertAdAccount } from './schema-db'
import { pgliteSupabase } from './postgrest-pglite'
import { insertActionDecision } from './decision-fixture'
import { approvedPlan, emptyMeta, planSpec, seedPlanAccount, type FakeMeta } from './campaign-plan-harness'

// Security review M1: a run that crashed leaves its action_log row 'executing', and the one-executing-
// row-per-account index then blocks every write on the account. The owner recovers it from /changes once
// it is older than the stale threshold: an ADR-059 change records Meta's live state first, a plan's
// version goes to failed (resume is safe), the row becomes 'unknown', and the next write proceeds.

const ACCOUNT = '00000000-0000-4000-8000-000000000691'
const OWNER = '00000000-0000-4000-8000-0000000000aa'
const AD = '120000000000000691'

const meta = vi.hoisted(() => ({ current: null as unknown as FakeMeta }))
const state = vi.hoisted(() => ({ client: null as SupabaseClient | null, live: null as Record<string, unknown> | null }))

vi.mock('@/lib/supabase/admin', () => ({ getAdminClient: () => state.client }))
vi.mock('@/config/demo', () => ({ isDemoMode: () => false }))
vi.mock('@/lib/monitoring/alerts', () => ({ emitAlert: vi.fn() }))
vi.mock('@/lib/writes/write-state-backend', async () => {
  const actual = await vi.importActual<typeof import('@/lib/writes/write-state-backend')>('@/lib/writes/write-state-backend')
  return { ...actual, writeStateBackend: () => ({ kind: 'meta', readSnapshot: async () => state.live, accountDailyBudgetTotal: async () => 10 }) }
})
vi.mock('@/lib/platforms/registry', async () => {
  const { fakeRegistry } = await import('./campaign-plan-harness')
  const proxy = new Proxy({} as FakeMeta, { get: (_t, key) => (meta.current as unknown as Record<PropertyKey, unknown>)[key], set: (_t, key, value) => { (meta.current as unknown as Record<PropertyKey, unknown>)[key] = value; return true } })
  return fakeRegistry(proxy)
})

const { submitPlanForApproval } = await import('@/lib/campaigns/plan-submission')
const { executeCampaignPlanChange } = await import('@/lib/campaigns/plan-executor')
const { hashSpec } = await import('@/lib/campaigns/plan-repository')
const { reviewChangeRequest } = await import('@/lib/writes/change-review')
const { listPendingChanges } = await import('@/lib/writes/owner-change-reads')
const { businessDateOf } = await import('@/config/business-config')

let db: PGlite
const tomorrow = () => businessDateOf(new Date(Date.now() + 86_400_000), 'America/New_York')
const plan = () => approvedPlan(db, { submit: submitPlanForApproval, hashSpec, spec: planSpec(tomorrow()), account: ACCOUNT, owner: OWNER })
const execute = async (id: string) => executeCampaignPlanChange(id, 'owner@example.test', ACCOUNT) as Promise<Record<string, unknown>>
const recover = (id: string) => reviewChangeRequest({ id, action: 'recover', actor: 'owner@example.test', accountId: ACCOUNT })
const one = async <T>(sql: string, params: unknown[]) => (await db.query<T>(sql, params)).rows[0]

/** The state a crash leaves: the run's claim still 'executing', `minutesAgo` old. */
async function crashedRun(changeRequestId: string, actionType: string, minutesAgo: number): Promise<void> {
  await db.query(`INSERT INTO public.action_log (ad_account_id, action_type, entity_level, meta_entity_id, actor, idempotency_key, status, verified, change_request_id, created_at)
    VALUES ($1, $2, 'account', 'act_691', 'owner@example.test', $3, 'executing', false, $4, now() - make_interval(mins => $5))`,
  [ACCOUNT, actionType, `crash-${changeRequestId}`, changeRequestId, minutesAgo])
}

async function approvedOwnerPause(): Promise<string> {
  const decision = await insertActionDecision(db, ACCOUNT, {
    action_kind: 'pause', target_level: 'ad', target_id: AD, authority_tier: 'owner_review', direction_ceiling: 'owner_review',
    evidence_plane: 'meta_modelled', evidence_basis: 'meta_modelled_association', pragmatic_media_buyer: true, source_kind: 'recommendation',
  })
  const { rows } = await db.query<{ id: string }>('SELECT id FROM public.create_owner_change_request($1, $2, $3)', [decision, OWNER, JSON.stringify({
    ad_account_id: ACCOUNT, action_type: 'pause_ad', entity_level: 'ad', meta_entity_id: AD, params: {},
    before_state: { id: AD, status: 'ACTIVE' }, preview: 'Pause', risk_level: 'medium', rollback_plan: 'activate', idempotency_key: 'pause-691', requested_by: 'owner',
  })])
  await db.query('SELECT * FROM public.review_change_request_with_decision($1, $2, true)', [rows[0].id, 'owner@example.test'])
  return rows[0].id
}

beforeEach(async () => {
  meta.current = emptyMeta()
  state.live = null
  process.env.WRITE_MODE_ENABLED = 'true'
  process.env.PAID_TOUCH_ALLOWED_LANDING_HOSTS = 'studio.example'
  delete process.env.CHANGE_RECOVERY_STALE_MINUTES
  db = await freshSchemaDb()
  await insertAdAccount(db, ACCOUNT, 'act_691')
  await seedPlanAccount(db, ACCOUNT)
  state.client = pgliteSupabase(db)
})
afterEach(() => { delete process.env.WRITE_MODE_ENABLED; delete process.env.PAID_TOUCH_ALLOWED_LANDING_HOSTS; delete process.env.CHANGE_RECOVERY_STALE_MINUTES })

describe('recovering a stuck change (security review M1)', () => {
  it('a crashed plan run blocks the account; recovery releases it, the next write proceeds and the plan resumes', async () => {
    const crashed = await plan()
    await db.query(`UPDATE public.campaign_plan_versions SET status = 'creating' WHERE id = $1`, [crashed.versionId])
    await crashedRun(crashed.changeRequestId, 'create_campaign_paused', 20)
    const other = await plan()

    const blocked = await execute(other.changeRequestId)
    expect(blocked).toMatchObject({ status: 'ACCOUNT_WRITE_IN_PROGRESS', stuck_change_request_id: crashed.changeRequestId, recoverable: true })
    const listed = await listPendingChanges(ACCOUNT)
    expect(listed.ok && listed.rows.find((r) => r.id === crashed.changeRequestId)?.stuck_since).toBeTruthy()

    const recovered = await recover(crashed.changeRequestId)
    expect(recovered.http).toBe(200)
    expect(recovered.body).toMatchObject({ status: 'RECOVERED', outcome: 'unknown' })
    const log = await one<{ status: string; result: Record<string, unknown> }>('SELECT status, result FROM public.action_log WHERE change_request_id = $1', [crashed.changeRequestId])
    expect(log.status).toBe('unknown')
    expect(log.result).toMatchObject({ status: 'RECOVERED_UNKNOWN', recovered_by: 'owner@example.test' })
    expect((await one<{ status: string }>('SELECT status FROM public.campaign_plan_versions WHERE id = $1', [crashed.versionId])).status).toBe('failed')
    expect((await one<{ status: string }>('SELECT status FROM public.change_requests WHERE id = $1', [crashed.changeRequestId])).status).toBe('failed')

    expect((await execute(other.changeRequestId)).status).toBe('CREATED_PAUSED')
    expect((await execute(crashed.changeRequestId)).status).toBe('CREATED_PAUSED')
  })

  it('an ADR-059 change records Meta\'s live state before the lock is released', async () => {
    const id = await approvedOwnerPause()
    await crashedRun(id, 'pause_ad', 30)
    state.live = { id: AD, status: 'PAUSED', snapshot_contract_version: 1 }
    const recovered = await recover(id)
    expect(recovered.body).toMatchObject({ status: 'RECOVERED', live_state: { status: 'PAUSED' } })
    const log = await one<{ status: string; after_state: Record<string, unknown> }>('SELECT status, after_state FROM public.action_log WHERE change_request_id = $1', [id])
    expect(log).toMatchObject({ status: 'unknown', after_state: { status: 'PAUSED' } })
    const cr = await one<{ status: string; result: Record<string, unknown> }>('SELECT status, result FROM public.change_requests WHERE id = $1', [id])
    expect(cr.status).toBe('failed')
    expect(cr.result).toMatchObject({ status: 'RECOVERED_UNKNOWN', live_state_read: true })
  })

  it('refuses while the run is younger than the threshold, which is configurable', async () => {
    const crashed = await plan()
    await crashedRun(crashed.changeRequestId, 'create_campaign_paused', 10)
    const early = await recover(crashed.changeRequestId)
    expect(early.http).toBe(409)
    expect(early.body.status).toBe('NOT_STALE')
    expect((await one<{ status: string }>('SELECT status FROM public.action_log WHERE change_request_id = $1', [crashed.changeRequestId])).status).toBe('executing')
    process.env.CHANGE_RECOVERY_STALE_MINUTES = '5'
    expect((await recover(crashed.changeRequestId)).body.status).toBe('RECOVERED')
  })

  it('refuses when nothing is running for the change (control)', async () => {
    const { changeRequestId } = await plan()
    const result = await recover(changeRequestId)
    expect(result.http).toBe(409)
    expect(result.body.status).toBe('NOT_STUCK')
  })
})
