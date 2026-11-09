import type { ReportEntity, ReportMetric, ReportObservation, ReportingData, ReportingContext } from './contracts'
import { creativeRetention } from './creative-retention'
import { META_RATIO_METRIC_DEFINITIONS } from './meta-metric-definitions'
import { comparable } from './review/evidence'
import { overviewNumber, type OverviewEvent } from './overview-model'

export type OverviewCreativeSort = 'spend' | 'results' | 'cpa'
type Options = { search?: string; sort?: OverviewCreativeSort; page?: number; pageSize?: number }
export const OVERVIEW_CREATIVE_COMPACT_PAGE_SIZE = 5
export const OVERVIEW_CREATIVE_DEFAULT_PAGE_SIZE = 25
export const OVERVIEW_CREATIVE_PAGE_SIZES = [5, 25] as const

export function overviewCreativePageSize(value?: number | string | null) {
  const parsed = typeof value === 'string' ? Number(value) : value
  return OVERVIEW_CREATIVE_PAGE_SIZES.includes(parsed as typeof OVERVIEW_CREATIVE_PAGE_SIZES[number])
    ? parsed as typeof OVERVIEW_CREATIVE_PAGE_SIZES[number]
    : OVERVIEW_CREATIVE_DEFAULT_PAGE_SIZE
}

export function overviewCreativeSelectionHref(currentHref: string, values: Record<string, string | null>): string {
  const location = new URL(currentHref, 'https://maxx.local')
  for (const [key, value] of Object.entries(values)) {
    if (value) location.searchParams.set(key, value)
    else location.searchParams.delete(key)
  }
  return `${location.pathname}${location.search}${location.hash}`
}

export function overviewCreativeContext(data: ReportingData): ReportingContext {
  return { ...data.context, asOf: data.meta.asOf ?? data.context.asOf }
}

const sameAsOf = (metric: ReportMetric, context: ReportingContext) => Date.parse(metric.current.asOf) === Date.parse(context.asOf)

export function overviewCreativeMetric(entity: ReportEntity, key: string, event?: OverviewEvent, context?: ReportingContext): ReportMetric | undefined {
  const metric = entity.metrics[key]
  return metric?.key === key && (!event || metric.event === event.label)
    && (!context || sameAsOf(metric, context)) ? metric : undefined
}

/** Keep the native validation and bind every input to this Meta observation. */
export function overviewCreativeRetention(entities: ReportEntity[], context: ReportingContext) {
  return creativeRetention(entities.map(entity => ({ ...entity,
    metrics: Object.fromEntries(Object.entries(entity.metrics).filter(([, metric]) => sameAsOf(metric, context))),
  })), context)
}

export function overviewCreativeRows(data: ReportingData, event: OverviewEvent, options: Options = {}): ReportEntity[] {
  const query = options.search?.trim().toLocaleLowerCase() ?? ''
  const context = overviewCreativeContext(data)
  const key = options.sort === 'cpa' ? event.cpa : options.sort === 'results' ? event.count : 'spend'
  return (data.meta.data?.entities ?? []).filter(entity => entity.level === 'ad' && (!query || [entity.id, entity.name,
    entity.adsetId, entity.adsetName, entity.campaignId, entity.campaignName, entity.creative?.id,
    entity.creative?.headline, entity.creative?.body].some(value => value?.toLocaleLowerCase().includes(query))))
    .sort((a, b) => {
      const x = overviewNumber(overviewCreativeMetric(a, key, key === 'spend' ? undefined : event, context))
      const y = overviewNumber(overviewCreativeMetric(b, key, key === 'spend' ? undefined : event, context))
      if (x === null || y === null) return x === y ? a.id.localeCompare(b.id) : x === null ? 1 : -1
      return (options.sort === 'cpa' ? x - y : y - x) || a.id.localeCompare(b.id)
    })
}

export function overviewCreativePage(data: ReportingData, event: OverviewEvent, options: Options = {}) {
  const rows = overviewCreativeRows(data, event, options)
  const pageSize = overviewCreativePageSize(options.pageSize)
  const pages = Math.max(1, Math.ceil(rows.length / pageSize))
  const requested = Number.isFinite(options.page) ? Math.trunc(options.page!) : 1
  const page = Math.max(1, Math.min(pages, requested))
  return { rows: rows.slice((page - 1) * pageSize, page * pageSize), page, pages, pageSize,
    filtered: rows.length, total: (data.meta.data?.entities ?? []).filter(entity => entity.level === 'ad').length }
}

