import { classifyBusinessState } from '@/lib/outcomes/business-facts'
import type { BusinessLedgerRow } from './business-metrics'
import type { ReportMetricMap, ReportingContext } from './contracts'
import { makeReportMetric } from './claims'
import { BUSINESS_DRIVER_DEFINITIONS } from './business-driver-definitions'

/** The appointment's recorded duration, never the current service catalog or a price-derived estimate. */
function minutes(value: unknown): number | null {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^\d+$/.test(value))) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
}

function sample(rows: readonly BusinessLedgerRow[]) {
  const eligible = rows.filter(row => (row.business_state ?? classifyBusinessState(row)) === 'active_value_bearing')
  const recorded = eligible.flatMap(row => {
    const value = minutes(row.appointment_duration)
    return value === null ? [] : [value]
  })
  const total = recorded.reduce((sum, value) => sum + value, 0) / 60
  return {
    recorded_booked_hours: eligible.length && !recorded.length ? null : total,
    hours_per_recorded_booking: recorded.length ? total / recorded.length : null,
    duration_recorded_bookings: recorded.length,
    duration_coverage: eligible.length ? recorded.length / eligible.length * 100 : null,
    coverage: { state: recorded.length === eligible.length ? 'complete' as const : 'partial' as const,
      numerator: recorded.length, denominator: eligible.length },
    ledger: { state: 'complete' as const, numerator: eligible.length, denominator: eligible.length },
  }
}

/** Callers provide deduplicated appointments and the appropriate native cohort. */
export function businessDurationMetrics(context: ReportingContext, rows: readonly BusinessLedgerRow[],
  previousRows: readonly BusinessLedgerRow[] | undefined, entityId: string, upcoming = false): ReportMetricMap {
  const current = sample(rows), previous = previousRows === undefined ? undefined : sample(previousRows)
  const fields = [
    ['recorded_booked_hours', 'Recorded booked hours', 'hours', 'coverage', BUSINESS_DRIVER_DEFINITIONS.recorded_booked_hours],
    ['hours_per_recorded_booking', 'Hours per duration-recorded booking', 'hours', 'coverage', BUSINESS_DRIVER_DEFINITIONS.hours_per_recorded_booking],
    ['duration_recorded_bookings', 'Bookings with recorded duration', 'count', 'ledger', BUSINESS_DRIVER_DEFINITIONS.duration_recorded_bookings],
    ['duration_coverage', 'Duration coverage', 'percent', 'ledger', BUSINESS_DRIVER_DEFINITIONS.duration_coverage],
  ] as const
  return Object.fromEntries(fields.map(([key, label, unit, basis, definition]) => [key, makeReportMetric({
    context, source: 'outcomes', entity: { level: 'business', id: entityId.slice(0, 160) }, key, label, unit, definition,
    current: upcoming && !rows.length ? null : current[key], previous: previous?.[key],
    coverage: upcoming ? { ...current[basis], state: 'partial' } : current[basis], previousCoverage: previous?.[basis],
    reason: 'No usable recorded duration or qualifying denominator is available for this cohort.',
    previousReason: 'No usable recorded duration or qualifying denominator is available for the prior cohort.',
    ...(upcoming ? { comparison: 'none' as const, basis: 'service_date_et' as const } : {}),
  })]))
}
