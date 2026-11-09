import { formatMoneyTrim } from '@/lib/utils/format-currency'
import type { ReportEntity, ReportFinding, ReportMetric, ReportMetricMap, ReportingData } from './contracts'

type Row = { id: string; name: string; metrics: ReportMetricMap; entity?: ReportEntity }
type Selection = { rows: Row[]; reason: string; score: number; contrast: boolean; focus?: string[] }
const EXPOSURE = ['spend', 'impressions']
const OUTCOMES = ['bookings', 'cost_per_booking', 'purchase_count', 'purchase_roas']
const WATCH = ['retention_p50', 'average_watch_seconds', 'video_2s', 'engagements', 'outbound_ctr']
const CLICKS = ['outbound_ctr', 'outbound_clicks', 'landing_page_views', 'bookings']

function numeric(metric?: ReportMetric, prior = false): number | null {
  const claim = prior ? metric?.previous : metric?.current
  return claim?.availability.state === 'available' && typeof claim.value === 'number' && Number.isFinite(claim.value) ? claim.value : null
}
function display(metric: ReportMetric, prior = false): string {
  const value = numeric(metric, prior)
  if (value === null) return 'unavailable'
  const unit = (prior ? metric.previous : metric.current)?.unit
  const suffix = unit === 'percent' ? '%' : unit === 'ratio' ? '×' : unit === 'seconds' ? ' seconds' : ''
  return `${unit === 'money' ? formatMoneyTrim(value) : value.toLocaleString('en-US', { maximumFractionDigits: 2 })}${suffix}`
}
function select(metrics: ReportMetricMap | undefined, keys: readonly string[]): ReportMetric[] {
  return [...new Set(keys)].flatMap(key => metrics?.[key] && numeric(metrics[key]) !== null ? [metrics[key]] : [])
}
function comparable(a?: ReportMetric, b?: ReportMetric, prior = false): boolean {
  const x = a?.current, y = prior ? b?.previous : b?.current
  if (!x || !y || numeric(a) === null || numeric(b, prior) === null) return false
  if ([x, y].some(claim => claim.coverage.state !== 'complete' || claim.freshness.state === 'stale' || claim.maturity.state === 'partial')) return false
  return a?.event === b?.event && x.measurementKind === y.measurementKind && x.metricKey === y.metricKey && x.unit === y.unit && x.source.system === y.source.system
    && x.attributionScope === y.attributionScope && x.window.basis === y.window.basis && x.window.timezone === y.window.timezone
    && (prior ? x.entity.id === y.entity.id && a?.current.comparison.window?.start === y.window.start
      && a?.current.comparison.window?.end === y.window.end
      : x.window.start === y.window.start && x.window.end === y.window.end && x.entity.level === y.entity.level)
}
// Dimensionless distance orders observed contrasts; it is not a significance or materiality threshold.
function distance(a: number, b: number): number { return a === b ? 0 : Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b)) }
function change(metric: ReportMetric): number {
  return comparable(metric, metric, true) ? distance(numeric(metric)!, numeric(metric, true)!) : 0
}
function describe(metrics: ReportMetric[]): string {
  return metrics.map(metric => `${metric.label}: ${display(metric)} (previous ${comparable(metric, metric, true) ? display(metric, true) : 'unavailable'})`).join('; ')
}
function limits(metrics: ReportMetric[]): string {
  const claims = metrics.flatMap(metric => [metric.current, ...(metric.previous ? [metric.previous] : [])])
  return [claims.some(c => c.coverage.state === 'partial') ? 'Partial evidence; observed counts or amounts may be incomplete.' : '',
    claims.some(c => c.coverage.state === 'unknown') ? 'Coverage unverified.' : '',
    claims.some(c => c.freshness.state === 'stale') ? 'Stale evidence.' : claims.some(c => c.freshness.state === 'unknown') ? 'Freshness unverified.' : '',
    claims.some(c => c.maturity.state === 'settling') ? 'Recent Meta outcomes are settling and may be revised.' : '',
    claims.some(c => c.maturity.state === 'partial') ? 'Partial period.' : '',
  ].filter(Boolean).join(' ')
}
function periodReview(metrics: ReportMetric[]): { status: ReportFinding['status']; detail: string; score: number } {
  if (!metrics.length) return { status: 'unavailable', detail: 'Evidence unavailable.', score: 0 }
  const matched = metrics.filter(metric => comparable(metric, metric, true))
  const changed = [...matched].sort((a, b) => change(b) - change(a) || a.key.localeCompare(b.key)).find(metric => change(metric) > 0)
  const unknown = matched.length < metrics.length ? ' Some prior comparison unavailable; missing or incompatible evidence stays unknown.' : ''
  if (changed) return { status: 'observed', detail: `Largest matched relative change: ${changed.label}, ${display(changed, true)} to ${display(changed)}.${unknown}`, score: change(changed) }
  return matched.length === metrics.length
    ? { status: 'no_notable_difference', detail: 'No notable measured difference: available matched measures are unchanged.', score: 0 }
    : { status: 'observed', detail: 'Prior comparison unavailable for one or more measures; a change cannot be established.', score: 0 }
}

