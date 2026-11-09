import { describe, expect, it } from 'vitest'
import { campaignPlanSpecSchema, type CampaignPlanSpec } from '@/lib/campaigns/plan-spec'
import { validateCampaignPlan, type PlanValidationContext } from '@/lib/campaigns/plan-validation'
import { planReadiness } from '@/lib/campaigns/plan-readiness'
import { context, validSpec } from './_support/campaign-plan-fixtures'

// ADR-062: every validation rule rejects its bad case, and a sound plan passes (the control).

const codes = (spec: CampaignPlanSpec, ctx = context()) => validateCampaignPlan(spec, ctx).issues.filter((i) => i.severity === 'blocker').map((i) => i.code)

function mutate(change: (spec: CampaignPlanSpec) => void): CampaignPlanSpec {
  const spec = structuredClone(validSpec())
  change(spec)
  return spec
}

describe('validateCampaignPlan (ADR-062)', () => {
  it('passes a sound plan (control)', () => {
    const result = validateCampaignPlan(validSpec(), context())
    expect(result.issues.filter((i) => i.severity === 'blocker')).toEqual([])
    expect(result).toMatchObject({ ok: true, totalDailyMinor: 3000, stepPercent: 50, stepOverrideRequired: false })
  })

  it.each<[string, (s: CampaignPlanSpec) => void, Partial<PlanValidationContext>]>([
    ['currency_mismatch', (s) => { s.currency = 'EUR' }, {}],
    ['currency_unsupported', () => {}, { currencySupported: false }],
    // Security review M2: the configured currency (budget limits, previews) must be the account's own.
    ['currency_config_mismatch', () => {}, { configuredCurrencyProblem: 'The Meta ad account currency (EUR) does not match the configured account currency USD.' }],
    ['cbo_budget_missing', (s) => { s.campaign.daily_budget_minor = null }, {}],
    ['abo_campaign_budget', (s) => { s.campaign.budget_mode = 'ABO'; s.ad_sets[0].daily_budget_minor = 3000 }, {}],
    ['abo_budget_missing', (s) => { s.campaign.budget_mode = 'ABO'; s.campaign.daily_budget_minor = null }, {}],
    ['cbo_adset_budget', (s) => { s.ad_sets[0].daily_budget_minor = 1000 }, {}],
    ['cost_cap_missing', (s) => { s.campaign.bid_strategy = 'COST_CAP' }, {}],
    ['bid_amount_without_cap', (s) => { s.campaign.bid_amount_minor = 900 }, {}],
    ['start_in_past', (s) => { s.schedule.start_date = '2026-11-01' }, {}],
    ['end_before_start', (s) => { s.schedule.end_date = '2026-11-10' }, {}],
    ['pixel_missing', (s) => { s.conversion = null }, {}],
    // Security review L2: only the account's own pixel, and only a synced thumbnail, reach Meta.
    ['pixel_not_account_pixel', (s) => { s.conversion = { pixel_id: '222', custom_event: 'Purchase' } }, {}],
    ['pixel_not_account_pixel', () => {}, { pixelId: null }],
    ['thumbnail_unknown', (s) => { s.ad_sets[0].ads[0].creative = { mode: 'video', video_id: '888', thumbnail_url: 'https://tracker.example/pixel.gif' } }, {}],
    ['budget_below_meta_minimum', (s) => { s.campaign.daily_budget_minor = 400 }, {}],
    ['over_account_ceiling', () => {}, { accountActiveDailyMinor: 18_000 }],
    ['account_total_unknown', () => {}, { accountActiveDailyMinor: null }],
    ['objective_goal_mismatch', (s) => { s.campaign.objective = 'OUTCOME_TRAFFIC' }, {}],
    ['age_invalid', (s) => { s.ad_sets[0].audience.age_min = 16 }, {}],
    ['custom_audience_missing', (s) => { s.ad_sets[0].audience.mode = 'custom' }, {}],
    ['audience_mode_mismatch', (s) => { s.ad_sets[0].audience.custom_audience_ids = ['900'] }, {}],
    ['audience_unknown', (s) => { s.ad_sets[0].audience.excluded_audience_ids = ['404'] }, {}],
    ['audience_other_account', (s) => { s.ad_sets[0].audience.excluded_audience_ids = ['901'] }, {}],
    ['audience_included_and_excluded', (s) => { s.ad_sets[0].audience.mode = 'custom'; s.ad_sets[0].audience.custom_audience_ids = ['900'] }, {}],
    ['no_ads', (s) => { s.ad_sets[0].ads = [] }, {}],
    ['duplicate_name', (s) => { s.ad_sets[0].ads[1].name = 'Ad 1' }, {}],
    ['creative_unknown', (s) => { s.ad_sets[0].ads[0].creative = { mode: 'existing_creative', creative_id: '404' }; s.ad_sets[0].ads[0].copy = null }, {}],
    ['copy_on_existing_creative', (s) => { s.ad_sets[0].ads[0].creative = { mode: 'existing_creative', creative_id: '777' } }, {}],
    ['image_unknown', (s) => { s.ad_sets[0].ads[0].creative = { mode: 'image', image_hash: 'notmine1' } }, {}],
    ['video_unknown', (s) => { s.ad_sets[0].ads[0].creative = { mode: 'video', video_id: '404', thumbnail_url: null } }, {}],
    ['page_missing', () => {}, { pageId: null }],
    ['destination_invalid', (s) => { s.ad_sets[0].ads[0].destination_url = 'https://evil.example/x' }, {}],
    ['destination_invalid', (s) => { s.ad_sets[0].ads[0].destination_url = 'http://studio.example/book' }, {}],
    ['url_tags_invalid', (s) => { s.ad_sets[0].ads[0].url_tags = 'utm_source=meta"><script>' }, {}],
    ['copy_missing', (s) => { s.ad_sets[0].ads[0].copy = null }, {}],
    ['copy_unverified_claim', (s) => { s.ad_sets[0].ads[0].copy!.primary_text = 'Rated #1 studio in town by 500 happy clients.' }, {}],
  ])('rejects %s', (code, change, over) => {
    expect(codes(mutate(change), context(over))).toContain(code)
  })

  it('warns on an Advantage+ age range Meta may refuse and a video without a thumbnail', () => {
    const spec = mutate((s) => { s.ad_sets[0].audience.age_max = 45; s.ad_sets[0].ads[0].creative = { mode: 'video', video_id: '888', thumbnail_url: null } })
    const result = validateCampaignPlan(spec, context())
    expect(result.ok).toBe(true)
    expect(result.issues.filter((i) => i.severity === 'warning').map((i) => i.code)).toEqual(expect.arrayContaining(['advantage_age_range', 'video_thumbnail_missing']))
  })

  it('accepts a video whose thumbnail is one of the synced thumbnails (control)', () => {
    const spec = mutate((s) => { s.ad_sets[0].ads[0].creative = { mode: 'video', video_id: '888', thumbnail_url: 'https://cdn.example/thumb888.jpg' } })
    expect(codes(spec)).toEqual([])
  })

  it('needs a destination host to be configured at all', () => {
    expect(validateCampaignPlan(validSpec(), context({ landingHosts: [] })).issues.map((i) => i.message).join(' ')).toMatch(/No landing host is configured/)
  })

  it('warns, without blocking, on incomplete tracking parameters and on fewer than three ads', () => {
    const spec = mutate((s) => { s.ad_sets[0].ads = s.ad_sets[0].ads.slice(0, 2); s.ad_sets[0].ads[0].url_tags = 'utm_source=meta' })
    const result = validateCampaignPlan(spec, context())
    expect(result.ok).toBe(true)
    expect(result.issues.filter((i) => i.severity === 'warning').map((i) => i.code)).toEqual(expect.arrayContaining(['url_tags_incomplete', 'few_ads']))
  })

  it('requires an explicit override when the plan is a large step on today\'s account budget', () => {
    const result = validateCampaignPlan(validSpec(), context({ accountActiveDailyMinor: 2000 }))
    expect(result).toMatchObject({ ok: true, stepPercent: 150, stepOverrideRequired: true })
  })

  it('the schema refuses a status, an unknown objective or an unknown key outright', () => {
    const raw = JSON.parse(JSON.stringify(validSpec())) as Record<string, unknown> & { campaign: Record<string, unknown> }
    expect(campaignPlanSpecSchema.safeParse({ ...raw, campaign: { ...raw.campaign, status: 'ACTIVE' } }).success).toBe(false)
    expect(campaignPlanSpecSchema.safeParse({ ...raw, campaign: { ...raw.campaign, objective: 'OUTCOME_APP_PROMOTION' } }).success).toBe(false)
    expect(campaignPlanSpecSchema.safeParse({ ...raw, surprise: 1 }).success).toBe(false)
  })
})

