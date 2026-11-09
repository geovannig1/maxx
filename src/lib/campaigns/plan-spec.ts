// ADR-062: the campaign plan contract. PURE and client-safe: the planner, the validator, the console
// editor and the creation path all read this one shape. Money is integer MINOR units of the account
// currency (Meta's own budget unit), converted only through the platform's budgetUnits. Nothing here
// carries a status: every object a plan creates is PAUSED, which the payload builder fixes, not the plan.

import { z } from 'zod'
import { COPY_ANGLES, META_CTAS } from '@/lib/creative/copy-rules'

/** The Meta campaign objectives a plan may use (ODAX). Awareness and app objectives are out of scope. */
export const PLAN_OBJECTIVES = ['OUTCOME_SALES', 'OUTCOME_LEADS', 'OUTCOME_TRAFFIC', 'OUTCOME_ENGAGEMENT'] as const
export type PlanObjective = (typeof PLAN_OBJECTIVES)[number]

/** Ad-set optimization goals Maxx can set without an app, a lead form or a catalog. */
export const OPTIMIZATION_GOALS = ['OFFSITE_CONVERSIONS', 'LANDING_PAGE_VIEWS', 'LINK_CLICKS', 'POST_ENGAGEMENT'] as const
export type OptimizationGoal = (typeof OPTIMIZATION_GOALS)[number]

/** Which optimization goals Meta accepts under each objective (the subset Maxx supports). */
export const OBJECTIVE_OPTIMIZATION: Record<PlanObjective, readonly OptimizationGoal[]> = {
  OUTCOME_SALES: ['OFFSITE_CONVERSIONS', 'LANDING_PAGE_VIEWS', 'LINK_CLICKS'],
  OUTCOME_LEADS: ['OFFSITE_CONVERSIONS', 'LANDING_PAGE_VIEWS', 'LINK_CLICKS'],
  OUTCOME_TRAFFIC: ['LANDING_PAGE_VIEWS', 'LINK_CLICKS'],
  OUTCOME_ENGAGEMENT: ['POST_ENGAGEMENT'],
}

export const BID_STRATEGIES = ['LOWEST_COST_WITHOUT_CAP', 'COST_CAP'] as const
export const BUDGET_MODES = ['CBO', 'ABO'] as const
export const AUDIENCE_MODES = ['advantage_plus', 'broad', 'custom'] as const
export const PUBLISHER_PLATFORMS = ['facebook', 'instagram', 'audience_network', 'messenger'] as const

/** ADR-056 §2: the readable UTMs and the immutable Meta ids every governed ad URL carries. */
export const PAID_TOUCH_URL_TAGS = [
  'utm_source=meta', 'utm_medium=paid_social', 'utm_campaign={{campaign.name}}', 'utm_content={{ad.name}}',
  'utm_term={{adset.name}}', 'meta_campaign_id={{campaign.id}}', 'meta_adset_id={{adset.id}}', 'meta_ad_id={{ad.id}}',
].join('&')

/** Meta's documented limits and Maxx's own v1 bounds (the stricter of the two). */
export const PLAN_LIMITS = {
  name: 200, adSets: 5, adsPerAdSet: 10, adsTotal: 30, audiencesPerAdSet: 10, countries: 25,
  urlTags: 1024, url: 2048, minAge: 18, maxAge: 65,
} as const

const metaId = z.string().trim().regex(/^\d{1,32}$/)
const name = z.string().trim().min(1).max(PLAN_LIMITS.name)
const minorAmount = z.number().int().positive().max(1_000_000_000)
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)

export const planCopySchema = z.object({
  primary_text: z.string().trim().min(1).max(3000),
  headline: z.string().trim().min(1).max(400),
  description: z.string().trim().max(400).default(''),
  cta: z.enum(META_CTAS),
  angle: z.enum(COPY_ANGLES).nullable().default(null),
}).strict()
export type PlanCopy = z.infer<typeof planCopySchema>

/** An ad reuses an existing creative as it is, or builds a new creative from media already in the account. */
export const planCreativeSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('existing_creative'), creative_id: metaId }).strict(),
  z.object({ mode: z.literal('image'), image_hash: z.string().trim().regex(/^[A-Za-z0-9_-]{6,64}$/) }).strict(),
  z.object({ mode: z.literal('video'), video_id: metaId, thumbnail_url: z.string().url().max(PLAN_LIMITS.url).nullable().default(null) }).strict(),
])
export type PlanCreative = z.infer<typeof planCreativeSchema>

