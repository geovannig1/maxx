// ADR-062: deterministic plan validation. PURE over the plan and an account context the server reads,
// so the same rules run when a plan is drafted, edited, submitted and again just before creation. A
// blocker stops submission and creation; a warning is shown and recorded. Every finding names the field
// it is about and how to fix it. A model never decides any of this.

import type { CopyScore } from '@/lib/creative/copy-scorer'
import {
  OBJECTIVE_OPTIMIZATION, PAID_TOUCH_URL_TAGS, PLAN_LIMITS, planAds, planDailyBudgetMinor,
  type CampaignPlanSpec, type PlanAdSet, type PlanCopy,
} from './plan-spec'

export type PlanIssueSeverity = 'blocker' | 'warning'

export interface PlanIssue {
  path: string
  code: string
  severity: PlanIssueSeverity
  message: string
}

export interface PlanAudienceInfo { name: string | null; approximateCount: number | null; metaAccountId: string | null }

export interface PlanValidationContext {
  accountCurrency: string
  /** The ad account's Meta id (act_…), to compare with an audience's owning account. */
  metaAccountId: string
  currencySupported: boolean
  /** currencyMismatch(account currency): the configured currency (limits, previews) is not the account's. */
  configuredCurrencyProblem: string | null
  /** Today's date in the account timezone (YYYY-MM-DD). */
  today: string
  /** Meta's minimum daily budget per ad set, in minor units, for an optimization goal. */
  minDailyBudgetMinor: (goal: PlanAdSet['optimization_goal']) => number
  /** The owner's account-total daily ceiling, in minor units. */
  ceilingMinor: number
  /** Today's active account daily budget total in minor units; null when it could not be proven. */
  accountActiveDailyMinor: number | null
  maxStepPercent: number
  pageId: string | null
  /** The account's own pixel (dataset) id, synced from Meta; null when none is synced. */
  pixelId: string | null
  audiences: ReadonlyMap<string, PlanAudienceInfo>
  creativeIds: ReadonlySet<string>
  imageHashes: ReadonlySet<string>
  videoIds: ReadonlySet<string>
  /** Thumbnails of this account's synced creatives: the only image URLs a video creative may carry. */
  thumbnailUrls: ReadonlySet<string>
  /** Hosts an ad's destination may point at (lower case). */
  landingHosts: readonly string[]
  scoreCopy: (copy: PlanCopy) => CopyScore
}

export interface PlanValidation {
  ok: boolean
  issues: PlanIssue[]
  totalDailyMinor: number
  /** The plan's daily budget as a percent of today's active account total; null when unknown or zero. */
  stepPercent: number | null
  /** True when the step is above the per-change limit and needs the owner's explicit confirmation. */
  stepOverrideRequired: boolean
}

const blocker = (path: string, code: string, message: string): PlanIssue => ({ path, code, severity: 'blocker', message })
const warning = (path: string, code: string, message: string): PlanIssue => ({ path, code, severity: 'warning', message })

/** The url_tags keys of the ADR-056 contract missing from a value. */
export function missingUrlTagKeys(urlTags: string): string[] {
  const present = new Map(urlTags.split('&').map((pair) => pair.split('=')).filter((p) => p.length === 2).map(([k, v]) => [k.trim(), v.trim()]))
  return PAID_TOUCH_URL_TAGS.split('&').map((pair) => pair.split('=')).filter(([k, v]) => present.get(k) !== v).map(([k]) => k)
}

export function destinationProblem(url: string | null, hosts: readonly string[]): string | null {
  if (!url) return 'Add a destination URL.'
  let parsed: URL
  try { parsed = new URL(url) } catch { return 'The destination is not a valid URL.' }
  if (parsed.protocol !== 'https:') return 'The destination must use https.'
  if (parsed.username || parsed.password) return 'The destination cannot contain credentials.'
  if (hosts.length === 0) return 'No landing host is configured. Set PAID_TOUCH_ALLOWED_LANDING_HOSTS or the business profile website.'
  if (!hosts.includes(parsed.hostname.toLowerCase())) return `The destination host ${parsed.hostname} is not one of your landing hosts (${hosts.join(', ')}).`
  return null
}

