import type { MetricClaim } from '@/lib/cockpit/contracts'
import type { ReportMetric, ReportingContext, ReportMetricMap, ReportingRange } from './contracts'

export const OVERVIEW_EVENTS = {
  appointment_confirmed: { label: 'AppointmentConfirmed', count: 'bookings', cpa: 'cost_per_booking', value: 'appointment_value', roas: 'appointment_roas' },
  purchase: { label: 'Purchase', count: 'purchase_count', cpa: 'cost_per_purchase', value: 'purchase_value', roas: 'purchase_roas' },
} as const
export type OverviewEventKey = keyof typeof OVERVIEW_EVENTS
export type OverviewEvent = typeof OVERVIEW_EVENTS[OverviewEventKey]

export function overviewEvent(value: string | null): OverviewEventKey {
  return value === 'purchase' ? 'purchase' : 'appointment_confirmed'
}

export function overviewNumber(metric?: ReportMetric): number | null {
  const claim = metric?.current
  return claim?.availability.state === 'available' && typeof claim.value === 'number' && Number.isFinite(claim.value)
    ? claim.value : null
}

/** Carry evidence identity into the existing detail destinations, not overview-only UI filters. */
export function overviewHref(context: ReportingContext, path: string, filters: Record<string, string> = {}, savedId?: string | null) {
  const params = new URLSearchParams({ ...filters, account: context.account.id, from: context.range.from, to: context.range.to })
  if (savedId) params.set('saved', savedId)
  return `${path}?${params}`
}

/** Preserve named-event identity and keep prior comparisons bound to their own account/window. */
export function overviewEventMetric(metrics: ReportMetricMap | undefined, key: string, event: OverviewEvent,
  context?: ReportingContext, sourceAsOf?: string | null): ReportMetric | undefined {
  const metric = metrics?.[key]
  const unit = key === event.count ? 'count' : key === event.roas ? 'ratio' : 'money'
  function compatible(claim: MetricClaim, range?: ReportingRange) {
    if (claim.unit !== unit || claim.metricKey !== `meta.${key}` || claim.source.system !== 'meta') return false
    if (!context || !range) return true
    const observed = Date.parse(claim.asOf), sourceTime = Date.parse(sourceAsOf ?? ''), cutoff = Date.parse(context.asOf)
    return claim.entity.level === 'account' && claim.entity.id === context.account.id
      && claim.source.role === 'delivery_truth' && claim.source.evidencePlane === 'meta_delivery'
      && claim.window.start === range.from && claim.window.end === range.to
      && claim.window.timezone === context.timezone && claim.window.basis === 'impression_date_et'
      && [observed, sourceTime, cutoff].every(Number.isFinite) && observed === sourceTime && observed <= cutoff
      && (!claim.freshness.observedAt || Date.parse(claim.freshness.observedAt) === observed)
  }
  if (!metric || metric.key !== key || metric.event !== event.label || !compatible(metric.current, context?.range)) return undefined
  return metric.previous && !compatible(metric.previous, context?.comparison) ? { ...metric, previous: null } : metric
}
