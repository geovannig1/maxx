import { metricsToExportRows } from './export'
import type { ReportEntity, ReportMetric, ReportSeriesPoint, ReportingContext } from './contracts'

export const BUSINESS_TREND_KEYS = ['booked_value', 'paid_bookings', 'amount_paid', 'active_appointments',
  'value_bearing_bookings', 'recorded_booked_hours', 'hours_per_recorded_booking', 'duration_recorded_bookings',
  'duration_coverage', 'payment_coverage', 'unknown_payment_count'] as const
export const META_TREND_KEYS = ['spend', 'bookings', 'appointment_value', 'cost_per_booking', 'appointment_roas',
  'bookings_click', 'bookings_view', 'purchase_count', 'cost_per_purchase', 'purchase_value', 'purchase_roas', 'impressions', 'reach', 'frequency', 'cpm', 'clicks', 'ctr', 'cpc',
  'link_clicks', 'link_ctr', 'link_cpc', 'outbound_clicks', 'outbound_ctr', 'outbound_cpc', 'landing_page_views',
  'cost_per_lpv', 'engagements', 'engagement_rate', 'cost_per_engagement', 'reactions', 'comments', 'shares',
  'share_rate', 'cost_per_share', 'saves', 'video_plays', 'video_2s', 'cost_per_2s_view', 'thruplays',
  'cost_per_thruplay', 'average_watch_seconds', 'watch_p25', 'watch_p50', 'watch_p75', 'watch_p100',
  'retention_p25', 'retention_p50', 'retention_p75', 'retention_p100'] as const

export function trendValue(metric?: ReportMetric): number | null {
  const claim = metric?.current
  return claim?.availability.state === 'available' && typeof claim.value === 'number' && Number.isFinite(claim.value) ? claim.value : null
}

function days(from: string, to: string): string[] {
  const result: string[] = []
  for (let time = Date.parse(`${from}T00:00:00Z`); time <= Date.parse(`${to}T00:00:00Z`); time += 86_400_000) result.push(new Date(time).toISOString().slice(0, 10))
  return result
}

/** Keep missing and conflicting days unknown; never rewrite independent prior claims. */
export function trendRows(context: ReportingContext, series: ReportSeriesPoint[], comparisonSeries: ReportSeriesPoint[], key: string) {
  const lookup = (points: ReportSeriesPoint[]) => {
    const byDate = new Map<string, ReportSeriesPoint[]>()
    for (const point of points) byDate.set(point.date, [...(byDate.get(point.date) ?? []), point])
    return (date: string): ReportMetric | undefined => {
      const points = byDate.get(date)
      if (points?.length !== 1) return undefined
      const metric = points[0].metrics[key], window = metric?.current.window
      return window?.start === date && window.end === date && window.timezone === context.timezone ? metric : undefined
    }
  }
  const current = lookup(series), previous = lookup(comparisonSeries)
  const currentDays = days(context.range.from, context.range.to), priorDays = days(context.comparison.from, context.comparison.to)
  return currentDays.map((date, index) => ({ date, priorDate: priorDays[index], metric: current(date),
    previous: priorDays[index] ? previous(priorDays[index]) : undefined }))
}

export function temporalViewHref(path: string, search: string | URLSearchParams, hash: string, key: string, value: string) {
  const query = new URLSearchParams(search)
  query.set(key, value)
  return `${path}?${query}${hash}`
}

/** Export both independent periods and their original daily evidence without applying a chart metric filter. */
export function entityDailyExportRows(entity: ReportEntity, context: ReportingContext) {
  return ([['current', entity.series], ['prior', entity.comparisonSeries]] as const).flatMap(([period, points]) =>
    (points ?? []).flatMap(point => metricsToExportRows(point.metrics, `Meta ${entity.level} ${entity.id} · ${entity.name} · daily ${period} · ${point.date}`, context)))
}

/** Preserve the existing ad export entry point and its labels. */
export const adDailyExportRows = entityDailyExportRows

/** Compare complete additive native readings without replacing either observation. */
export function entityDailyDisagreement(entity: ReportEntity, context: ReportingContext, key: string, prior: boolean) {
  if (!['spend', 'bookings', 'appointment_value', 'purchase_count', 'purchase_value', 'bookings_click', 'bookings_view'].includes(key)) return null
  const metric = entity.metrics[key], headline = prior ? metric?.previous : metric?.current
  const range = prior ? context.comparison : context.range
  const points = trendRows(context, entity.series ?? [], entity.comparisonSeries ?? [], key).map(row => prior ? row.previous : row.metric)
  if (!headline || headline.availability.state !== 'available' || typeof headline.value !== 'number' || !Number.isFinite(headline.value)
    || headline.coverage.state !== 'complete' || headline.window.start !== range.from || headline.window.end !== range.to
    || !points.length || points.some(day => !day || trendValue(day) === null || day.current.coverage.state !== 'complete'
      || day.event !== metric.event || day.current.unit !== headline.unit || day.current.asOf !== headline.asOf
      || day.current.source.system !== headline.source.system || day.current.source.head !== headline.source.head
      || day.current.window.basis !== headline.window.basis || day.current.attributionScope !== headline.attributionScope)) return null
  const total = points.reduce((sum, day) => sum + trendValue(day)!, 0)
  return Math.abs(total - headline.value) > Math.max(1, Math.abs(total), Math.abs(headline.value)) * 1e-10
    ? { total, headline: headline.value, unit: headline.unit } : null
}