export const planAdSchema = z.object({
  key: z.string().regex(/^ad\d{1,2}$/),
  name,
  creative: planCreativeSchema,
  /** Required for a new creative (image or video); must be null for an existing creative, whose copy runs as is. */
  copy: planCopySchema.nullable(),
  destination_url: z.string().trim().max(PLAN_LIMITS.url).nullable(),
  url_tags: z.string().trim().max(PLAN_LIMITS.urlTags),
}).strict()
export type PlanAd = z.infer<typeof planAdSchema>

export const planAudienceSchema = z.object({
  mode: z.enum(AUDIENCE_MODES),
  custom_audience_ids: z.array(metaId).max(PLAN_LIMITS.audiencesPerAdSet).default([]),
  excluded_audience_ids: z.array(metaId).max(PLAN_LIMITS.audiencesPerAdSet).default([]),
  countries: z.array(z.string().regex(/^[A-Z]{2}$/)).min(1).max(PLAN_LIMITS.countries),
  age_min: z.number().int(),
  age_max: z.number().int(),
}).strict()
export type PlanAudience = z.infer<typeof planAudienceSchema>

export const planAdSetSchema = z.object({
  key: z.string().regex(/^as\d{1,2}$/),
  name,
  /** ABO only; null under CBO. */
  daily_budget_minor: minorAmount.nullable(),
  optimization_goal: z.enum(OPTIMIZATION_GOALS),
  audience: planAudienceSchema,
  /** 'advantage_plus' leaves placements to Meta; otherwise the chosen platforms. */
  placements: z.union([z.literal('advantage_plus'), z.array(z.enum(PUBLISHER_PLATFORMS)).min(1)]),
  ads: z.array(planAdSchema).max(PLAN_LIMITS.adsPerAdSet),
}).strict()
export type PlanAdSet = z.infer<typeof planAdSetSchema>

export const campaignPlanSpecSchema = z.object({
  currency: z.string().regex(/^[A-Z]{3}$/),
  campaign: z.object({
    name,
    objective: z.enum(PLAN_OBJECTIVES),
    buying_type: z.literal('AUCTION'),
    budget_mode: z.enum(BUDGET_MODES),
    /** CBO only; null under ABO. */
    daily_budget_minor: minorAmount.nullable(),
    bid_strategy: z.enum(BID_STRATEGIES),
    /** COST_CAP only, and only as the owner typed it. */
    bid_amount_minor: minorAmount.nullable(),
  }).strict(),
  schedule: z.object({ start_date: isoDate, end_date: isoDate.nullable() }).strict(),
  /** The pixel (dataset) and event the conversion ad sets optimise for; null when none is configured. */
  conversion: z.object({ pixel_id: metaId, custom_event: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/) }).strict().nullable(),
  ad_sets: z.array(planAdSetSchema).min(1).max(PLAN_LIMITS.adSets),
}).strict()
export type CampaignPlanSpec = z.infer<typeof campaignPlanSpecSchema>

/** Sum of the plan's daily budgets in minor units (campaign under CBO, ad sets under ABO). */
export function planDailyBudgetMinor(spec: Pick<CampaignPlanSpec, 'campaign' | 'ad_sets'>): number {
  if (spec.campaign.budget_mode === 'CBO') return spec.campaign.daily_budget_minor ?? 0
  return spec.ad_sets.reduce((total, adSet) => total + (adSet.daily_budget_minor ?? 0), 0)
}

/** Every ad in plan order with its ad set. */
export function planAds(spec: Pick<CampaignPlanSpec, 'ad_sets'>): Array<{ adSet: PlanAdSet; ad: PlanAd }> {
  return spec.ad_sets.flatMap((adSet) => adSet.ads.map((ad) => ({ adSet, ad })))
}

/** Canonical JSON (sorted keys) so an identical spec always hashes the same. */
export function canonicalJson(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort)
    if (v !== null && typeof v === 'object') {
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, sort(x)]))
    }
    return v
  }
  return JSON.stringify(sort(value))
}

export type PlanStatus = 'draft' | 'pending_approval' | 'approved' | 'rejected' | 'creating' | 'created_paused' | 'failed' | 'superseded' | 'archived'

export const PLAN_STATUS_LABEL: Record<PlanStatus, string> = {
  draft: 'Draft', pending_approval: 'Pending approval', approved: 'Approved', rejected: 'Rejected', creating: 'Creating',
  created_paused: 'Created (paused)', failed: 'Failed', superseded: 'Superseded', archived: 'Archived',
}
