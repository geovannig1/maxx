import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import type { SupabaseClient } from '@supabase/supabase-js'
import { freshSchemaDb, insertAdAccount } from './schema-db'
import { pgliteSupabase } from './postgrest-pglite'

// ADR-062: creating an approved plan in Meta, PAUSED, against the SHIPPED schema and a FAKE Meta (no
// network). Happy path, write mode off, partial failure and resume without duplicates (including an
// object Meta created before its id was recorded), verification failure, never ACTIVE, demo, rollback.

const ACCOUNT = '00000000-0000-4000-8000-000000000631'
const OWNER = '00000000-0000-4000-8000-0000000000aa'

interface FakeObject { id: string; edge: string; body: Record<string, string> }
const meta = vi.hoisted(() => ({
  objects: [] as FakeObject[],
  creates: [] as Array<{ edge: string; body: Record<string, string> }>,
  statusCalls: [] as Array<{ id: string; status: string }>,
  failOnCreate: null as null | ((edge: string, n: number) => boolean),
  readOverride: null as null | ((id: string) => Record<string, unknown> | null),
  next: 9000,
}))
const state = vi.hoisted(() => ({ client: null as SupabaseClient | null, demo: false, activeMajor: 10 as number | null }))

vi.mock('@/lib/supabase/admin', () => ({ getAdminClient: () => state.client }))
vi.mock('@/config/demo', () => ({ isDemoMode: () => state.demo }))
vi.mock('@/lib/writes/write-state-backend', async () => {
  const actual = await vi.importActual<typeof import('@/lib/writes/write-state-backend')>('@/lib/writes/write-state-backend')
  return { ...actual, writeStateBackend: () => ({ kind: state.demo ? 'demo' : 'meta', readSnapshot: async () => null, accountDailyBudgetTotal: async () => state.activeMajor }) }
})
vi.mock('@/lib/platforms/registry', async () => {
  const units = { supports: () => true, toMinor: (n: number) => Math.round(n * 100), fromMinor: (n: number) => n / 100 }
  const campaignCreation = {
    isConfigured: () => true,
    create: async (edge: string, body: Record<string, string>) => {
      meta.creates.push({ edge, body })
      if (meta.failOnCreate?.(edge, meta.creates.length)) return { ok: false, error: { code: 'META_REJECTED', message: 'Invalid parameter' } }
      const id = String(meta.next++)
      meta.objects.push({ id, edge, body })
      return { ok: true, id }
    },
    findMarked: async (_edge: string, marker: string) => {
      const hits = meta.objects.filter((o) => o.body.name?.includes(`[${marker}]`))
      return { ok: true, id: hits[0]?.id ?? null }
    },
    read: async (id: string) => {
      if (meta.readOverride) { const r = meta.readOverride(id); if (r !== undefined) return r }
      const o = meta.objects.find((x) => x.id === id)
      return o ? { id, name: o.body.name, status: o.body.status ?? null, daily_budget: o.body.daily_budget ?? null } : null
    },
    setStatus: async (id: string, status: string) => { meta.statusCalls.push({ id, status }); return { ok: true } },
  }
  return { getAdPlatform: () => ({ id: 'meta', label: 'Meta', budgetUnits: units, campaignCreation }), requireCapability: (p: Record<string, unknown>, c: string) => p[c] }
})

const { submitPlanForApproval, proposePlanRollback } = await import('@/lib/campaigns/plan-submission')
const { executeCampaignPlanChange } = await import('@/lib/campaigns/plan-executor')
const { hashSpec } = await import('@/lib/campaigns/plan-repository')
const { campaignPlanSpecSchema, PAID_TOUCH_URL_TAGS } = await import('@/lib/campaigns/plan-spec')
const { businessDateOf } = await import('@/config/business-config')
const { markerSeed, objectMarker } = await import('@/lib/platforms/meta/campaign-payloads')

let db: PGlite

function tomorrow(): string {
  return businessDateOf(new Date(Date.now() + 86_400_000), 'America/New_York')
}

