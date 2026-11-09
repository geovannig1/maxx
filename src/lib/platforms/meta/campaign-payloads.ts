// ADR-062: the Graph API request bodies that create a plan's objects. PURE, so the one property that
// matters most is testable without a network: every object is created with status PAUSED, and no body
// this module builds can carry ACTIVE. Budgets are already Meta minor units (the plan stores them so).
// Each name carries the object's stable marker, which is how a retry finds an object it created before
// its id was recorded, instead of creating a duplicate. The marker is bound to ONE creation request (its
// plan version and change request), never to the spec: two plans with an identical spec must never find
// each other's objects (security review H1). The database recomputes the same binding on every row.

import { createHash } from 'node:crypto'
import type { CampaignPlanSpec, PlanAd, PlanAdSet } from '@/lib/campaigns/plan-spec'

export type GraphBody = Record<string, string>

/** Meta's standard pixel events and their promoted_object.custom_event_type. Any other name is custom. */
const STANDARD_EVENTS: Record<string, string> = {
  Purchase: 'PURCHASE', Lead: 'LEAD', CompleteRegistration: 'COMPLETE_REGISTRATION', Schedule: 'SCHEDULE', Contact: 'CONTACT',
  SubmitApplication: 'SUBMIT_APPLICATION', AddToCart: 'ADD_TO_CART', InitiateCheckout: 'INITIATE_CHECKOUT', Subscribe: 'SUBSCRIBE',
  StartTrial: 'START_TRIAL', ViewContent: 'CONTENT_VIEW', Search: 'SEARCH', AddPaymentInfo: 'ADD_PAYMENT_INFO',
}

/** The per-request part of every marker: 12 hex of sha256("<plan version id>:<change request id>"). The
 *  same expression is checked in SQL by campaign_plan_objects_guard, so a row cannot carry another
 *  request's marker. */
export function markerSeed(planVersionId: string, changeRequestId: string): string {
  return createHash('sha256').update(`${planVersionId}:${changeRequestId}`).digest('hex').slice(0, 12)
}

/** The stable marker of one plan object: its request's seed and its plan key (at most 33 characters for
 *  the longest key, so a name stays far inside Meta's limits and is never truncated). */
export function objectMarker(seed: string, localKey: string): string {
  return `mx${seed}-${localKey.replace(/:/g, '-')}`
}

/** True when a name carries exactly this marker as its suffix (not merely contains it). */
export const hasExactMarker = (name: unknown, marker: string): boolean => typeof name === 'string' && name.endsWith(` [${marker}]`)

export const markedName = (name: string, marker: string) => `${name} [${marker}]`

/** Midnight (or the last second) of a date in a timezone, as an ISO string with its offset. */
export function zonedTime(date: string, timeZone: string, endOfDay = false): string {
  const [y, m, d] = date.split('-').map(Number)
  const utcGuess = Date.UTC(y, m - 1, d, endOfDay ? 23 : 0, endOfDay ? 59 : 0, endOfDay ? 59 : 0)
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .formatToParts(new Date(utcGuess)).reduce<Record<string, number>>((acc, p) => (p.type === 'literal' ? acc : { ...acc, [p.type]: Number(p.value) }), {})
  const asLocal = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second)
  const offsetMin = Math.round((asLocal - utcGuess) / 60_000)
  const sign = offsetMin >= 0 ? '+' : '-'
  const abs = Math.abs(offsetMin)
  const time = endOfDay ? '23:59:59' : '00:00:00'
  return `${date}T${time}${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`
}

export function campaignBody(spec: CampaignPlanSpec, marker: string): GraphBody {
  const c = spec.campaign
  const body: GraphBody = {
    name: markedName(c.name, marker), objective: c.objective, buying_type: c.buying_type, status: 'PAUSED', special_ad_categories: '[]',
  }
  if (c.budget_mode === 'CBO') {
    body.daily_budget = String(c.daily_budget_minor)
    body.bid_strategy = c.bid_strategy
  } else {
    body.is_adset_budget_sharing_enabled = 'false'
  }
  return body
}

