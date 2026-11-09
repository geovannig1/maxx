import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import type { SupabaseClient } from '@supabase/supabase-js'
import { freshSchemaDb, insertAdAccount } from './schema-db'
import { pgliteSupabase } from './postgrest-pglite'
import { approvedPlan, emptyMeta, planSpec, seedPlanAccount, type FakeMeta } from './campaign-plan-harness'

// Security review H1 (ADR-062): a resumed creation must never adopt, pause or archive an object another
// plan created. The reviewer's scenario: two plans with an IDENTICAL spec; the second one's first create
// fails once, then resumes. Its marker lookup must not find the first plan's (now live) campaign.

const ACCOUNT = '00000000-0000-4000-8000-000000000641'
const OWNER = '00000000-0000-4000-8000-0000000000aa'

const meta = vi.hoisted(() => ({ current: null as unknown as FakeMeta }))
const state = vi.hoisted(() => ({ client: null as SupabaseClient | null }))

vi.mock('@/lib/supabase/admin', () => ({ getAdminClient: () => state.client }))
vi.mock('@/config/demo', () => ({ isDemoMode: () => false }))
vi.mock('@/lib/writes/write-state-backend', async () => {
  const actual = await vi.importActual<typeof import('@/lib/writes/write-state-backend')>('@/lib/writes/write-state-backend')
  return { ...actual, writeStateBackend: () => ({ kind: 'meta', readSnapshot: async () => null, accountDailyBudgetTotal: async () => 10 }) }
})
vi.mock('@/lib/platforms/registry', async () => {
  const { fakeRegistry } = await import('./campaign-plan-harness')
  const proxy = new Proxy({} as FakeMeta, { get: (_t, key) => (meta.current as unknown as Record<PropertyKey, unknown>)[key], set: (_t, key, value) => { (meta.current as unknown as Record<PropertyKey, unknown>)[key] = value; return true } })
  return fakeRegistry(proxy)
})

const { submitPlanForApproval, proposePlanRollback } = await import('@/lib/campaigns/plan-submission')
const { executeCampaignPlanChange } = await import('@/lib/campaigns/plan-executor')
const { hashSpec } = await import('@/lib/campaigns/plan-repository')
const { businessDateOf } = await import('@/config/business-config')

let db: PGlite
const tomorrow = () => businessDateOf(new Date(Date.now() + 86_400_000), 'America/New_York')
const plan = () => approvedPlan(db, { submit: submitPlanForApproval, hashSpec, spec: planSpec(tomorrow()), account: ACCOUNT, owner: OWNER })
const execute = async (id: string) => executeCampaignPlanChange(id, 'owner@example.test', ACCOUNT) as Promise<Record<string, unknown>>
const rowsOf = async (cr: string) => (await db.query<{ local_key: string; meta_id: string | null }>('SELECT local_key, meta_id FROM public.campaign_plan_objects WHERE change_request_id = $1', [cr])).rows
const campaignOf = async (cr: string) => (await rowsOf(cr)).find((r) => r.local_key === 'campaign')?.meta_id ?? null

/** Plan A fully created; then the owner turns its campaign on in Ads Manager. */
async function liveFirstPlan(): Promise<{ changeRequestId: string; campaignId: string }> {
  const a = await plan()
  expect((await execute(a.changeRequestId)).status).toBe('CREATED_PAUSED')
  const campaignId = (await campaignOf(a.changeRequestId)) as string
  meta.current.objects.find((o) => o.id === campaignId)!.body.status = 'ACTIVE'
  meta.current.statusCalls = []
  return { changeRequestId: a.changeRequestId, campaignId }
}

beforeEach(async () => {
  meta.current = emptyMeta()
  process.env.WRITE_MODE_ENABLED = 'true'
  process.env.PAID_TOUCH_ALLOWED_LANDING_HOSTS = 'studio.example'
  db = await freshSchemaDb()
  await insertAdAccount(db, ACCOUNT, 'act_641')
  await seedPlanAccount(db, ACCOUNT)
  state.client = pgliteSupabase(db)
})
afterEach(() => { delete process.env.WRITE_MODE_ENABLED; delete process.env.PAID_TOUCH_ALLOWED_LANDING_HOSTS })

