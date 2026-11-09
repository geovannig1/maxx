import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import type { SupabaseClient } from '@supabase/supabase-js'
import { freshSchemaDb, insertAdAccount } from './schema-db'
import { pgliteSupabase } from './postgrest-pglite'
import { approvedPlan, emptyMeta, planSpec, seedPlanAccount, type FakeMeta } from './campaign-plan-harness'

// Security review guards on campaign plans (ADR-062), against the SHIPPED schema and a FAKE Meta:
// M2 the configured-vs-account currency guard, at submission and again at execution; L2 the pixel and
// the video thumbnail a plan sends to Meta must be the account's own; L4 no resume while a rollback of the
// same creation is pending or approved.

const ACCOUNT = '00000000-0000-4000-8000-000000000651'
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
const { campaignPlanSpecSchema } = await import('@/lib/campaigns/plan-spec')
const { businessDateOf } = await import('@/config/business-config')

let db: PGlite
const tomorrow = () => businessDateOf(new Date(Date.now() + 86_400_000), 'America/New_York')
const execute = async (id: string) => executeCampaignPlanChange(id, 'owner@example.test', ACCOUNT) as Promise<Record<string, unknown>>

async function draft(spec = planSpec(tomorrow())): Promise<string> {
  const { rows } = await db.query<{ id: string }>('SELECT id FROM public.create_campaign_plan_version(NULL, $1, $2, $3, $4, $5)', [ACCOUNT, OWNER, 'Spring', '{}', JSON.stringify({
    spec, spec_hash: hashSpec(spec), currency: spec.currency, total_daily_budget_minor: 3000, validation: [], readiness: [], notes: [], source: 'template',
  })])
  return rows[0].id
}
const blockerCodes = (body: Record<string, unknown>) => ((body.validation ?? []) as Array<{ code: string; severity: string }>).filter((i) => i.severity === 'blocker').map((i) => i.code)

beforeEach(async () => {
  meta.current = emptyMeta()
  process.env.WRITE_MODE_ENABLED = 'true'
  process.env.PAID_TOUCH_ALLOWED_LANDING_HOSTS = 'studio.example'
  delete process.env.NEXT_PUBLIC_ACCOUNT_CURRENCY
  db = await freshSchemaDb()
  await insertAdAccount(db, ACCOUNT, 'act_651')
  await seedPlanAccount(db, ACCOUNT)
  state.client = pgliteSupabase(db)
})
afterEach(() => {
  delete process.env.WRITE_MODE_ENABLED; delete process.env.PAID_TOUCH_ALLOWED_LANDING_HOSTS; delete process.env.NEXT_PUBLIC_ACCOUNT_CURRENCY
})

describe('configured-vs-account currency (security review M2)', () => {
  it('blocks submission when the account is EUR but Maxx is configured for USD', async () => {
    await db.query(`UPDATE public.ad_accounts SET currency = 'EUR' WHERE id = $1`, [ACCOUNT])
    const spec = campaignPlanSpecSchema.parse({ ...planSpec(tomorrow()), currency: 'EUR' })
    const result = await submitPlanForApproval({ versionId: await draft(spec), ownerUserId: OWNER, confirmBudgetStep: true })
    expect(result.http).toBe(422)
    expect(blockerCodes(result.body)).toContain('currency_config_mismatch')
  })

  it('blocks submission when Maxx is configured for EUR but the account is USD', async () => {
    process.env.NEXT_PUBLIC_ACCOUNT_CURRENCY = 'EUR'
    const result = await submitPlanForApproval({ versionId: await draft(), ownerUserId: OWNER, confirmBudgetStep: true })
    expect(result.http).toBe(422)
    expect(blockerCodes(result.body)).toContain('currency_config_mismatch')
  })

  it('re-runs at execution: a configuration that drifted after approval creates nothing', async () => {
    const { changeRequestId } = await approvedPlan(db, { submit: submitPlanForApproval, hashSpec, spec: planSpec(tomorrow()), account: ACCOUNT, owner: OWNER })
    process.env.NEXT_PUBLIC_ACCOUNT_CURRENCY = 'EUR'
    const result = await execute(changeRequestId)
    expect(result.status).toBe('REVALIDATION_FAILED')
    expect((result.validation as Array<{ code: string }>).map((i) => i.code)).toContain('currency_config_mismatch')
    expect(meta.current.creates).toHaveLength(0)
  })

  it('a matching configuration passes (control)', async () => {
    const result = await submitPlanForApproval({ versionId: await draft(), ownerUserId: OWNER, confirmBudgetStep: true })
    expect(result.http).toBe(201)
  })
})