describe('planReadiness (ADR-062)', () => {
  const readinessCtx = { landingHosts: ['studio.example'], creativeLinks: new Map(), audienceSizes: new Map([['900', 4000]]), outcomeEvent: 'Purchase' }

  it('reports a sound plan ready', () => {
    const spec = validSpec()
    const items = planReadiness(spec, validateCampaignPlan(spec, context()), readinessCtx)
    expect(items.map((i) => [i.id, i.status])).toEqual([
      ['conversion_signal', 'ok'], ['destination', 'ok'], ['tracking_tags', 'ok'], ['budget', 'ok'],
      ['audience_size', 'ok'], ['creative_variety', 'ok'], ['copy', 'ok'],
    ])
  })

  it('never reports an unknown audience size or an unprovable budget as passed', () => {
    const spec = mutate((s) => { s.ad_sets[0].audience.mode = 'custom'; s.ad_sets[0].audience.custom_audience_ids = ['900']; s.ad_sets[0].audience.excluded_audience_ids = [] })
    const items = planReadiness(spec, validateCampaignPlan(spec, context({ accountActiveDailyMinor: null })), { ...readinessCtx, audienceSizes: new Map([['900', null]]) })
    expect(Object.fromEntries(items.map((i) => [i.id, i.status]))).toMatchObject({ audience_size: 'unknown', budget: 'unknown' })
  })

  it('blocks on a missing pixel and flags thin creative variety', () => {
    const spec = mutate((s) => { s.conversion = null; s.ad_sets[0].ads = s.ad_sets[0].ads.slice(0, 1) })
    const items = Object.fromEntries(planReadiness(spec, validateCampaignPlan(spec, context()), readinessCtx).map((i) => [i.id, i.status]))
    expect(items).toMatchObject({ conversion_signal: 'blocked', creative_variety: 'warn' })
  })

  it('warns, without blocking, when a reused creative links off your hosts; a new creative off-host is blocked', () => {
    const reused = mutate((s) => { s.ad_sets[0].ads[0] = { ...s.ad_sets[0].ads[0], creative: { mode: 'existing_creative', creative_id: '777' }, copy: null, destination_url: null } })
    const ctxLinks = { ...readinessCtx, creativeLinks: new Map([['777', { linkUrl: 'https://elsewhere.example/', urlTags: null }]]) }
    expect(planReadiness(reused, validateCampaignPlan(reused, context()), ctxLinks).find((i) => i.id === 'destination')?.status).toBe('warn')
    const offHost = mutate((s) => { s.ad_sets[0].ads[0].destination_url = 'https://elsewhere.example/' })
    expect(planReadiness(offHost, validateCampaignPlan(offHost, context()), readinessCtx).find((i) => i.id === 'destination')?.status).toBe('blocked')
  })
})
