// ADR-062: the owner-facing preview of a plan's creation: every object it will create, with every
// budget, and the fact that all of it stays PAUSED. PURE; `money` formats minor units in the account
// currency. The same text is stored on the change request the owner approves. Security review L7: each
// ad's header line is followed by detail lines (indented 6 spaces) carrying every value its creative
// sends to Meta: copy, call to action and link, media and thumbnail, and the url_tags. /changes shows
// them collapsible per ad.

import { planAds, planDailyBudgetMinor, type CampaignPlanSpec, type PlanAd, type PlanAdSet } from './plan-spec'

export type MinorFormatter = (minor: number) => string

function audienceLine(adSet: PlanAdSet): string {
  const a = adSet.audience
  const who = a.mode === 'custom' ? `custom audiences ${a.custom_audience_ids.join(', ')}` : a.mode === 'broad' ? 'broad audience' : 'Advantage+ audience'
  const excluded = a.excluded_audience_ids.length ? `, excluding ${a.excluded_audience_ids.join(', ')}` : ''
  const placements = adSet.placements === 'advantage_plus' ? 'Advantage+ placements' : `placements ${adSet.placements.join(', ')}`
  return `${who}${excluded}; ${a.countries.join(', ')}; ages ${a.age_min}-${a.age_max}; ${placements}`
}

function creativeLine(ad: PlanAd): string {
  const c = ad.creative
  if (c.mode === 'existing_creative') return `existing creative ${c.creative_id} (its own copy and link)`
  const visual = c.mode === 'image' ? `image ${c.image_hash}` : `video ${c.video_id}`
  return `new creative from ${visual}, CTA ${ad.copy?.cta ?? 'none'}, to ${ad.destination_url ?? 'no destination'}`
}

const DETAIL = '      '
/** A value on one detail line; a line break inside it stays inside the same ad's details. */
const detail = (label: string, value: string) => `${DETAIL}${label}: ${value.replace(/\r?\n/g, `\n${DETAIL}  `)}`

/** Every value of this ad's creative that Meta receives, one per line. */
export function adDetailLines(ad: PlanAd): string[] {
  const c = ad.creative
  if (c.mode === 'existing_creative') return [`${DETAIL}Runs creative ${c.creative_id} as it is: its own copy, link and URL parameters.`]
  const lines: string[] = []
  if (ad.copy) {
    lines.push(detail('Primary text', ad.copy.primary_text), detail('Headline', ad.copy.headline))
    if (ad.copy.description) lines.push(detail('Description', ad.copy.description))
    lines.push(detail('Call to action', ad.copy.cta))
  }
  lines.push(detail('Destination', ad.destination_url ?? 'none'))
  lines.push(c.mode === 'image' ? detail('Image', c.image_hash) : detail('Video', c.video_id))
  if (c.mode === 'video') lines.push(detail('Thumbnail', c.thumbnail_url ?? 'none (Meta chooses one)'))
  lines.push(detail('URL parameters', ad.url_tags || 'none'))
  return lines
}

/** One line per object, in creation order. */
export function planPreviewLines(spec: CampaignPlanSpec, money: MinorFormatter): string[] {
  const c = spec.campaign
  const budget = c.budget_mode === 'CBO' ? `campaign budget ${money(c.daily_budget_minor ?? 0)}/day` : 'ad set budgets'
  const bid = c.bid_strategy === 'COST_CAP' ? `cost cap ${money(c.bid_amount_minor ?? 0)}` : 'lowest cost'
  const ends = spec.schedule.end_date ? ` to ${spec.schedule.end_date}` : ', no end date'
  const lines = [`Create campaign "${c.name}" (${c.objective}, ${budget}, ${bid}; from ${spec.schedule.start_date}${ends}): PAUSED.`]
  spec.ad_sets.forEach((adSet, i) => {
    const own = adSet.daily_budget_minor === null ? '' : `, ${money(adSet.daily_budget_minor)}/day`
    const event = adSet.optimization_goal === 'OFFSITE_CONVERSIONS' && spec.conversion ? ` (${spec.conversion.custom_event}, pixel ${spec.conversion.pixel_id})` : ''
    lines.push(`  Ad set ${i + 1} "${adSet.name}"${own}: optimises for ${adSet.optimization_goal}${event}; ${audienceLine(adSet)}: PAUSED.`)
    adSet.ads.forEach((ad) => lines.push(`    Ad "${ad.name}": ${creativeLine(ad)}: PAUSED.`, ...adDetailLines(ad)))
  })
  return lines
}

/** The full preview stored on the change request. */
export function planPreview(spec: CampaignPlanSpec, money: MinorFormatter, extra: { projectedAccountMinor: number | null; ceilingMinor: number; stepOverride: boolean }): string {
  const ads = planAds(spec).length
  const total = planDailyBudgetMinor(spec)
  const summary = `Creates 1 campaign, ${spec.ad_sets.length} ad set(s) and ${ads} ad(s), every one PAUSED. Planned daily budget ${money(total)}.`
  const projected = extra.projectedAccountMinor === null ? '' : ` If you later turn it all on, the active account total would be ${money(extra.projectedAccountMinor)}/day (ceiling ${money(extra.ceilingMinor)}/day).`
  const override = extra.stepOverride ? ' You confirmed a budget step above the per-change limit.' : ''
  return [`${summary}${projected}${override} Nothing is activated: you turn it on in Meta Ads Manager when ready.`, ...planPreviewLines(spec, money)].join('\n')
}