function campaignRules(spec: CampaignPlanSpec, ctx: PlanValidationContext): PlanIssue[] {
  const issues: PlanIssue[] = []
  const c = spec.campaign
  if (spec.currency !== ctx.accountCurrency) issues.push(blocker('currency', 'currency_mismatch', `The plan is in ${spec.currency}; the ad account is in ${ctx.accountCurrency}.`))
  if (!ctx.currencySupported) issues.push(blocker('currency', 'currency_unsupported', `Maxx cannot convert ${ctx.accountCurrency} budgets to Meta's units.`))
  if (ctx.configuredCurrencyProblem) issues.push(blocker('currency', 'currency_config_mismatch', ctx.configuredCurrencyProblem))
  if (c.budget_mode === 'CBO' && c.daily_budget_minor === null) issues.push(blocker('campaign.daily_budget_minor', 'cbo_budget_missing', 'Campaign budget optimisation needs a campaign daily budget.'))
  if (c.budget_mode === 'ABO' && c.daily_budget_minor !== null) issues.push(blocker('campaign.daily_budget_minor', 'abo_campaign_budget', 'With ad set budgets, the campaign itself has no budget.'))
  if (c.bid_strategy === 'COST_CAP' && c.bid_amount_minor === null) issues.push(blocker('campaign.bid_amount_minor', 'cost_cap_missing', 'A cost cap needs the cap amount you choose; Maxx never picks one.'))
  if (c.bid_strategy === 'LOWEST_COST_WITHOUT_CAP' && c.bid_amount_minor !== null) issues.push(blocker('campaign.bid_amount_minor', 'bid_amount_without_cap', 'Lowest cost takes no bid amount.'))
  if (spec.schedule.start_date < ctx.today) issues.push(blocker('schedule.start_date', 'start_in_past', `The start date ${spec.schedule.start_date} is before today (${ctx.today}).`))
  if (spec.schedule.end_date !== null && spec.schedule.end_date <= spec.schedule.start_date) issues.push(blocker('schedule.end_date', 'end_before_start', 'The end date must be after the start date.'))
  const conversionGoals = spec.ad_sets.some((s) => s.optimization_goal === 'OFFSITE_CONVERSIONS')
  if (conversionGoals && spec.conversion === null) issues.push(blocker('conversion', 'pixel_missing', 'Optimising for conversions needs your pixel (dataset) and outcome event. Connect the pixel, or optimise for landing-page views.'))
  if (spec.conversion !== null && spec.conversion.pixel_id !== ctx.pixelId) {
    issues.push(blocker('conversion.pixel_id', 'pixel_not_account_pixel', ctx.pixelId ? `Pixel ${spec.conversion.pixel_id} is not this ad account's pixel (${ctx.pixelId}).` : 'This ad account has no synced pixel, so the plan cannot name one. Sync the account, or optimise for landing-page views.'))
  }
  return issues
}

function budgetRules(spec: CampaignPlanSpec, ctx: PlanValidationContext, total: number): PlanIssue[] {
  const issues: PlanIssue[] = []
  if (spec.campaign.budget_mode === 'CBO') {
    const needed = spec.ad_sets.reduce((sum, s) => sum + ctx.minDailyBudgetMinor(s.optimization_goal), 0)
    if ((spec.campaign.daily_budget_minor ?? 0) < needed) issues.push(blocker('campaign.daily_budget_minor', 'budget_below_meta_minimum', `The campaign budget is below Meta's minimum for ${spec.ad_sets.length} ad set(s).`))
  }
  spec.ad_sets.forEach((s, i) => {
    if (spec.campaign.budget_mode === 'ABO') {
      if (s.daily_budget_minor === null) issues.push(blocker(`ad_sets.${i}.daily_budget_minor`, 'abo_budget_missing', 'Each ad set needs a daily budget.'))
      else if (s.daily_budget_minor < ctx.minDailyBudgetMinor(s.optimization_goal)) issues.push(blocker(`ad_sets.${i}.daily_budget_minor`, 'budget_below_meta_minimum', 'This ad set budget is below Meta\'s minimum for its optimisation goal.'))
    } else if (s.daily_budget_minor !== null) {
      issues.push(blocker(`ad_sets.${i}.daily_budget_minor`, 'cbo_adset_budget', 'Under campaign budget optimisation the ad set has no budget of its own.'))
    }
  })
  if (total > ctx.ceilingMinor) issues.push(blocker('campaign', 'over_account_ceiling', 'The plan alone is above your account daily budget ceiling.'))
  else if (ctx.accountActiveDailyMinor === null) issues.push(blocker('campaign', 'account_total_unknown', 'Today\'s active account budget could not be proven, so the ceiling cannot be checked.'))
  else if (ctx.accountActiveDailyMinor + total > ctx.ceilingMinor) issues.push(blocker('campaign', 'over_account_ceiling', 'Your active campaigns plus this plan would exceed the account daily budget ceiling, even though it starts paused.'))
  if (spec.ad_sets.length > 3 && total < 3 * spec.ad_sets.reduce((sum, s) => sum + ctx.minDailyBudgetMinor(s.optimization_goal), 0)) {
    issues.push(warning('ad_sets', 'too_many_adsets_for_budget', 'Several ad sets on a small budget split delivery thin. Consolidate into one to three.'))
  }
  return issues
}

