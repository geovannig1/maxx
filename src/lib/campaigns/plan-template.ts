// ADR-062: the deterministic planner. PURE over a brief and the account context. It drafts what a
// senior media buyer would set up on a small budget: one campaign with campaign budget optimisation,
// lowest-cost bidding, one Advantage+ ad set (a warm ad set only when the budget can carry it), and
// three to six distinct ads pairing saved copy with distinct visuals already in the account. With AI off
// this is the whole planner; with AI on it is the fallback and the frame the model's proposal fills.

import type { PlanBrief, PlanGoal } from './plan-brief'
import {
  PAID_TOUCH_URL_TAGS, PLAN_LIMITS, campaignPlanSpecSchema,
  type CampaignPlanSpec, type OptimizationGoal, type PlanAd, type PlanAdSet, type PlanCopy, type PlanCreative, type PlanObjective,
} from './plan-spec'

export interface PlanAsset {
  /** Opaque reference shown to the model (A1, A2…); never a Meta id or hash. */
  ref: string
  creativeId: string
  name: string | null
  imageHash: string | null
  videoId: string | null
  thumbnailUrl: string | null
  linkUrl: string | null
  urlTags: string | null
}

export interface PlanAudienceOption {
  id: string
  name: string | null
  subtype: string | null
  approximateCount: number | null
  metaAccountId: string | null
}

export interface PlanDraftContext {
  currency: string
  today: string
  pixelId: string | null
  pageId: string | null
  outcomeEvent: string
  landingHosts: readonly string[]
  defaultDestination: string | null
  audiences: readonly PlanAudienceOption[]
  assets: readonly PlanAsset[]
  /** Saved Copy studio variants with no scorer blocker, best first. */
  copyBank: readonly PlanCopy[]
  /** Account-currency major units to Meta minor units (the platform's budgetUnits). */
  toMinor: (major: number) => number
  minDailyMinor: (goal: OptimizationGoal) => number
}

export interface DraftedSpec { spec: CampaignPlanSpec; notes: string[] }

export const MAX_ADS_PER_ADSET = 6
const WARM_SUBTYPES = new Set(['WEBSITE', 'ENGAGEMENT', 'VIDEO', 'IG_BUSINESS', 'PAGE'])

/** Consolidate: one ad set below ten daily minimums, two below twenty, three at most. */
export function maxAdSetsFor(totalMinor: number, minPerAdSetMinor: number): number {
  if (totalMinor < 10 * minPerAdSetMinor) return 1
  if (totalMinor < 20 * minPerAdSetMinor) return 2
  return 3
}

export function objectiveFor(goal: PlanGoal): PlanObjective {
  return goal === 'sales' ? 'OUTCOME_SALES' : goal === 'leads' ? 'OUTCOME_LEADS' : 'OUTCOME_TRAFFIC'
}

/** The optimisation goal and conversion target for a goal; landing-page views without a pixel. */
export function conversionFor(goal: PlanGoal, ctx: Pick<PlanDraftContext, 'pixelId' | 'outcomeEvent'>): {
  optimization: OptimizationGoal; conversion: CampaignPlanSpec['conversion']; note: string | null
} {
  if (goal === 'traffic') return { optimization: 'LANDING_PAGE_VIEWS', conversion: null, note: null }
  if (!ctx.pixelId) {
    return { optimization: 'LANDING_PAGE_VIEWS', conversion: null, note: 'No pixel is synced for this ad account, so the plan optimises for landing-page views. Connect the pixel to optimise for conversions.' }
  }
  return { optimization: 'OFFSITE_CONVERSIONS', conversion: { pixel_id: ctx.pixelId, custom_event: ctx.outcomeEvent }, note: null }
}

export const clip = (text: string, max: number = PLAN_LIMITS.name) => (text.length > max ? text.slice(0, max).trimEnd() : text)

export function creativeOf(asset: PlanAsset): PlanCreative {
  if (asset.imageHash) return { mode: 'image', image_hash: asset.imageHash }
  if (asset.videoId) return { mode: 'video', video_id: asset.videoId, thumbnail_url: asset.thumbnailUrl }
  return { mode: 'existing_creative', creative_id: asset.creativeId }
}