/** Consider extrema and the largest matched change of each measure, across all returned rows.
 * This bounds comparison work without a sample cutoff or selecting entities by spend alone. */
function candidates(rows: Row[], keys: readonly string[]): Row[] {
  const selected = new Map<string, Row>()
  for (const key of keys) {
    const measured = rows.filter(row => numeric(row.metrics[key]) !== null)
      .sort((a, b) => numeric(a.metrics[key])! - numeric(b.metrics[key])! || a.id.localeCompare(b.id))
    const changed = [...measured].sort((a, b) => change(b.metrics[key]) - change(a.metrics[key]) || a.id.localeCompare(b.id))[0]
    for (const row of [measured[0], measured.at(-1), changed]) if (row) selected.set(row.id, row)
  }
  return [...selected.values()]
}
function investigate(rows: Row[], keys: readonly string[], opposite?: [string, string], differentCohorts = false): Selection {
  const pool = differentCohorts
    ? ['warm', 'cold', 'mixed', 'unknown'].flatMap(cohort => candidates(rows.filter(row => row.entity?.audience === cohort), keys))
    : candidates(rows, keys)
  let best: Selection = { rows: [], reason: '', score: -1, contrast: false }
  for (const row of pool) {
    const metrics = select(row.metrics, keys)
    const review = periodReview(metrics)
    const leading = [...metrics].sort((a, b) => change(b) - change(a))[0]
    if (review.score > best.score) best = { rows: [row], reason: review.detail, score: review.score, contrast: false, focus: leading ? [leading.key] : [] }
  }
  for (const [index, a] of pool.entries()) for (const b of pool.slice(index + 1)) {
    if (differentCohorts && (a.entity?.audience === 'unknown' || b.entity?.audience === 'unknown' || a.entity?.audience === b.entity?.audience)) continue
    const shared = keys.filter(key => comparable(a.metrics[key], b.metrics[key]))
    const key = [...shared].sort((x, y) => distance(numeric(a.metrics[y])!, numeric(b.metrics[y])!) - distance(numeric(a.metrics[x])!, numeric(b.metrics[x])!))[0]
    if (!key) continue
    const contrast = distance(numeric(a.metrics[key])!, numeric(b.metrics[key])!)
    if (!contrast) continue
    const diverges = opposite && opposite.every(field => shared.includes(field))
      && (numeric(a.metrics[opposite[0]])! - numeric(b.metrics[opposite[0]])!) * (numeric(a.metrics[opposite[1]])! - numeric(b.metrics[opposite[1]])!) < 0
    const score = (diverges ? 2 : 1) + contrast
    if (score > best.score) best = { rows: [a, b], score, contrast: true, focus: diverges ? opposite : [key],
      reason: diverges ? `${a.metrics[opposite![0]].label} and ${a.metrics[opposite![1]].label} order these rows differently.`
        : `Largest measured relative contrast: ${a.metrics[key].label}.` }
  }
  return best
}
function rowMetrics(selection: Selection, keys: readonly string[]): ReportMetric[] {
  return selection.rows.flatMap(row => select(row.metrics, keys))
}
function rowDetails(selection: Selection, keys: readonly string[]): string {
  return selection.rows.map(row => `${row.name}: ${describe(select(row.metrics, keys))}.`).join(' ')
}
function entityFilters(selection: Selection, group: string): Record<string, string> {
  const entities = selection.rows.flatMap(row => row.entity ? [row.entity] : [])
  if (entities.length === 2) return { group, level: entities[0].level, view: 'compare', compare: entities.map(entity => entity.id).join(',') }
  const entity = entities[0]
  return { group, ...(entity?.level === 'ad' ? { ad: entity.id } : entity?.level === 'adset' ? { adset: entity.id, level: 'ad' } : entity ? { campaign: entity.id, level: 'adset' } : {}) }
}