function eligible(entity: ReportEntity, metric: ReportMetric | undefined, context: ReportingContext): boolean {
  const claim = metric?.current
  return !!claim && overviewNumber(metric) !== null && overviewNumber(metric)! >= 0
    && claim.entity.level === 'ad' && claim.entity.id === entity.id && claim.source.system === 'meta'
    && claim.source.role === 'delivery_truth' && claim.source.evidencePlane === 'meta_delivery'
    && claim.window.start === context.range.from && claim.window.end === context.range.to
    && claim.window.timezone === context.timezone && claim.window.basis === 'impression_date_et'
    && claim.coverage.state === 'complete' && claim.freshness.state === 'fresh' && claim.maturity.state !== 'partial'
    && sameAsOf(metric!, context)
}

export function overviewCreativeFocus(data: ReportingData, event: OverviewEvent) {
  const context = overviewCreativeContext(data)
  const rows = overviewCreativeRows(data, event)
  const supported = rows.filter(entity => eligible(entity, overviewCreativeMetric(entity, event.count, event), context))
  const mostResults = [...supported].filter(entity => overviewNumber(entity.metrics[event.count])! > 0)
    .sort((a, b) => overviewNumber(b.metrics[event.count])! - overviewNumber(a.metrics[event.count])!)[0] ?? null
  const cpaSupported = supported.filter(entity => overviewNumber(entity.metrics[event.count])! > 0
    && eligible(entity, overviewCreativeMetric(entity, event.cpa, event), context))
  const lowestCpa = [...cpaSupported].sort((a, b) => overviewNumber(a.metrics[event.cpa])! - overviewNumber(b.metrics[event.cpa])!)[0] ?? null
  const retention = overviewCreativeRetention(supported, context).map(row => ({ entity: row.entity, halfway: row.points[1].value }))
    .filter((row): row is { entity: ReportEntity; halfway: number } => row.halfway !== null)
    .sort((a, b) => b.halfway - a.halfway)
  let contrast: { higherAttention: ReportEntity; lowerAttention: ReportEntity } | null = null
  for (const higher of retention) {
    const lower = retention.find(candidate => candidate.halfway < higher.halfway
      && overviewNumber(candidate.entity.metrics[event.count])! > overviewNumber(higher.entity.metrics[event.count])!
      && comparable(higher.entity.metrics[event.count], candidate.entity.metrics[event.count])
      && comparable(higher.entity.metrics.retention_p50, candidate.entity.metrics.retention_p50))
    if (lower) { contrast = { higherAttention: higher.entity, lowerAttention: lower.entity }; break }
  }
  return { mostResults, lowestCpa, contrast,
    population: { supplied: rows.length, resultsEligible: supported.length, cpaEligible: cpaSupported.length, contrastEligible: retention.length } }
}

export function overviewCreativeFocusDescriptions(event: OverviewEvent) {
  const shared = `for this selected date range, timezone, and Meta as-of time. The displayed count is comparability coverage, not a performance threshold. No minimum conversion count is applied.`
  return {
    results: `Most results compares supplied ads with a complete, fresh Meta ad-level ${event.label} count ${shared}`,
    cpa: `Lowest CPA additionally requires a positive ${event.label} count and an available CPA under the same ad-level evidence scope. No minimum conversion count is applied.`,
    contrast: `Attention vs results requires comparable halfway-view and ${event.label} count evidence for the same ad-level period and Meta as-of time. No minimum conversion count is applied.`,
  }
}

export type OverviewCreativeReconciliation = {
  state: 'supported' | 'incomplete'
  label: string
  detail: string
}