/** Visuals a new creative can use (an image hash or a video), distinct, newest first. */
export function mediaAssets(ctx: Pick<PlanDraftContext, 'assets'>): PlanAsset[] {
  const seen = new Set<string>()
  return ctx.assets.filter((a) => {
    const key = a.imageHash ? `i:${a.imageHash}` : a.videoId ? `v:${a.videoId}` : null
    if (!key || seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** Ads pairing copy with visuals; without saved copy, existing creatives run as they are. */
export function buildAds(copies: readonly PlanCopy[], assets: readonly PlanAsset[], destination: string | null, limit = MAX_ADS_PER_ADSET): PlanAd[] {
  const media = mediaAssets({ assets })
  if (copies.length > 0 && media.length > 0) {
    return copies.slice(0, limit).map((copy, i) => ({
      key: `ad${i + 1}`, name: clip(`Ad ${i + 1} · ${copy.angle ?? 'copy'} · ${media[i % media.length].name ?? media[i % media.length].ref}`),
      creative: creativeOf(media[i % media.length]), copy, destination_url: destination, url_tags: PAID_TOUCH_URL_TAGS,
    }))
  }
  return assets.slice(0, limit).map((asset, i) => ({
    key: `ad${i + 1}`, name: clip(`Ad ${i + 1} · ${asset.name ?? asset.ref}`),
    creative: { mode: 'existing_creative', creative_id: asset.creativeId }, copy: null, destination_url: null, url_tags: PAID_TOUCH_URL_TAGS,
  }))
}

export function draftNotes(ctx: PlanDraftContext, ads: readonly PlanAd[]): string[] {
  const notes: string[] = []
  if (ads.length === 0) notes.push('No creatives are synced for this account yet. Run a sync, or add ads in Meta, before planning.')
  else if (ads.every((ad) => ad.copy === null)) notes.push('No saved copy: these ads reuse your existing creatives with their own copy. Write and save copy in the Copy studio to build new ads from your images and videos.')
  return notes
}

export function destinationFor(brief: PlanBrief, ctx: PlanDraftContext): string | null {
  return brief.destination_url ?? ctx.defaultDestination
}

export function warmAudiences(ctx: Pick<PlanDraftContext, 'audiences'>): PlanAudienceOption[] {
  return ctx.audiences.filter((a) => WARM_SUBTYPES.has((a.subtype ?? '').toUpperCase()))
}

export function adSetOf(input: { key: string; name: string; optimization: OptimizationGoal; mode: PlanAdSet['audience']['mode']; include: string[]; exclude: string[]; countries: string[]; ageMin?: number; ageMax?: number; ads: PlanAd[] }): PlanAdSet {
  return {
    key: input.key, name: clip(input.name), daily_budget_minor: null, optimization_goal: input.optimization,
    audience: { mode: input.mode, custom_audience_ids: input.include, excluded_audience_ids: input.exclude, countries: input.countries, age_min: input.ageMin ?? 18, age_max: input.ageMax ?? 65 },
    placements: 'advantage_plus', ads: input.ads,
  }
}

export function campaignOf(brief: PlanBrief, ctx: PlanDraftContext, name: string, adSets: PlanAdSet[], conversion: CampaignPlanSpec['conversion']): CampaignPlanSpec {
  return campaignPlanSpecSchema.parse({
    currency: ctx.currency,
    campaign: {
      name: clip(name), objective: objectiveFor(brief.goal), buying_type: 'AUCTION', budget_mode: 'CBO',
      daily_budget_minor: ctx.toMinor(brief.daily_budget), bid_strategy: 'LOWEST_COST_WITHOUT_CAP', bid_amount_minor: null,
    },
    schedule: { start_date: brief.start_date, end_date: brief.end_date },
    conversion,
    ad_sets: adSets,
  })
}

/** The deterministic draft for a brief. */
export function buildTemplatePlan(brief: PlanBrief, ctx: PlanDraftContext): DraftedSpec {
  const { optimization, conversion, note } = conversionFor(brief.goal, ctx)
  const destination = destinationFor(brief, ctx)
  const ads = buildAds(ctx.copyBank, ctx.assets, destination)
  const warm = warmAudiences(ctx).slice(0, PLAN_LIMITS.audiencesPerAdSet)
  const totalMinor = ctx.toMinor(brief.daily_budget)
  const withWarm = warm.length > 0 && maxAdSetsFor(totalMinor, ctx.minDailyMinor(optimization)) >= 2
  const countries = brief.countries
  const adSets = [adSetOf({
    key: 'as1', name: `Prospecting · Advantage+ · ${countries.join(', ')}`, optimization, mode: 'advantage_plus',
    include: [], exclude: withWarm ? warm.map((a) => a.id) : [], countries, ads,
  })]
  if (withWarm) {
    adSets.push(adSetOf({
      key: 'as2', name: `Warm · ${warm.map((a) => a.name ?? a.id).join(', ')}`, optimization, mode: 'custom',
      include: warm.map((a) => a.id), exclude: [], countries, ads: ads.slice(0, 3).map((ad) => ({ ...ad, name: clip(`${ad.name} · warm`) })),
    }))
  }
  const notes = [note, ...draftNotes(ctx, ads)].filter((n): n is string => !!n)
  return { spec: campaignOf(brief, ctx, `${brief.product} · ${brief.goal} · ${brief.start_date}`, adSets, conversion), notes }
}