const COPY = [
  { primary_text: 'Book a bright studio by the hour with natural window light.', headline: 'Studio rental by the hour', description: '', cta: 'BOOK_NOW', angle: 'offer' },
  { primary_text: 'Natural window light makes product photos look true to life.', headline: 'Shoot in natural light', description: '', cta: 'BOOK_NOW', angle: 'specific_benefit' },
  { primary_text: 'No space at home for a shoot? Rent our studio for the afternoon.', headline: 'Your shoot, our space', description: '', cta: 'LEARN_MORE', angle: 'problem_solution' },
]

function spec() {
  return campaignPlanSpecSchema.parse({
    currency: 'USD',
    campaign: { name: 'Spring prospecting', objective: 'OUTCOME_SALES', buying_type: 'AUCTION', budget_mode: 'CBO', daily_budget_minor: 3000, bid_strategy: 'LOWEST_COST_WITHOUT_CAP', bid_amount_minor: null },
    schedule: { start_date: tomorrow(), end_date: null },
    conversion: { pixel_id: '111', custom_event: 'Purchase' },
    ad_sets: [{
      key: 'as1', name: 'Broad US', daily_budget_minor: null, optimization_goal: 'OFFSITE_CONVERSIONS',
      audience: { mode: 'advantage_plus', custom_audience_ids: [], excluded_audience_ids: [], countries: ['US'], age_min: 18, age_max: 65 },
      placements: 'advantage_plus',
      ads: COPY.map((copy, i) => ({ key: `ad${i + 1}`, name: `Ad ${i + 1}`, creative: { mode: 'image', image_hash: `hash00${i + 1}` }, copy, destination_url: 'https://studio.example/book', url_tags: PAID_TOUCH_URL_TAGS })),
    }],
  })
}

async function approvedPlan(): Promise<{ changeRequestId: string; versionId: string }> {
  const s = spec()
  const { rows } = await db.query<{ id: string }>('SELECT id FROM public.create_campaign_plan_version(NULL, $1, $2, $3, $4, $5)', [ACCOUNT, OWNER, 'Spring', '{}', JSON.stringify({
    spec: s, spec_hash: hashSpec(s), currency: 'USD', total_daily_budget_minor: 3000, validation: [], readiness: [], notes: [], source: 'template',
  })])
  const submitted = await submitPlanForApproval({ versionId: rows[0].id, ownerUserId: OWNER, confirmBudgetStep: true })
  expect(submitted.http).toBe(201)
  const changeRequestId = String(submitted.body.change_request_id)
  await db.query('SELECT * FROM public.review_change_request_with_decision($1, $2, true)', [changeRequestId, 'owner@example.test'])
  return { changeRequestId, versionId: rows[0].id }
}

const statusOf = async (table: string, id: string) => (await db.query<{ status: string }>(`SELECT status FROM public.${table} WHERE id = $1`, [id])).rows[0].status
const objectRows = async () => (await db.query<{ local_key: string; meta_id: string | null; state: string; simulated: boolean }>('SELECT local_key, meta_id, state, simulated FROM public.campaign_plan_objects ORDER BY created_at, local_key')).rows
const createdKinds = () => meta.creates.map((c) => c.edge.split('/')[1])

beforeEach(async () => {
  Object.assign(meta, { objects: [], creates: [], statusCalls: [], failOnCreate: null, readOverride: null, next: 9000 })
  Object.assign(state, { demo: false, activeMajor: 10 })
  process.env.WRITE_MODE_ENABLED = 'true'
  process.env.PAID_TOUCH_ALLOWED_LANDING_HOSTS = 'studio.example'
  db = await freshSchemaDb()
  await insertAdAccount(db, ACCOUNT, 'act_631')
  await db.query(`UPDATE public.ad_accounts SET pixel_id = '111', facebook_page_id = '555', currency = 'USD' WHERE id = $1`, [ACCOUNT])
  for (const n of [1, 2, 3]) {
    await db.query(`INSERT INTO public.creatives (ad_account_id, creative_id, creative_name, image_hash, last_synced_at) VALUES ($1, $2, $3, $4, now())`, [ACCOUNT, `70${n}`, `Creative ${n}`, `hash00${n}`])
  }
  state.client = pgliteSupabase(db)
})
afterEach(() => { delete process.env.WRITE_MODE_ENABLED; delete process.env.PAID_TOUCH_ALLOWED_LANDING_HOSTS })

