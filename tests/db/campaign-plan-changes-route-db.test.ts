import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import type { SupabaseClient } from '@supabase/supabase-js'
import { freshSchemaDb, insertAdAccount } from './schema-db'
import { pgliteSupabase } from './postgrest-pglite'

// ADR-062 through the REAL routes and the shipped schema: submit a plan, then the same /changes
// Approve & apply flow as every other change. Writes off records the approval only; writes on creates
// PAUSED objects through the (fake) Meta; the demo simulates; rollback proposes an archive.

const ACCOUNT = '00000000-0000-4000-8000-000000000641'
const OWNER_ID = '00000000-0000-4000-8000-0000000000bb'
const state = vi.hoisted(() => ({ client: null as SupabaseClient | null, demo: false, creates: 0 }))

vi.mock('@/lib/supabase/admin', () => ({ getAdminClient: () => state.client }))
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: '00000000-0000-4000-8000-0000000000bb', email: 'owner@example.test', email_confirmed_at: '2026-01-01T00:00:00Z' } } }) } }),
}))
vi.mock('@/lib/security/api-rate-limit', () => ({ enforceApiRateLimit: async () => null }))
vi.mock('@/config/demo', () => ({ isDemoMode: () => state.demo }))
vi.mock('@/lib/writes/write-state-backend', async () => ({
  ...(await vi.importActual<typeof import('@/lib/writes/write-state-backend')>('@/lib/writes/write-state-backend')),
  writeStateBackend: () => ({ kind: 'meta', readSnapshot: async () => null, accountDailyBudgetTotal: async () => 50 }),
}))
vi.mock('@/lib/platforms/registry', () => {
  const objects = new Map<string, Record<string, string>>()
  let next = 5000
  return {
    getAdPlatform: () => ({
      id: 'meta', label: 'Meta', budgetUnits: { supports: () => true, toMinor: (n: number) => Math.round(n * 100), fromMinor: (n: number) => n / 100 },
      campaignCreation: {
        isConfigured: () => true,
        create: async (_edge: string, body: Record<string, string>) => { state.creates += 1; const id = String(next++); objects.set(id, body); return { ok: true, id } },
        findMarked: async () => ({ ok: true, id: null }),
        read: async (id: string) => ({ id, ...objects.get(id) }),
        setStatus: async () => ({ ok: true }),
      },
    }),
  }
})

const { POST: submitRoute } = await import('@/app/api/campaigns/plans/[planId]/submit/route')
const { PATCH: reviewRoute } = await import('@/app/api/changes/[id]/route')
const { POST: rollbackRoute } = await import('@/app/api/changes/[id]/rollback/route')
const { hashSpec } = await import('@/lib/campaigns/plan-repository')
const { campaignPlanSpecSchema, PAID_TOUCH_URL_TAGS } = await import('@/lib/campaigns/plan-spec')
const { businessDateOf } = await import('@/config/business-config')