function shortLimits(metrics: ReportMetric[]): string {
  const claims = metrics.flatMap(metric => [metric.current, ...(metric.previous ? [metric.previous] : [])])
  const flags = [claims.some(c => c.coverage.state === 'partial') ? 'Partial evidence' : '',
    claims.some(c => c.coverage.state === 'unknown') ? 'coverage unverified' : '',
    claims.some(c => c.freshness.state === 'stale') ? 'stale evidence' : '',
    claims.some(c => c.maturity.state === 'settling') ? 'attribution settling' : '',
    claims.some(c => c.maturity.state === 'partial') ? 'partial period' : ''].filter(Boolean)
  return flags.length ? ` [${flags.join('; ')}]` : ''
}
function summary(selection: Selection, metrics: ReportMetric[], preferred: string[], source: string, includeReason = true): string {
  if (!metrics.length) return `${source} evidence unavailable for this selection.`
  const focus = selection.focus ?? [...metrics].sort((a, b) => change(b) - change(a)).slice(0, 1).map(metric => metric.key)
  const keys = [...new Set([...focus, ...(selection.rows.length ? ['impressions'] : []), ...preferred])]
  const text = selection.rows.length
    ? selection.rows.map(row => `${source} · ${row.name}${row.entity?.level === 'adset' ? ` · ${row.entity.audienceLabel}` : ''}: ${describe(select(row.metrics, keys).slice(0, 3))}.`).join(' ')
    : `${source}: ${describe(keys.flatMap(key => { const metric = metrics.find(metric => metric.key === key); return metric ? [metric] : [] }).slice(0, 3))}.`
  return `${text}${selection.contrast && includeReason ? ` ${selection.reason}` : ''}${shortLimits(metrics)}`
}

/** Inspectable ranking: usable measured contrasts/changes, then other usable performance,
 * then coverage, then unavailable checks. Ties retain the seven-area order below.
 * No inferred causes, synthetic source joins, benchmark thresholds or buying actions. */