export function promotedObject(spec: CampaignPlanSpec): Record<string, string> | null {
  if (!spec.conversion) return null
  const standard = STANDARD_EVENTS[spec.conversion.custom_event]
  return standard
    ? { pixel_id: spec.conversion.pixel_id, custom_event_type: standard }
    : { pixel_id: spec.conversion.pixel_id, custom_event_type: 'OTHER', custom_event_str: spec.conversion.custom_event }
}

export function targetingOf(adSet: PlanAdSet): Record<string, unknown> {
  const a = adSet.audience
  const targeting: Record<string, unknown> = {
    geo_locations: { countries: a.countries }, age_min: a.age_min, age_max: a.age_max,
    targeting_automation: { advantage_audience: a.mode === 'advantage_plus' ? 1 : 0 },
  }
  if (a.custom_audience_ids.length) {
    targeting.custom_audiences = a.custom_audience_ids.map((id) => ({ id }))
    // Without this Meta may widen a custom audience with lookalikes it never shows you.
    targeting.targeting_relaxation_types = { lookalike: 0, custom_audience: 0 }
  }
  if (a.excluded_audience_ids.length) targeting.excluded_custom_audiences = a.excluded_audience_ids.map((id) => ({ id }))
  if (adSet.placements !== 'advantage_plus') targeting.publisher_platforms = adSet.placements
  return targeting
}

export function adSetBody(spec: CampaignPlanSpec, adSet: PlanAdSet, campaignId: string, marker: string, timeZone: string): GraphBody {
  const body: GraphBody = {
    name: markedName(adSet.name, marker), campaign_id: campaignId, status: 'PAUSED', billing_event: 'IMPRESSIONS',
    optimization_goal: adSet.optimization_goal, targeting: JSON.stringify(targetingOf(adSet)),
    start_time: zonedTime(spec.schedule.start_date, timeZone),
  }
  if (spec.schedule.end_date) body.end_time = zonedTime(spec.schedule.end_date, timeZone, true)
  if (spec.campaign.budget_mode === 'ABO' && adSet.daily_budget_minor !== null) {
    body.daily_budget = String(adSet.daily_budget_minor)
    body.bid_strategy = spec.campaign.bid_strategy
  }
  if (spec.campaign.bid_strategy === 'COST_CAP' && spec.campaign.bid_amount_minor !== null) body.bid_amount = String(spec.campaign.bid_amount_minor)
  const promoted = adSet.optimization_goal === 'OFFSITE_CONVERSIONS' ? promotedObject(spec) : null
  if (promoted) body.promoted_object = JSON.stringify(promoted)
  if (adSet.optimization_goal === 'LANDING_PAGE_VIEWS') body.destination_type = 'WEBSITE'
  return body
}

/** A new creative from media already in the account, with the plan's copy. Null for a reused creative. */
export function creativeBody(ad: PlanAd, pageId: string, marker: string): GraphBody | null {
  const c = ad.creative
  if (c.mode === 'existing_creative' || !ad.copy || !ad.destination_url) return null
  const cta = { type: ad.copy.cta, value: { link: ad.destination_url } }
  const story = c.mode === 'image'
    ? { page_id: pageId, link_data: { link: ad.destination_url, message: ad.copy.primary_text, name: ad.copy.headline, description: ad.copy.description || undefined, image_hash: c.image_hash, call_to_action: cta } }
    : { page_id: pageId, video_data: { video_id: c.video_id, message: ad.copy.primary_text, title: ad.copy.headline, link_description: ad.copy.description || undefined, image_url: c.thumbnail_url ?? undefined, call_to_action: cta } }
  return { name: markedName(ad.name, marker), object_story_spec: JSON.stringify(story), url_tags: ad.url_tags }
}

export function adBody(ad: PlanAd, adSetId: string, creativeId: string, marker: string): GraphBody {
  return { name: markedName(ad.name, marker), adset_id: adSetId, creative: JSON.stringify({ creative_id: creativeId }), status: 'PAUSED' }
}

/** Last line of defence: refuse any body that would leave an object anything but paused. */
export function assertPaused(body: GraphBody): void {
  if ('status' in body && body.status !== 'PAUSED') throw new Error('campaign_creation_never_activates')
  const nested = /"(?:status|effective_status|configured_status)"\s*:\s*"(?!PAUSED")/
  if (Object.values(body).some((value) => nested.test(value))) throw new Error('campaign_creation_never_activates')
}