let db: PGlite
const json = (body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

async function draftVersion(): Promise<{ planId: string; versionId: string }> {
  const spec = campaignPlanSpecSchema.parse({
    currency: 'USD',
    campaign: { name: 'Route plan', objective: 'OUTCOME_TRAFFIC', buying_type: 'AUCTION', budget_mode: 'CBO', daily_budget_minor: 2000, bid_strategy: 'LOWEST_COST_WITHOUT_CAP', bid_amount_minor: null },
    schedule: { start_date: businessDateOf(new Date(Date.now() + 86_400_000), 'America/New_York'), end_date: null },
    conversion: null,
    ad_sets: [{
      key: 'as1', name: 'Broad', daily_budget_minor: null, optimization_goal: 'LANDING_PAGE_VIEWS', placements: 'advantage_plus',
      audience: { mode: 'advantage_plus', custom_audience_ids: [], excluded_audience_ids: [], countries: ['US'], age_min: 18, age_max: 65 },
      ads: [{ key: 'ad1', name: 'Reuse', creative: { mode: 'existing_creative', creative_id: '701' }, copy: null, destination_url: null, url_tags: PAID_TOUCH_URL_TAGS }],
    }],
  })
  const { rows } = await db.query<{ id: string; plan_id: string }>('SELECT id, plan_id FROM public.create_campaign_plan_version(NULL, $1, $2, $3, $4, $5)', [ACCOUNT, OWNER_ID, 'Route plan', '{}', JSON.stringify({
    spec, spec_hash: hashSpec(spec), currency: 'USD', total_daily_budget_minor: 2000, validation: [], readiness: [], notes: [], source: 'template',
  })])
  return { planId: rows[0].plan_id, versionId: rows[0].id }
}

async function submitted(): Promise<string> {
  const { planId, versionId } = await draftVersion()
  const res = await submitRoute(new Request('http://localhost/x', json({ version_id: versionId })) as never, { params: Promise.resolve({ planId }) })
  const body = await res.json() as { change_request_id: string; preview: string }
  expect(res.status).toBe(201)
  expect(body.preview).toMatch(/every one PAUSED/)
  return body.change_request_id
}

const review = (id: string, action: string) => reviewRoute(new Request(`http://localhost/api/changes/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action }) }) as never, { params: Promise.resolve({ id }) })

beforeEach(async () => {
  process.env.OWNER_EMAIL = 'owner@example.test'
  process.env.WRITE_MODE_ENABLED = 'false'
  Object.assign(state, { demo: false, creates: 0 })
  db = await freshSchemaDb()
  await insertAdAccount(db, ACCOUNT, 'act_641')
  await db.query(`INSERT INTO public.creatives (ad_account_id, creative_id, creative_name, link_url, last_synced_at) VALUES ($1, '701', 'Existing', 'https://studio.example/', now())`, [ACCOUNT])
  state.client = pgliteSupabase(db)
})
afterEach(() => { delete process.env.OWNER_EMAIL; delete process.env.WRITE_MODE_ENABLED })

describe('a campaign plan on /changes (ADR-062)', () => {
  it('with writes off, Approve & apply records the approval and creates nothing', async () => {
    const id = await submitted()
    const res = await review(id, 'approve_and_apply')
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ status: 'approved', write_mode: 'off' })
    expect(state.creates).toBe(0)
  })

  it('with writes on, Approve & apply creates the objects PAUSED; a second click changes nothing', async () => {
    process.env.WRITE_MODE_ENABLED = 'true'
    const id = await submitted()
    const res = await review(id, 'approve_and_apply')
    expect(await res.json()).toMatchObject({ status: 'CREATED_PAUSED' })
    expect(res.status).toBe(200)
    expect(state.creates).toBe(3)
    expect(await (await review(id, 'approve_and_apply')).json()).toMatchObject({ status: 'ALREADY_EXECUTED' })
    expect(state.creates).toBe(3)
    const rollback = await rollbackRoute(new Request(`http://localhost/api/changes/${id}/rollback`, { method: 'POST' }) as never, { params: Promise.resolve({ id }) })
    expect(rollback.status).toBe(201)
    expect(await rollback.json()).toMatchObject({ status: 'PENDING_APPROVAL', preview: expect.stringMatching(/archive 3 paused object/) })
  })

  it('in the demo, Approve & apply runs the simulated creation', async () => {
    state.demo = true
    const id = await submitted()
    const res = await review(id, 'approve_and_apply')
    expect(await res.json()).toMatchObject({ status: 'DEMO_SIMULATED', message: expect.stringMatching(/^Demo: simulated/) })
    expect(state.creates).toBe(0)
  })

  it('rejecting the request rejects the plan version', async () => {
    const id = await submitted()
    expect((await review(id, 'reject')).status).toBe(200)
    const { rows } = await db.query<{ status: string }>('SELECT v.status FROM public.campaign_plan_versions v JOIN public.change_requests c ON c.campaign_plan_version_id = v.id WHERE c.id = $1', [id])
    expect(rows[0].status).toBe('rejected')
  })
})