describe('campaign plan creation (ADR-062)', () => {
  it('creates campaign, ad set, creatives and ads in order, all PAUSED, verifies them and records the audit', async () => {
    const { changeRequestId, versionId } = await approvedPlan()
    const result = await executeCampaignPlanChange(changeRequestId, 'owner@example.test', ACCOUNT) as Record<string, unknown>
    expect(result.status).toBe('CREATED_PAUSED')
    expect(createdKinds()).toEqual(['campaigns', 'adsets', 'adcreatives', 'ads', 'adcreatives', 'ads', 'adcreatives', 'ads'])
    for (const { body } of meta.creates) {
      if ('status' in body) expect(body.status).toBe('PAUSED')
      expect(JSON.stringify(body)).not.toMatch(/"status"\s*:\s*"ACTIVE"|status=ACTIVE/)
    }
    expect(meta.creates[0].body).toMatchObject({ objective: 'OUTCOME_SALES', daily_budget: '3000', bid_strategy: 'LOWEST_COST_WITHOUT_CAP' })
    expect(JSON.parse(meta.creates[1].body.promoted_object)).toEqual({ pixel_id: '111', custom_event_type: 'PURCHASE' })
    expect(meta.creates[2].body.url_tags).toBe(PAID_TOUCH_URL_TAGS)
    expect(await statusOf('change_requests', changeRequestId)).toBe('executed')
    expect(await statusOf('campaign_plan_versions', versionId)).toBe('created_paused')
    expect((await objectRows()).every((o) => o.state === 'verified' && o.meta_id)).toBe(true)
    const log = await db.query<{ status: string; verified: boolean; action_type: string }>('SELECT status, verified, action_type FROM public.action_log WHERE change_request_id = $1', [changeRequestId])
    expect(log.rows).toEqual([{ status: 'verified', verified: true, action_type: 'create_campaign_paused' }])
    // A second click does nothing.
    expect((await executeCampaignPlanChange(changeRequestId, 'owner@example.test', ACCOUNT) as Record<string, unknown>).status).toBe('ALREADY_EXECUTED')
    expect(meta.creates).toHaveLength(8)
  })

  it('with write mode off creates nothing', async () => {
    const { changeRequestId } = await approvedPlan()
    process.env.WRITE_MODE_ENABLED = 'false'
    expect((await executeCampaignPlanChange(changeRequestId, 'owner@example.test', ACCOUNT) as Record<string, unknown>).status).toBe('WRITE_MODE_DISABLED')
    expect(meta.creates).toHaveLength(0)
  })

  it('records a partial failure with cleanup guidance, then resumes without duplicating anything', async () => {
    const { changeRequestId, versionId } = await approvedPlan()
    meta.failOnCreate = (edge, n) => edge.endsWith('/ads') && n === 6
    const failed = await executeCampaignPlanChange(changeRequestId, 'owner@example.test', ACCOUNT) as Record<string, unknown>
    expect(failed.status).toBe('PARTIAL_FAILURE')
    expect(String(failed.message)).toMatch(/Resume|Roll back/)
    expect(await statusOf('change_requests', changeRequestId)).toBe('failed')
    expect(await statusOf('campaign_plan_versions', versionId)).toBe('failed')
    const before = meta.objects.length
    meta.failOnCreate = null
    const resumed = await executeCampaignPlanChange(changeRequestId, 'owner@example.test', ACCOUNT) as Record<string, unknown>
    expect(resumed.status).toBe('CREATED_PAUSED')
    expect(meta.objects.length - before).toBe(3)
    expect(meta.objects.filter((o) => o.edge.endsWith('/campaigns'))).toHaveLength(1)
    expect(meta.objects.filter((o) => o.edge.endsWith('/ads'))).toHaveLength(3)
    expect(await statusOf('campaign_plan_versions', versionId)).toBe('created_paused')
  })

  it('finds an object Meta created before its id was recorded instead of creating it again', async () => {
    const { changeRequestId, versionId } = await approvedPlan()
    const marker = objectMarker(markerSeed(versionId, changeRequestId), 'campaign')
    await db.query(`INSERT INTO public.campaign_plan_objects (plan_version_id, ad_account_id, change_request_id, object_kind, local_key, marker) VALUES ($1, $2, $3, 'campaign', 'campaign', $4)`, [versionId, ACCOUNT, changeRequestId, marker])
    meta.objects.push({ id: '8888', edge: 'act_631/campaigns', body: { name: `Spring prospecting [${marker}]`, status: 'PAUSED', daily_budget: '3000' } })
    const result = await executeCampaignPlanChange(changeRequestId, 'owner@example.test', ACCOUNT) as Record<string, unknown>
    expect(result.status).toBe('CREATED_PAUSED')
    expect(createdKinds()).not.toContain('campaigns')
    expect((await objectRows()).find((o) => o.local_key === 'campaign')?.meta_id).toBe('8888')
  })

  it('pauses anything that reads back as active and reports the creation unverified', async () => {
    const { changeRequestId } = await approvedPlan()
    meta.readOverride = (id) => {
      const o = meta.objects.find((x) => x.id === id)
      return o?.edge.endsWith('/adsets') ? { id, name: o.body.name, status: 'ACTIVE' } : (undefined as never)
    }
    const result = await executeCampaignPlanChange(changeRequestId, 'owner@example.test', ACCOUNT) as Record<string, unknown>
    expect(result.status).toBe('CREATED_UNVERIFIED')
    expect(meta.statusCalls).toEqual([{ id: meta.objects.find((o) => o.edge.endsWith('/adsets'))!.id, status: 'PAUSED' }])
    const log = await db.query<{ status: string }>('SELECT status FROM public.action_log WHERE change_request_id = $1', [changeRequestId])
    expect(log.rows[0].status).toBe('applied_unverified')
  })

  it('re-validates before any Meta call: a creative that left the account stops the run', async () => {
    const { changeRequestId } = await approvedPlan()
    await db.query(`DELETE FROM public.creatives WHERE creative_id = '702'`)
    const result = await executeCampaignPlanChange(changeRequestId, 'owner@example.test', ACCOUNT) as Record<string, unknown>
    expect(result.status).toBe('REVALIDATION_FAILED')
    expect(meta.creates).toHaveLength(0)
  })

  it('in demo mode simulates the creation with fake ids and contacts no Meta', async () => {
    const { changeRequestId, versionId } = await approvedPlan()
    state.demo = true
    process.env.WRITE_MODE_ENABLED = 'false'
    const result = await executeCampaignPlanChange(changeRequestId, 'owner@example.test', ACCOUNT, { simulate: true }) as Record<string, unknown>
    expect(result.status).toBe('DEMO_SIMULATED')
    expect(String(result.message)).toMatch(/^Demo: simulated/)
    expect(meta.creates).toHaveLength(0)
    expect((await objectRows()).every((o) => o.simulated && o.meta_id?.startsWith('demo-'))).toBe(true)
    expect(await statusOf('campaign_plan_versions', versionId)).toBe('created_paused')
  })

  it('rolls back by archiving the created objects after the owner approves the rollback', async () => {
    const { changeRequestId, versionId } = await approvedPlan()
    await executeCampaignPlanChange(changeRequestId, 'owner@example.test', ACCOUNT)
    const proposed = await proposePlanRollback({ changeRequestId, ownerUserId: OWNER, accountId: ACCOUNT })
    expect(proposed.http).toBe(201)
    const rollbackId = String(proposed.body.change_request_id)
    expect((await executeCampaignPlanChange(rollbackId, 'owner@example.test', ACCOUNT) as Record<string, unknown>).status).toBe('NOT_APPROVED')
    await db.query('SELECT * FROM public.review_change_request_with_decision($1, $2, true)', [rollbackId, 'owner@example.test'])
    const result = await executeCampaignPlanChange(rollbackId, 'owner@example.test', ACCOUNT) as Record<string, unknown>
    expect(result.status).toBe('ARCHIVED')
    expect(meta.statusCalls.every((c) => c.status === 'ARCHIVED')).toBe(true)
    expect(meta.statusCalls).toHaveLength(5)
    expect(await statusOf('campaign_plan_versions', versionId)).toBe('archived')
  })
})
