import type { ReportMetric, ReportSeriesPoint, ReportingContext } from './contracts'
import { trendRows, trendValue } from './trend'

export type OverviewTrendKind = 'business' | 'meta'
export interface OverviewTrendValue { value: number | null; days: number; stale: boolean; asOf: string | null }
export interface OverviewTrendBin {
  date: string; end: string; priorDate: string | undefined; priorEnd: string | undefined;
  label: string; priorLabel: string; days: number; short: boolean;
  current: OverviewTrendValue; prior: OverviewTrendValue;
}
export interface OverviewMerBin {
  date: string; end: string; label: string; days: number; short: boolean;
  bookedValue: number | null; spend: number | null;
  state: 'available' | 'zero_spend' | 'unavailable'; value: number | null;
}

const specs = {
  business: { key: 'booked_value', source: 'outcomes', role: 'business_truth', plane: 'outcome_business', basis: 'booking_created_date_et', scope: 'all_sources' },
  meta: { key: 'spend', source: 'meta', role: 'delivery_truth', plane: 'meta_delivery', basis: 'impression_date_et', scope: 'none' },
} as const
type DailyRow = ReturnType<typeof trendRows>[number]

function validDay(metric: ReportMetric | undefined, date: string | undefined, context: ReportingContext, kind: OverviewTrendKind): metric is ReportMetric {
  if (!metric || !date || trendValue(metric) === null) return false
  const claim = metric.current, spec = specs[kind]
  const entityMatches = kind === 'meta' ? claim.entity.level === 'account' && claim.entity.id === context.account.id
    : claim.entity.level === 'business' && [context.account.id, `${context.account.id}:day:${date}`.slice(0, 160)].includes(claim.entity.id)
  return metric.key === spec.key && metric.event === null && claim.metricKey === `${spec.source}.${spec.key}`
    && claim.unit === 'money' && claim.source.system === spec.source && claim.source.role === spec.role
    && claim.source.evidencePlane === spec.plane && claim.window.basis === spec.basis
    && claim.attributionScope === spec.scope && claim.coverage.state === 'complete' && claim.maturity.state !== 'partial' && entityMatches
}

/** A bin is a complete sum of independent native days, never a replacement metric claim. */
function binValue(rows: DailyRow[], prior: boolean, context: ReportingContext, kind: OverviewTrendKind): OverviewTrendValue {
  const metrics = rows.map(row => ({ metric: prior ? row.previous : row.metric, date: prior ? row.priorDate : row.date }))
  const valid = metrics.flatMap(({ metric, date }) => validDay(metric, date, context, kind) ? [metric] : [])
  const first = valid[0]?.current
  const consistent = valid.length === rows.length && valid.every(metric => metric.current.source.head === first?.source.head
    && metric.current.asOf === first?.asOf && metric.current.source.role === first?.source.role
    && metric.current.source.evidencePlane === first?.source.evidencePlane)
  const total = consistent ? valid.reduce((sum, metric) => sum + (metric.current.value as number), 0) : null
  return { value: total !== null && Number.isFinite(total) ? total : null, days: valid.length,
    stale: valid.some(metric => metric.current.freshness.state === 'stale'), asOf: consistent ? first?.asOf ?? null : null }
}

export function overviewTrendBins(context: ReportingContext, series: ReportSeriesPoint[], comparisonSeries: ReportSeriesPoint[], kind: OverviewTrendKind): OverviewTrendBin[] {
  const rows = trendRows(context, series, comparisonSeries, specs[kind].key), size = rows.length > 31 ? 7 : 1
  return Array.from({ length: Math.ceil(rows.length / size) }, (_, index) => {
    const group = rows.slice(index * size, (index + 1) * size), first = group[0], last = group.at(-1)!
    return { date: first.date, end: last.date, priorDate: first.priorDate, priorEnd: last.priorDate,
      label: first.date === last.date ? first.date : `${first.date} – ${last.date}`,
      priorLabel: first.priorDate && last.priorDate ? first.priorDate === last.priorDate ? first.priorDate : `${first.priorDate} – ${last.priorDate}` : 'No aligned prior dates',
      days: group.length, short: size === 7 && group.length < size,
      current: binValue(group, false, context, kind), prior: binValue(group, true, context, kind) }
  })
}

/** Current all-source booked value divided by current Meta spend for an exact shared interval. */
export function overviewMerBins(business: OverviewTrendBin[], meta: OverviewTrendBin[]): OverviewMerBin[] {
  return business.map(booked => {
    const matches = meta.filter(spend => spend.date === booked.date && spend.end === booked.end && spend.days === booked.days)
    const spend = matches.length === 1 ? matches[0] : null
    const bookedValue = booked.current.value, spendValue = spend?.current.value ?? null
    const compatible = Boolean(spend) && booked.current.asOf !== null && spend!.current.asOf !== null
      && !booked.current.stale && !spend!.current.stale
      && bookedValue !== null && spendValue !== null && bookedValue >= 0 && spendValue >= 0
    const state = !compatible ? 'unavailable' : spendValue === 0 ? 'zero_spend' : 'available'
    return { date: booked.date, end: booked.end, label: booked.label, days: booked.days, short: booked.short,
      bookedValue, spend: spendValue, state,
      value: state === 'available' ? bookedValue! / spendValue! : null }
  })
}