describe('a resumed creation never touches another plan\'s objects (security review H1)', () => {
  it('identical spec, first create fails once, resume: creates its own campaign, never pauses or archives plan A\'s', async () => {
    const a = await liveFirstPlan()
    const b = await plan()
    let failedOnce = false
    meta.current.failOnCreate = (edge) => { if (edge.endsWith('/campaigns') && !failedOnce) { failedOnce = true; return true } return false }
    expect((await execute(b.changeRequestId)).status).toBe('PARTIAL_FAILURE')
    meta.current.failOnCreate = null

    const resumed = await execute(b.changeRequestId)
    expect(resumed.status).toBe('CREATED_PAUSED')
    const bCampaign = await campaignOf(b.changeRequestId)
    expect(bCampaign).not.toBeNull()
    expect(bCampaign).not.toBe(a.campaignId)
    expect(meta.current.statusCalls.filter((c) => c.id === a.campaignId)).toEqual([])
    expect(meta.current.objects.find((o) => o.id === a.campaignId)?.body.status).toBe('ACTIVE')

    const rollback = await proposePlanRollback({ changeRequestId: b.changeRequestId, ownerUserId: OWNER, accountId: ACCOUNT })
    expect(rollback.http).toBe(201)
    expect(String(rollback.body.preview)).not.toContain(a.campaignId)
    await db.query('SELECT * FROM public.review_change_request_with_decision($1, $2, true)', [String(rollback.body.change_request_id), 'owner@example.test'])
    expect((await execute(String(rollback.body.change_request_id))).status).toBe('ARCHIVED')
    expect(meta.current.statusCalls.filter((c) => c.id === a.campaignId)).toEqual([])
    expect(await campaignOf(a.changeRequestId)).toBe(a.campaignId)
  })

  it('a marker lookup that answers with another plan\'s object stops the run: nothing recorded, nothing paused', async () => {
    const a = await liveFirstPlan()
    const b = await plan()
    meta.current.failOnCreate = (edge) => edge.endsWith('/campaigns')
    expect((await execute(b.changeRequestId)).status).toBe('PARTIAL_FAILURE')
    meta.current.failOnCreate = null
    meta.current.findOverride = (edge) => ({ ok: true, id: edge.endsWith('/campaigns') ? a.campaignId : null })

    const resumed = await execute(b.changeRequestId)
    expect(resumed.status).toBe('PARTIAL_FAILURE')
    expect((resumed.error as { code?: string }).code).toBe('FOUND_OBJECT_INTEGRITY')
    expect(await campaignOf(b.changeRequestId)).toBeNull()
    expect(meta.current.statusCalls).toEqual([])
    expect(meta.current.objects.find((o) => o.id === a.campaignId)?.body.status).toBe('ACTIVE')
  })

  it('an object found by this request\'s own marker that is not PAUSED is an integrity failure, never paused by Maxx', async () => {
    const b = await plan()
    meta.current.failOnCreate = (edge) => edge.endsWith('/adsets')
    expect((await execute(b.changeRequestId)).status).toBe('PARTIAL_FAILURE')
    // Meta did create the ad set before the error reached Maxx, and someone turned it on since.
    const marker = meta.current.creates.find((c) => c.edge.endsWith('/adsets'))!.body.name.match(/\[([a-z0-9-]+)\]$/)![1]
    meta.current.objects.push({ id: '7777', edge: 'x/adsets', body: { name: `Broad US [${marker}]`, status: 'ACTIVE' } })
    meta.current.failOnCreate = null
    meta.current.statusCalls = []

    const resumed = await execute(b.changeRequestId)
    expect(resumed.status).toBe('PARTIAL_FAILURE')
    expect((resumed.error as { code?: string }).code).toBe('FOUND_OBJECT_INTEGRITY')
    expect(meta.current.statusCalls).toEqual([])
    expect((await rowsOf(b.changeRequestId)).find((r) => r.local_key === 'adset:as1')?.meta_id).toBeNull()
  })

  it('markers are unique per creation request even for an identical spec', async () => {
    const a = await plan()
    const b = await plan()
    await execute(a.changeRequestId)
    await execute(b.changeRequestId)
    const markers = await db.query<{ change_request_id: string; marker: string }>(`SELECT change_request_id, marker FROM public.campaign_plan_objects WHERE local_key = 'campaign'`)
    expect(markers.rows).toHaveLength(2)
    expect(markers.rows[0].marker).not.toBe(markers.rows[1].marker)
  })

  it('the database refuses a second row holding the same Meta id in an account', async () => {
    const a = await liveFirstPlan()
    const b = await plan()
    // B's row is well formed (its own request-bound marker): only the duplicate Meta id is wrong.
    await expect(db.query(`INSERT INTO public.campaign_plan_objects (plan_version_id, ad_account_id, change_request_id, object_kind, local_key, marker, meta_id)
      SELECT campaign_plan_version_id, ad_account_id, id, 'campaign', 'campaign',
             'mx' || left(encode(sha256(convert_to(campaign_plan_version_id::text || ':' || id::text, 'UTF8')), 'hex'), 12) || '-campaign', $2
        FROM public.change_requests WHERE id = $1`,
    [b.changeRequestId, a.campaignId])).rejects.toThrow(/uq_campaign_plan_objects_meta_id|duplicate key/)
  })
})