export function deriveReportFindings(data: ReportingData): ReportFinding[] {
  const meta = data.meta.data
  const link = (path: string, filters: Record<string, string> = {}) => `${path}?${new URLSearchParams({ from: data.context.range.from, to: data.context.range.to, ...filters })}`
  function make(area: ReportFinding['area'], title: string, detail: string, metrics: ReportMetric[], href: string, selection?: Selection, observation = false): ReportFinding {
    const review = periodReview(metrics)
    const status = selection?.contrast || observation ? 'observed' : review.status
    const dates = `${data.context.range.from}–${data.context.range.to}; prior ${data.context.comparison.from}–${data.context.comparison.to} · ${data.context.timezone}.`
    const labels: Record<string, string> = { meta: 'Meta attributed estimates', outcomes: 'Outcomes, all sources', ga4: 'GA4 website', first_party_attribution: 'First-party paid association', capi: 'CAPI transport' }
    const sources = [...new Set(metrics.map(metric => labels[metric.current.source.system] ?? metric.current.source.system))].join(' / ')
    return { id: area, area, title, status, metrics, href,
      importance: metrics.length ? 100 + Math.max(review.score, selection?.score ?? 0) : observation ? 10 : 0,
      detail: [detail, metrics.length ? selection?.contrast && review.status === 'no_notable_difference' ? 'Matched prior-period measures are unchanged; this contrast is between current rows.' : review.detail : '', limits(metrics), sources, dates].filter(Boolean).join(' ') }
  }
  const entities = (meta?.entities ?? []).map(entity => ({ id: entity.id, name: entity.name, metrics: entity.metrics, entity }))
  const ads = entities.filter(row => row.entity.level === 'ad')
  const sets = entities.filter(row => row.entity.level === 'adset')
  // Keep hierarchy cohorts separate; do not double-count campaigns, ad sets and ads.
  const allocation = investigate(ads.length ? ads : sets, ['spend', ...OUTCOMES], ['spend', 'bookings'])
  const resultKeys = [...EXPOSURE, ...OUTCOMES]
  const accountFallback = allocation.rows.length && !rowMetrics(allocation, ['bookings', 'purchase_count']).length ? select(meta?.metrics, resultKeys) : []
  const resultMetrics = allocation.rows.length ? [...rowMetrics(allocation, resultKeys), ...accountFallback] : select(meta?.metrics, resultKeys)
  const results = make('results', 'Spend and reported outcomes', resultMetrics.length
    ? `${allocation.rows.length ? `${allocation.contrast ? allocation.reason : ''} ${rowDetails(allocation, resultKeys)}` : describe(resultMetrics)}${accountFallback.length ? ` Meta account results: ${describe(accountFallback)}. Ad-level outcomes unavailable; account outcomes are not assigned to an ad.` : ''} Meta event outcomes remain distinct; exposure and observed costs are shown together.`
    : 'Meta results cannot be measured for this period. Inspect the source status and retry.', resultMetrics,
  link('/performance', entityFilters(allocation, 'results')), allocation)

  const attention = investigate(ads.filter(row => row.entity.creative), [...WATCH, 'bookings', 'spend'], ['outbound_ctr', 'bookings'])
  const attentionKeys = [...EXPOSURE, 'video_plays', ...WATCH, 'bookings']
  const attentionMetrics = rowMetrics(attention, attentionKeys)
  const attentionFinding = make('attention', attention.rows.length === 1 ? `Attention: ${attention.rows[0].name}` : 'Creative attention and response', attention.rows.length
    ? `${attention.contrast ? attention.reason : ''} ${rowDetails(attention, attentionKeys)} ${attention.rows.map(row => `${row.name}: ${row.entity?.creative?.format ?? 'unknown'} format`).join('; ')}. Watch depth applies to video; exposure and video plays contextualize the reported measures.`
    : 'No asset has a measured attention or measured spend value for this period. Missing video measures do not establish absent attention.', attentionMetrics,
  link('/creative', entityFilters(attention, 'engagement')), attention)

  const clickSelection = investigate(ads.filter(row => select(row.metrics, CLICKS.slice(0, 3)).length > 0), [...CLICKS, 'spend'], ['outbound_ctr', 'bookings'])
  const clickKeys = [...EXPOSURE, ...CLICKS]
  const clickMetrics = clickSelection.rows.length ? rowMetrics(clickSelection, clickKeys)
    : select(meta?.metrics, CLICKS.slice(0, 3)).length ? select(meta?.metrics, [...CLICKS, 'outbound_cpc']) : []
  const clicks = make('click_quality', 'Clicks alongside reported bookings', clickMetrics.length
    ? `${clickSelection.contrast ? clickSelection.reason : ''} ${clickSelection.rows.length ? rowDetails(clickSelection, clickKeys) : describe(clickMetrics)} Click and booking differences are observations, not evidence of a cause; link clicks do not substitute for outbound clicks.`
    : 'Outbound and landing-page evidence is unavailable. Link clicks cannot substitute for outbound clicks.', clickMetrics,
  link('/performance', entityFilters(clickSelection, 'clicks')), clickSelection)

  const audienceSelection = investigate(sets, ['spend', 'bookings', 'frequency'], ['spend', 'bookings'], true)
  const audienceKeys = [...EXPOSURE, 'bookings', 'frequency']
  const audienceMetrics = rowMetrics(audienceSelection, audienceKeys)
  const audience = make('audience', 'Targeting cohorts and spend', audienceSelection.rows.length
    ? `${audienceSelection.contrast ? audienceSelection.reason : ''} ${rowDetails(audienceSelection, audienceKeys)} ${audienceSelection.rows.map(row => `${row.name}: ${row.entity?.audienceLabel}; ${row.entity?.status}; current targeting observed ${row.entity?.configurationAsOf ?? 'at an unknown time'}`).join('. ')}. Current targeting does not establish the historical setup; unresolved targeting is not cold.`
    : 'Ad-set spend and targeting cannot be compared from the returned evidence. Names alone do not establish warm or cold targeting.', audienceMetrics,
  link('/performance', entityFilters(audienceSelection, 'results')), audienceSelection)

  const deliverySelection = investigate(sets, ['cpm', 'frequency', 'reach', 'spend'])
  const observation = meta?.observations.find(item => item.kind === 'quality') ?? meta?.observations.find(item => item.kind === 'delivery' && deliverySelection.rows.some(row => row.id === item.entityId)) ?? meta?.observations.find(item => item.kind === 'delivery')
  const observedEntity = entities.find(row => row.id === observation?.entityId)
  const deliveryMetrics = deliverySelection.rows.length ? rowMetrics(deliverySelection, ['spend', 'impressions', 'reach', 'frequency', 'cpm']) : select(meta?.metrics, ['reach', 'frequency', 'cpm'])
  const delivery = make('delivery', observation?.title ?? 'Delivery and auction observations', [
    deliverySelection.rows.length ? `${deliverySelection.contrast ? deliverySelection.reason : ''} ${rowDetails(deliverySelection, ['spend', 'impressions', 'reach', 'frequency', 'cpm'])}` : describe(deliveryMetrics),
    observation ? `${observation.detail} Observed ${observation.observedAt ?? 'at an unknown time'}. Current setup is separate from historical delivery.` : 'Configuration explanation unavailable; native period reach and frequency are not summed from days.',
  ].filter(Boolean).join(' '), deliveryMetrics,
  link('/performance', entityFilters(observedEntity ? { rows: [observedEntity], reason: '', score: 0, contrast: false } : deliverySelection, 'delivery')), deliverySelection, !!observation)

  const measurement = data.measurement?.data
  const paidMetrics = select(measurement?.paidAssociation, ['linked_value_bearing_bookings'])
  const capiMetrics = select(measurement?.capi, ['eligible_website_confirmations', 'accepted_live_confirmations', 'origin_unknown_confirmations', 'legacy_stamp_unverified'])
  const web = data.website.data
  const pages: Row[] = (web?.rows ?? []).map(row => ({ id: row.id, name: `${row.landingPage} · ${row.device} · ${row.channel}`, metrics: row.metrics }))
  const pageSelection = investigate(pages, ['engagement_rate', 'sessions', 'intent_events', 'confirmation_events'])
  const webKeys = ['sessions', 'engaged_sessions', 'engagement_rate', 'intent_events', 'confirmation_events']
  const webMetrics = pageSelection.rows.length ? rowMetrics(pageSelection, webKeys) : select(web?.metrics, webKeys)
  const businessMetrics = select(data.business.data?.metrics, ['paid_bookings', 'amount_paid', 'active_appointments', 'booked_value'])
  const journey = make('journey', 'Website response and business results', [
    webMetrics.length ? `GA4: ${pageSelection.contrast ? pageSelection.reason : ''} ${pageSelection.rows.length ? rowDetails(pageSelection, webKeys) : describe(webMetrics)}` : 'GA4 website evidence unavailable; page and device differences cannot be measured.',
    businessMetrics.length ? `Outcomes, all sources: ${describe(businessMetrics)}.` : 'Outcome business results unavailable.',
    paidMetrics.length ? `First-party linked paid evidence, observed lower bound: ${describe(paidMetrics)}. ${(measurement?.paidAssociationNotes ?? []).join(' ')}` : measurement?.paidAssociationNotes.join(' ') ?? '',
    'These are separate populations; no joined conversion rate or paid attribution is inferred. Page rows retain their device and channel context. Unreturned page/device or booking-event measures remain unavailable.',
  ].join(' '), [...webMetrics, ...businessMetrics, ...paidMetrics], link('/reports', { report: 'website' }), pageSelection)

  const sourceNames = { meta: 'Meta', business: 'Outcomes', website: 'GA4' } as const
  const issues = (Object.keys(sourceNames) as Array<keyof typeof sourceNames>).flatMap(source => {
    const section = data[source]
    return section.state !== 'available' || section.notes.length ? [`${sourceNames[source]}: ${section.state}${section.notes.length ? ` — ${section.notes.join(' ')}` : ''}`] : []
  })
  const allMetrics = [...paidMetrics, ...capiMetrics, ...Object.values(meta?.metrics ?? {}), ...entities.flatMap(row => Object.values(row.metrics)), ...Object.values(data.business.data?.metrics ?? {}), ...Object.values(web?.metrics ?? {}), ...pages.flatMap(row => Object.values(row.metrics))]
  const coverage = { ...make('coverage', 'Coverage and comparison limits', [
    issues.length ? issues.join(' ') : 'All three primary source sections returned data; missing individual measures remain unknown.', limits(allMetrics),
    data.measurement ? `Paid association / CAPI: ${data.measurement.state}; evidence as of ${data.measurement.asOf ?? 'unavailable'}. ${data.measurement.notes.join(' ')}` : '',
    ...(measurement?.paidAssociationNotes ?? []), ...(measurement?.capiNotes ?? []),
    capiMetrics.length ? `CAPI transport observations: ${describe(capiMetrics)}. Receipts do not establish ad attribution or complete paid coverage.` : '',
    `Evidence as of ${Object.entries(sourceNames).map(([key, name]) => `${name}: ${data[key as keyof typeof sourceNames].asOf ?? 'unavailable'}`).join('; ')}.`,
    'Review order: measured contrasts and matched relative changes, other usable performance, coverage, then unavailable checks. No significance threshold is applied.',
  ].filter(Boolean).join(' '), capiMetrics, link('/reports'), undefined, true), importance: 10 }
  const empty: Selection = { rows: [], reason: '', score: 0, contrast: false }
  const resultSummary = accountFallback.length
    ? `${summary(empty, accountFallback, ['bookings', 'spend', 'purchase_count'], 'Meta account', false)} Ad-level outcomes unavailable; ${allocation.rows.map(row => `${row.name}: ${describe(select(row.metrics, ['spend']).slice(0, 1))}`).join('; ')}.`
    : summary(allocation, resultMetrics, ['bookings', 'spend', 'purchase_count'], 'Meta')
  const businessSummary = businessMetrics.length ? `Outcomes, all sources: ${describe(businessMetrics.slice(0, 2))}` : ''
  const paidSummary = paidMetrics.length ? `linked paid lower bound: ${describe(paidMetrics)}` : ''
  const summaries: Record<ReportFinding['area'], string> = {
    results: resultSummary,
    attention: summary(attention, attentionMetrics, [...WATCH, 'spend', 'bookings'], 'Meta'),
    click_quality: summary(clickSelection, clickMetrics, ['bookings', 'outbound_ctr', 'outbound_clicks'], 'Meta'),
    audience: summary(audienceSelection, audienceMetrics, ['bookings', 'spend', 'frequency'], 'Meta'),
    delivery: deliveryMetrics.length ? summary(deliverySelection, deliveryMetrics, ['cpm', 'frequency', 'spend'], 'Meta')
      : observation ? `${observation.title}; observed ${observation.observedAt ?? 'at an unknown time'}. Current setup is separate from historical delivery.` : 'Delivery and configuration evidence unavailable.',
    journey: `${webMetrics.length ? summary(pageSelection, webMetrics, ['engagement_rate', 'sessions', 'intent_events'], 'GA4', false) : 'GA4 website evidence unavailable.'} ${[businessSummary, paidSummary].filter(Boolean).join('; ')}${businessSummary || paidSummary ? '; separate populations.' : 'outcome business evidence unavailable.'}${shortLimits([...businessMetrics, ...paidMetrics])}`,
    coverage: `${Object.entries(sourceNames).map(([key, name]) => `${name}: ${data[key as keyof typeof sourceNames].state}`).join('; ')}. Individual missing measures and comparisons remain unknown; inspect source timestamps and limits.${shortLimits(allMetrics)}`,
  }
  return [results, clicks, attentionFinding, audience, journey, delivery, coverage].map(finding => ({ ...finding, summary: summaries[finding.area] })).sort((a, b) => b.importance - a.importance)
}