function audienceRules(adSet: PlanAdSet, i: number, ctx: PlanValidationContext): PlanIssue[] {
  const issues: PlanIssue[] = []
  const a = adSet.audience
  const objective = adSet.optimization_goal
  if (a.age_min < PLAN_LIMITS.minAge || a.age_max > PLAN_LIMITS.maxAge || a.age_min > a.age_max) issues.push(blocker(`ad_sets.${i}.audience.age_min`, 'age_invalid', `Ages must be within ${PLAN_LIMITS.minAge}-${PLAN_LIMITS.maxAge}, minimum not above maximum.`))
  if (a.mode === 'custom' && a.custom_audience_ids.length === 0) issues.push(blocker(`ad_sets.${i}.audience.custom_audience_ids`, 'custom_audience_missing', 'A custom audience ad set needs at least one audience.'))
  if (a.mode !== 'custom' && a.custom_audience_ids.length > 0) issues.push(blocker(`ad_sets.${i}.audience.custom_audience_ids`, 'audience_mode_mismatch', 'Included audiences need the custom audience mode.'))
  for (const [field, ids] of [['custom_audience_ids', a.custom_audience_ids], ['excluded_audience_ids', a.excluded_audience_ids]] as const) {
    for (const id of ids) {
      const known = ctx.audiences.get(id)
      if (!known) issues.push(blocker(`ad_sets.${i}.audience.${field}`, 'audience_unknown', `Audience ${id} is not one of this account's synced audiences.`))
      else if (known.metaAccountId && known.metaAccountId !== ctx.metaAccountId) issues.push(blocker(`ad_sets.${i}.audience.${field}`, 'audience_other_account', `Audience ${id} belongs to another ad account.`))
    }
  }
  if (a.custom_audience_ids.some((id) => a.excluded_audience_ids.includes(id))) issues.push(blocker(`ad_sets.${i}.audience`, 'audience_included_and_excluded', 'An audience cannot be both included and excluded.'))
  if (objective === 'POST_ENGAGEMENT' && adSet.ads.some((ad) => ad.creative.mode !== 'existing_creative')) issues.push(blocker(`ad_sets.${i}.optimization_goal`, 'engagement_needs_post', 'Engagement ads must reuse an existing post creative.'))
  if (a.mode === 'advantage_plus' && (a.age_max < PLAN_LIMITS.maxAge || a.age_min > 25)) {
    issues.push(warning(`ad_sets.${i}.audience.age_min`, 'advantage_age_range', 'With Advantage+ audience Meta treats ages as a suggestion and may refuse a maximum below 65 or a minimum above 25. Use broad targeting for a strict age range.'))
  }
  return issues
}

