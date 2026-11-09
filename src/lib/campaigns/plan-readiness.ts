// ADR-062: the launch-readiness checklist shown beside every plan. PURE. It reuses the validator's
// findings and adds what a senior media buyer checks before going live: is the conversion signal there,
// can outcomes be joined back to the ads, is the audience size known, is there enough creative variety.
// "unknown" is its own state: a check that could not be made is never reported as passed.

import { missingUrlTagKeys, destinationProblem, type PlanValidation } from './plan-validation'
import { planAds, type CampaignPlanSpec } from './plan-spec'

export type ReadinessStatus = 'ok' | 'warn' | 'blocked' | 'unknown'

export interface ReadinessItem {
  id: 'conversion_signal' | 'destination' | 'tracking_tags' | 'budget' | 'audience_size' | 'creative_variety' | 'copy'
  label: string
  status: ReadinessStatus
  detail: string
}

export interface ReadinessContext {
  landingHosts: readonly string[]
  /** Synced creatives an ad may reuse: their link and url_tags. */
  creativeLinks: ReadonlyMap<string, { linkUrl: string | null; urlTags: string | null }>
  audienceSizes: ReadonlyMap<string, number | null>
  outcomeEvent: string
}

const SMALL_AUDIENCE = 1_000

function conversionSignal(spec: CampaignPlanSpec): ReadinessItem {
  const label = 'Conversion signal (pixel and event)'
  const needs = spec.ad_sets.some((s) => s.optimization_goal === 'OFFSITE_CONVERSIONS')
  if (!needs) return { id: 'conversion_signal', label, status: 'ok', detail: 'No ad set optimises for conversions, so no pixel event is needed.' }
  if (!spec.conversion) return { id: 'conversion_signal', label, status: 'blocked', detail: 'No pixel is synced for this ad account.' }
  return { id: 'conversion_signal', label, status: 'ok', detail: `Optimises for ${spec.conversion.custom_event} on pixel ${spec.conversion.pixel_id}. Check its recent volume in Events Manager before launch.` }
}

function destinations(spec: CampaignPlanSpec, ctx: ReadinessContext): [ReadinessItem, ReadinessItem] {
  let bad = 0
  let reusedOffHost = 0
  let unknown = 0
  let untagged = 0
  for (const { ad } of planAds(spec)) {
    const reusing = ad.creative.mode === 'existing_creative'
    const reused = reusing && ad.creative.mode === 'existing_creative' ? ctx.creativeLinks.get(ad.creative.creative_id) : null
    const url = reusing ? reused?.linkUrl ?? null : ad.destination_url
    const tags = reusing ? reused?.urlTags ?? null : ad.url_tags
    if (!url) unknown += 1
    // A new creative off your hosts is a validation blocker; a reused one keeps the link it already runs with.
    else if (destinationProblem(url, ctx.landingHosts)) { if (reusing) reusedOffHost += 1; else bad += 1 }
    if (tags === null || missingUrlTagKeys(tags).length > 0) untagged += 1
  }
  const destination: ReadinessItem = bad > 0
    ? { id: 'destination', label: 'Destination on your landing hosts', status: 'blocked', detail: `${bad} ad(s) point outside your landing hosts.` }
    : reusedOffHost > 0
      ? { id: 'destination', label: 'Destination on your landing hosts', status: 'warn', detail: `${reusedOffHost} reused creative(s) link outside your landing hosts, so their visits may not be captured. Build new ads from their images to set the link.` }
    : unknown > 0
      ? { id: 'destination', label: 'Destination on your landing hosts', status: 'unknown', detail: `${unknown} reused creative(s) have no synced link to check.` }
      : { id: 'destination', label: 'Destination on your landing hosts', status: 'ok', detail: 'Every ad points at one of your landing hosts.' }
  const tags: ReadinessItem = untagged > 0
    ? { id: 'tracking_tags', label: 'Tracking parameters (UTMs and Meta ids)', status: 'warn', detail: `${untagged} ad(s) lack the full UTM and Meta id parameters, so their outcomes cannot be joined to them.` }
    : { id: 'tracking_tags', label: 'Tracking parameters (UTMs and Meta ids)', status: 'ok', detail: 'Every ad carries the UTM and Meta id parameters.' }
  return [destination, tags]
}