describe('pixel and thumbnail are the account\'s own (security review L2)', () => {
  it('blocks a conversion pixel that is not the account pixel', async () => {
    const spec = campaignPlanSpecSchema.parse({ ...planSpec(tomorrow()), conversion: { pixel_id: '999', custom_event: 'Purchase' } })
    const result = await submitPlanForApproval({ versionId: await draft(spec), ownerUserId: OWNER, confirmBudgetStep: true })
    expect(result.http).toBe(422)
    expect(blockerCodes(result.body)).toContain('pixel_not_account_pixel')
  })

  it('blocks a video thumbnail that is not a synced creative thumbnail', async () => {
    await db.query(`INSERT INTO public.creatives (ad_account_id, creative_id, creative_name, video_id, thumbnail_url, last_synced_at) VALUES ($1, '704', 'Video', '8801', 'https://cdn.example/v.jpg', now())`, [ACCOUNT])
    const base = planSpec(tomorrow())
    const withVideo = (thumbnail: string) => campaignPlanSpecSchema.parse({ ...base, ad_sets: [{ ...base.ad_sets[0], ads: base.ad_sets[0].ads.map((ad, i) => (i === 0 ? { ...ad, creative: { mode: 'video', video_id: '8801', thumbnail_url: thumbnail } } : ad)) }] })
    const bad = await submitPlanForApproval({ versionId: await draft(withVideo('https://tracker.example/t.gif')), ownerUserId: OWNER, confirmBudgetStep: true })
    expect(bad.http).toBe(422)
    expect(blockerCodes(bad.body)).toContain('thumbnail_unknown')
    const good = await submitPlanForApproval({ versionId: await draft(withVideo('https://cdn.example/v.jpg')), ownerUserId: OWNER, confirmBudgetStep: true })
    expect(good.http).toBe(201)
  })
})

describe('no resume while a rollback is pending or approved (security review L4)', () => {
  async function failedCreationWithRollback(): Promise<{ changeRequestId: string; rollbackId: string }> {
    const { changeRequestId } = await approvedPlan(db, { submit: submitPlanForApproval, hashSpec, spec: planSpec(tomorrow()), account: ACCOUNT, owner: OWNER })
    meta.current.failOnCreate = (edge) => edge.endsWith('/ads')
    expect((await execute(changeRequestId)).status).toBe('PARTIAL_FAILURE')
    meta.current.failOnCreate = null
    const rollback = await proposePlanRollback({ changeRequestId, ownerUserId: OWNER, accountId: ACCOUNT })
    expect(rollback.http).toBe(201)
    return { changeRequestId, rollbackId: String(rollback.body.change_request_id) }
  }

  it('refuses to resume while the rollback is pending, and again once it is approved', async () => {
    const { changeRequestId, rollbackId } = await failedCreationWithRollback()
    const creates = meta.current.creates.length
    expect((await execute(changeRequestId)).status).toBe('ROLLBACK_PENDING')
    await db.query('SELECT * FROM public.review_change_request_with_decision($1, $2, true)', [rollbackId, 'owner@example.test'])
    expect((await execute(changeRequestId)).status).toBe('ROLLBACK_PENDING')
    expect(meta.current.creates.length).toBe(creates)
  })

  it('resumes once the rollback was rejected (control)', async () => {
    const { changeRequestId, rollbackId } = await failedCreationWithRollback()
    await db.query('SELECT * FROM public.review_change_request_with_decision($1, $2, false)', [rollbackId, 'owner@example.test'])
    expect((await execute(changeRequestId)).status).toBe('CREATED_PAUSED')
  })
})