function adRules(spec: CampaignPlanSpec, ctx: PlanValidationContext): PlanIssue[] {
  const issues: PlanIssue[] = []
  const names = new Set<string>()
  const keys = new Set<string>()
  spec.ad_sets.forEach((adSet, i) => {
    if (!OBJECTIVE_OPTIMIZATION[spec.campaign.objective].includes(adSet.optimization_goal)) {
      issues.push(blocker(`ad_sets.${i}.optimization_goal`, 'objective_goal_mismatch', `${spec.campaign.objective} does not accept ${adSet.optimization_goal}.`))
    }
    if (keys.has(adSet.key)) issues.push(blocker(`ad_sets.${i}.key`, 'duplicate_key', 'Ad set keys must be unique.'))
    keys.add(adSet.key)
    issues.push(...audienceRules(adSet, i, ctx))
    if (adSet.ads.length === 0) issues.push(blocker(`ad_sets.${i}.ads`, 'no_ads', 'An ad set needs at least one ad.'))
    else if (adSet.ads.length < 3) issues.push(warning(`ad_sets.${i}.ads`, 'few_ads', 'Fewer than 3 ads gives Meta little to choose from. Three to six distinct ads is a sound start.'))
    adSet.ads.forEach((ad, j) => {
      const path = `ad_sets.${i}.ads.${j}`
      if (keys.has(`${adSet.key}:${ad.key}`)) issues.push(blocker(`${path}.key`, 'duplicate_key', 'Ad keys must be unique in their ad set.'))
      keys.add(`${adSet.key}:${ad.key}`)
      if (names.has(ad.name)) issues.push(blocker(`${path}.name`, 'duplicate_name', 'Ad names must be unique in a plan.'))
      names.add(ad.name)
      const cr = ad.creative
      if (cr.mode === 'existing_creative') {
        if (!ctx.creativeIds.has(cr.creative_id)) issues.push(blocker(`${path}.creative`, 'creative_unknown', `Creative ${cr.creative_id} is not a synced creative of this account.`))
        if (ad.copy !== null) issues.push(blocker(`${path}.copy`, 'copy_on_existing_creative', 'An existing creative runs with its own copy. Pick an image or video to use new copy.'))
        return
      }
      if (cr.mode === 'image' && !ctx.imageHashes.has(cr.image_hash)) issues.push(blocker(`${path}.creative`, 'image_unknown', 'That image is not in this account\'s synced creatives.'))
      if (cr.mode === 'video' && !ctx.videoIds.has(cr.video_id)) issues.push(blocker(`${path}.creative`, 'video_unknown', 'That video is not in this account\'s synced creatives.'))
      if (cr.mode === 'video' && !cr.thumbnail_url) issues.push(warning(`${path}.creative`, 'video_thumbnail_missing', 'This video has no synced thumbnail; Meta may refuse a video creative without one.'))
      if (cr.mode === 'video' && cr.thumbnail_url && !ctx.thumbnailUrls.has(cr.thumbnail_url)) issues.push(blocker(`${path}.creative.thumbnail_url`, 'thumbnail_unknown', 'The thumbnail must be one of this account\'s synced creative thumbnails.'))
      if (!ctx.pageId) issues.push(blocker(`${path}.creative`, 'page_missing', 'A new creative needs the Facebook Page of the ad account; it is not synced.'))
      const destination = destinationProblem(ad.destination_url, ctx.landingHosts)
      if (destination) issues.push(blocker(`${path}.destination_url`, 'destination_invalid', destination))
      if (/[\s<>"'\\]/.test(ad.url_tags)) issues.push(blocker(`${path}.url_tags`, 'url_tags_invalid', 'URL parameters cannot contain spaces, quotes or angle brackets.'))
      const missing = missingUrlTagKeys(ad.url_tags)
      if (missing.length > 0) issues.push(warning(`${path}.url_tags`, 'url_tags_incomplete', `Missing the tracking parameters ${missing.join(', ')}: outcomes from this ad cannot be joined to it.`))
      if (!ad.copy) { issues.push(blocker(`${path}.copy`, 'copy_missing', 'A new creative needs copy: primary text, headline and a call to action.')); return }
      const score = ctx.scoreCopy(ad.copy)
      for (const finding of score.findings.filter((f) => f.severity === 'blocker')) {
        issues.push(blocker(`${path}.copy`, `copy_${finding.rule}`, `${finding.message} ${finding.fix}`.trim()))
      }
    })
  })
  const total = planAds(spec).length
  if (total > PLAN_LIMITS.adsTotal) issues.push(blocker('ad_sets', 'too_many_ads', `A plan holds at most ${PLAN_LIMITS.adsTotal} ads.`))
  return issues
}

/** Validate a parsed plan against the account. `ok` means no blocker. */
export function validateCampaignPlan(spec: CampaignPlanSpec, ctx: PlanValidationContext): PlanValidation {
  const total = planDailyBudgetMinor(spec)
  const issues = [...campaignRules(spec, ctx), ...budgetRules(spec, ctx, total), ...adRules(spec, ctx)]
  const active = ctx.accountActiveDailyMinor
  const stepPercent = active !== null && active > 0 ? Math.round((total / active) * 10_000) / 100 : null
  return {
    ok: !issues.some((issue) => issue.severity === 'blocker'),
    issues,
    totalDailyMinor: total,
    stepPercent,
    stepOverrideRequired: stepPercent !== null && stepPercent > ctx.maxStepPercent,
  }
}