function audienceSize(spec: CampaignPlanSpec, ctx: ReadinessContext): ReadinessItem {
  const label = 'Audience size known'
  const custom = spec.ad_sets.flatMap((s) => (s.audience.mode === 'custom' ? s.audience.custom_audience_ids : []))
  if (custom.length === 0) return { id: 'audience_size', label, status: 'ok', detail: 'Broad or Advantage+ audience: Meta finds the people, so no list size applies.' }
  const sizes = custom.map((id) => ctx.audienceSizes.get(id) ?? null)
  if (sizes.some((size) => size === null)) return { id: 'audience_size', label, status: 'unknown', detail: 'Meta withheld the size of at least one audience. A size of "20" or none is a placeholder, not a count.' }
  const smallest = Math.min(...(sizes as number[]))
  return smallest < SMALL_AUDIENCE
    ? { id: 'audience_size', label, status: 'warn', detail: `The smallest audience holds about ${smallest.toLocaleString('en-US')} people: delivery may stall.` }
    : { id: 'audience_size', label, status: 'ok', detail: 'Every selected audience has a known size.' }
}

function creativeVariety(spec: CampaignPlanSpec): ReadinessItem {
  const label = 'Creative count and variety'
  const ads = planAds(spec).map(({ ad }) => ad)
  const assets = new Set(ads.map((ad) => (ad.creative.mode === 'existing_creative' ? `c:${ad.creative.creative_id}` : ad.creative.mode === 'image' ? `i:${ad.creative.image_hash}` : `v:${ad.creative.video_id}`)))
  const angles = new Set(ads.map((ad) => ad.copy?.angle).filter(Boolean))
  const thin = spec.ad_sets.filter((s) => s.ads.length < 3).length
  if (ads.length === 0) return { id: 'creative_variety', label, status: 'blocked', detail: 'The plan has no ads.' }
  if (thin > 0 || assets.size < Math.min(3, ads.length)) {
    return { id: 'creative_variety', label, status: 'warn', detail: `${ads.length} ad(s), ${assets.size} distinct visual(s), ${angles.size} copy angle(s). Meta groups near-identical ads: aim for 3-6 distinct concepts per ad set.` }
  }
  return { id: 'creative_variety', label, status: 'ok', detail: `${ads.length} ads, ${assets.size} distinct visuals, ${angles.size} copy angles.` }
}

/** The checklist for one plan, from its validation and the account context. */
export function planReadiness(spec: CampaignPlanSpec, validation: PlanValidation, ctx: ReadinessContext): ReadinessItem[] {
  const budgetCodes = new Set(['budget_below_meta_minimum', 'over_account_ceiling', 'account_total_unknown', 'cbo_budget_missing', 'abo_budget_missing'])
  const budgetBlock = validation.issues.find((i) => budgetCodes.has(i.code))
  const budget: ReadinessItem = budgetBlock
    ? { id: 'budget', label: 'Budget sanity', status: budgetBlock.code === 'account_total_unknown' ? 'unknown' : 'blocked', detail: budgetBlock.message }
    : validation.stepOverrideRequired
      ? { id: 'budget', label: 'Budget sanity', status: 'warn', detail: `This plan adds ${validation.stepPercent}% to today's active account budget, above the per-change limit: submitting needs your explicit confirmation.` }
      : { id: 'budget', label: 'Budget sanity', status: 'ok', detail: 'Above Meta\'s minimum and within your account ceiling.' }
  const copyBlocks = validation.issues.filter((i) => i.code.startsWith('copy_')).length
  const copy: ReadinessItem = copyBlocks > 0
    ? { id: 'copy', label: 'Copy passes the scorer', status: 'blocked', detail: `${copyBlocks} copy finding(s) block launch: unverified claims, policy risk or Meta's hard limits.` }
    : { id: 'copy', label: 'Copy passes the scorer', status: 'ok', detail: 'No copy blocker. Reused creatives run with the copy they already have.' }
  return [conversionSignal(spec), ...destinations(spec, ctx), budget, audienceSize(spec, ctx), creativeVariety(spec), copy]
}