/** Join a withheld claim only to its exact campaign/period reconciliation record. */
export function overviewCreativeReconciliation(
  entity: ReportEntity,
  metric: ReportMetric | undefined,
  event: OverviewEvent,
  context: ReportingContext,
  observations: readonly ReportObservation[],
): OverviewCreativeReconciliation | null {
  const claim = metric?.current
  if (!metric || (metric.key !== event.cpa && metric.key !== event.roas) || !claim || claim.availability.state !== 'unavailable'
    || !claim.availability.blockerCodes.includes('meta_outcome_hierarchy_unreconciled')) return null

  const metricKind = metric.key === event.cpa ? 'CPA' : metric.key === event.roas ? 'ROAS' : metric.label
  const comparison = metric.key === event.cpa ? 'a cost-per-result comparison' : 'an efficiency ranking'
  const campaignId = entity.campaignId?.trim() || null
  const exactClaim = metric.event === event.label
    && claim.entity.level === 'ad' && claim.entity.id === entity.id
    && claim.window.start === context.range.from && claim.window.end === context.range.to
    && claim.window.timezone === context.timezone && claim.window.basis === 'impression_date_et'
    && Date.parse(claim.asOf) === Date.parse(context.asOf)
  const evidence = exactClaim && campaignId ? observations.map(observation => {
    const issues = observation.detail.match(/\(([^)]*)\)/)?.[1].split(',').map(issue => issue.trim().toLocaleLowerCase()) ?? []
    const incomplete = issues.some(issue => issue.includes('authority_unavailable') || issue.includes('payload_invalid') || issue.includes('_unavailable'))
    const eventIssues = issues.filter(issue => event.label === 'Purchase'
      ? issue.includes('purchase_') && issue.includes('unreconciled')
      : !issue.includes('purchase_') && (issue.includes('mismatch') || issue.includes('unreconciled')))
    const supportedIssues = event.label === 'Purchase' && metric.key === event.cpa
      ? eventIssues.filter(issue => issue.includes('purchase_count'))
      : eventIssues
    const exactObservation = observation.id === `hierarchy:current:${campaignId}`
      && observation.entityId === campaignId
      && Date.parse(observation.observedAt ?? '') === Date.parse(context.asOf)
      && observation.detail.includes(`current campaign ${campaignId} outcome hierarchy could not be reconciled`)
    return { observation, supportedIssues, valid: exactObservation && !incomplete && supportedIssues.length > 0 }
  }).find(candidate => candidate.valid) : undefined

  if (!evidence) return {
    state: 'incomplete',
    label: 'Withheld · reconciliation evidence incomplete',
    detail: `The ${metricKind} claim is withheld, but an exact current-period reconciliation record for this ad’s campaign and selected event was not supplied. This reported ${metricKind} cannot support ${comparison} for this period.`,
  }

  const campaign = entity.campaignName?.trim() || `campaign ${campaignId}`
  const reasons = [...new Set(evidence.supportedIssues.map(issue => issue.includes('value')
    ? `${event.label} reported values`
    : issue.includes('click_bookings') || issue.includes('view_bookings') || issue.includes('attribution')
      ? `${event.label} click/view attribution counts`
      : `${event.label} result counts`))]
  return {
    state: 'supported',
    label: 'Withheld · campaign totals disagree',
    detail: `${event.label} ${metricKind} is withheld for ${campaign} during ${context.range.from} – ${context.range.to} because ${reasons.join(' and ')} do not reconcile between the campaign and its lower-level rows. This campaign’s reported ${metricKind} cannot support ${comparison} for this period. Other campaigns and periods are evaluated separately.`,
  }
}

export function overviewCreativeFormat(entity: ReportEntity): string {
  const creative = entity.creative
  if (!creative || creative.format === 'unknown') return 'Format unavailable'
  if (creative.format !== 'video') return creative.format === 'carousel' ? 'Carousel preview' : 'Image'
  return creative.durationSeconds === null ? 'Video · duration unavailable' : `${creative.durationSeconds} s video`
}

export function overviewCreativeAmbiguity(entity: ReportEntity): string | null {
  const identity = entity.creative?.identity
  if (!identity) return 'Preview assignment is unverified for this period.'
  return identity.structure !== 'single' || identity.members.filter(member => member.role === 'media').length !== 1
    ? 'Ad results cover all delivered variants; this preview cannot isolate an individual variant’s results.' : null
}

export function overviewCreativeUnavailable(metric?: ReportMetric, entity?: ReportEntity): string {
  if (!metric) return 'This metric was not supplied for this ad.'
  const ratio = META_RATIO_METRIC_DEFINITIONS.find(definition => definition[0] === metric.key)
  const denominator = ratio && entity?.metrics[ratio[3]]
  if (denominator && overviewNumber(denominator) === 0) return `${denominator.label} is measured zero; this metric cannot be calculated.`
  if (ratio) return 'The required inputs were not supplied with complete coverage for this ad and period.'
  return 'Meta did not supply a usable measure for this ad and period.'
}
