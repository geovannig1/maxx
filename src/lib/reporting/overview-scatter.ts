import type { ReportEntity, ReportMetric, ReportingContext, ReportingData } from './contracts'
import { META_NATIVE_METRIC_DEFINITIONS, META_RATIO_METRIC_DEFINITIONS, metaNativeMetricDescription } from './meta-metric-definitions'
import { overviewCreativeContext, overviewCreativeRetention, overviewCreativeRows } from './overview-creative'
import { overviewNumber, type OverviewEvent } from './overview-model'

export type OverviewScatterLane = 'numeric' | 'attention' | 'cpa' | 'spend'
export interface OverviewScatterRow {
  entity: ReportEntity
  halfway: number | null
  halfwayCount: number | null
  starts: number | null
  spend: number | null
  results: number | null
  cpa: number | null
  value: number | null
  roas: number | null
  lane: OverviewScatterLane
  reasons: string[]
  radius: number
}

function observation(entity: ReportEntity, key: string, context: ReportingContext, event: string | null, unit: ReportMetric['current']['unit']) {
  const metric = entity.metrics[key], claim = metric?.current, value = overviewNumber(metric)
  if (!metric || !claim || metric.key !== key || metric.event !== event || value === null || value < 0
    || claim.metricKey !== `meta.${key}` || claim.unit !== unit || claim.definitionVersion !== 1
    || claim.entity.level !== 'ad' || claim.entity.id !== entity.id
    || claim.source.system !== 'meta' || claim.source.role !== 'delivery_truth' || claim.source.evidencePlane !== 'meta_delivery'
    || claim.window.start !== context.range.from || claim.window.end !== context.range.to
    || claim.window.timezone !== context.timezone || claim.window.basis !== 'impression_date_et'
    || claim.coverage.state !== 'complete' || claim.freshness.state !== 'fresh' || claim.maturity.state === 'partial'
    || claim.authority.state !== 'diagnostic' || claim.authority.policyVersion !== 'reporting-v1'
    || !Number.isFinite(Date.parse(context.asOf)) || Date.parse(claim.asOf) !== Date.parse(context.asOf)) return null
  return metric
}

function native(entity: ReportEntity, key: string, context: ReportingContext): ReportMetric | null {
  const definition = META_NATIVE_METRIC_DEFINITIONS.find(item => item.key === key)
  if (!definition) return null
  const metric = observation(entity, key, context, definition.event ?? null, definition.unit)
  const description = metaNativeMetricDescription(definition)
  const attributed = !!(definition.event || definition.action || definition.attributed)
  return metric && metric.label === definition.label && metric.current.label === definition.label
    && metric.definition === description && metric.current.formula === description
    && metric.current.attributionScope === (attributed ? 'meta_platform_modelled' : 'none')
    && metric.current.measurementKind === (attributed ? 'modelled' : 'measured')
    && (definition.unit !== 'count' || Number.isSafeInteger(metric.current.value))
    && metric.current.source.head === `meta-live:${context.account.metaAccountId}:${metric.current.asOf}` ? metric : null
}

function ratio(entity: ReportEntity, key: string, event: OverviewEvent, context: ReportingContext, a: ReportMetric | null, b: ReportMetric | null) {
  const definition = META_RATIO_METRIC_DEFINITIONS.find(item => item[0] === key)
  if (!definition || !a || !b) return null
  const [, label, numerator, denominator, scale, unit] = definition
  const metric = observation(entity, key, context, event.label, unit)
  const x = overviewNumber(a), y = overviewNumber(b), value = overviewNumber(metric ?? undefined)
  const formula = `${a.label} / ${b.label}${scale !== 1 ? ` × ${scale}` : ''}; matching Meta population and period with complete input coverage.`
  if (!metric || x === null || y === null || y <= 0 || value === null || a.key !== numerator || b.key !== denominator
    || metric.label !== label || metric.current.label !== label || metric.definition !== formula || metric.current.formula !== formula
    || metric.current.measurementKind !== 'derived' || metric.current.attributionScope !== 'meta_platform_modelled'
    || metric.current.inputClaimIds.length !== 2 || ![a, b].every(input => metric.current.inputClaimIds.includes(input.current.claimId))) return null
  const expected = x / y * scale
  return Math.abs(value - expected) <= Number.EPSILON * Math.max(1, value, expected) * 8 ? value : null
}

/** Numeric positions require compatible native inputs for this exact Meta observation. */
export function overviewScatter(data: ReportingData, event: OverviewEvent, search?: string) {
  const context = overviewCreativeContext(data)
  const entities = overviewCreativeRows(data, event, { search })
  const observed = data.meta.asOf !== null
  const retention = new Map(overviewCreativeRetention(entities, context).map(row => [row.entity.id, row.points[1]]))
  const rows: OverviewScatterRow[] = entities.map(entity => {
    const read = (key: string) => observed ? native(entity, key, context) : null
    const spendMetric = read('spend'), countMetric = read(event.count), valueMetric = read(event.value)
    const spend = overviewNumber(spendMetric ?? undefined), results = overviewNumber(countMetric ?? undefined), value = overviewNumber(valueMetric ?? undefined)
    const cpa = ratio(entity, event.cpa, event, context, spendMetric, countMetric)
    const roas = ratio(entity, event.roas, event, context, valueMetric, spendMetric)
    const startsMetric = read('video_plays'), halfwayMetric = read('watch_p50')
    const starts = overviewNumber(startsMetric ?? undefined), halfwayCount = overviewNumber(halfwayMetric ?? undefined)
    const attention = entity.creative?.format === 'video' && startsMetric && halfwayMetric
      && observation(entity, 'retention_p50', context, null, 'percent') ? retention.get(entity.id) : null
    const halfway = attention?.value ?? null
    const reasons = [
      halfway === null ? entity.creative?.format === 'image' || entity.creative?.format === 'carousel'
        ? 'Halfway-view rate is not applicable to this preview format.'
        : 'Halfway-view rate unavailable: compatible video counts, starts and complete current evidence are required.' : null,
      results === 0 ? `CPA is undefined: 0 reported ${event.label} results.`
        : cpa === null ? `${event.label} CPA unavailable: compatible spend, positive results and complete current evidence are required.` : null,
      spend === null ? 'Spend unavailable for this observation.' : spend === 0 ? 'Zero spend has no bubble area.' : null,
    ].filter((reason): reason is string => reason !== null)
    const lane: OverviewScatterLane = halfway === null ? 'attention' : cpa === null ? 'cpa' : spend === null || spend === 0 ? 'spend' : 'numeric'
    return { entity, halfway, halfwayCount, starts, spend, results, cpa, value, roas, lane, reasons, radius: 0 }
  })
  const maxSpend = rows.reduce((max, row) => row.lane === 'numeric' ? Math.max(max, row.spend!) : max, 0)
  const scaled = rows.map(row => ({ ...row, radius: row.lane === 'numeric' && maxSpend > 0 ? 26 * Math.sqrt(row.spend! / maxSpend) : 0 }))
  const plotted = scaled.filter(row => row.lane === 'numeric')
  return { context, rows: scaled, plotted, maxSpend,
    cpaMax: plotted.reduce((max, row) => Math.max(max, row.cpa!), 0),
    total: (data.meta.data?.entities ?? []).filter(entity => entity.level === 'ad').length }
}
