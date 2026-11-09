import { classifyBusinessState, type BusinessState } from '@/lib/outcomes/business-facts'
import type {
  BusinessReport, BusinessTypeRow, ReportMetricMap, ReportSeriesPoint, ReportingContext,
} from './contracts'
import { makeReportMetric } from './claims'
import { businessDurationMetrics } from './business-duration-metrics'
import { BUSINESS_DRIVER_DEFINITIONS } from './business-driver-definitions'
import { BUSINESS_ACCOUNT_METRIC_DEFINITIONS } from './business-metric-definitions'

export interface BusinessLedgerRow {
  /** The outcome uuid (rows from fixtures may use a number). Never a source system's id. */
  id: string | number
  price: number | null
  amount_paid: number | null
  canceled: boolean | null
  business_state?: BusinessState | null
  booking_date_et: string | null
  appointment_type: string | null
  appointment_type_id?: number | null
  appointment_duration?: unknown
}

interface BusinessTotals {
  activeAppointments: number
  paidBookings: number
  amountPaid: number
  valueBearingBookings: number
  bookedValue: number
  unknownPaymentCount: number
  recordedPaymentCount: number
}

const SOURCE_DESCRIPTION =
  'Account-scoped outcome ledger by booking creation date in the account timezone. Amount paid covers active appointments and does not establish processor settlement.'

function uniqueRows(rows: readonly BusinessLedgerRow[]): BusinessLedgerRow[] {
  const byId = new Map<string | number, BusinessLedgerRow>()
  for (const row of rows) {
    const existing = byId.get(row.id)
    if (existing && !sameLedgerRow(existing, row)) {
      throw new Error(`outcome_conflicting_duplicate_id:${row.id}`)
    }
    if (!existing) byId.set(row.id, row)
  }
  return [...byId.values()]
}

function sameLedgerRow(left: BusinessLedgerRow, right: BusinessLedgerRow): boolean {
  return left.id === right.id
    && left.price === right.price
    && left.amount_paid === right.amount_paid
    && left.canceled === right.canceled
    && left.business_state === right.business_state
    && left.booking_date_et === right.booking_date_et
    && left.appointment_type === right.appointment_type
    && left.appointment_type_id === right.appointment_type_id
    && Object.is(left.appointment_duration, right.appointment_duration)
}

function stateOf(row: BusinessLedgerRow): BusinessState {
  return row.business_state ?? classifyBusinessState(row)
}

function isRecordedPayment(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function totals(rows: readonly BusinessLedgerRow[]): BusinessTotals {
  const unique = uniqueRows(rows)
  const active = unique.filter(row => stateOf(row) !== 'canceled')
  const recorded = active.filter(
    (row): row is BusinessLedgerRow & { amount_paid: number } => isRecordedPayment(row.amount_paid),
  )
  const valueBearing = active.filter(row => stateOf(row) === 'active_value_bearing')
  return {
    activeAppointments: active.length,
    paidBookings: recorded.filter(row => row.amount_paid > 0).length,
    amountPaid: recorded.reduce((sum, row) => sum + row.amount_paid, 0),
    valueBearingBookings: valueBearing.length,
    bookedValue: valueBearing.reduce((sum, row) => sum + (row.price ?? 0), 0),
    unknownPaymentCount: active.length - recorded.length,
    recordedPaymentCount: recorded.length,
  }
}

function ledgerCoverage(value: BusinessTotals) {
  return { state: 'complete' as const, numerator: value.activeAppointments, denominator: value.activeAppointments }
}

function paymentCoverage(value: BusinessTotals) {
  return {
    state: value.recordedPaymentCount === value.activeAppointments ? 'complete' as const : 'partial' as const,
    numerator: value.recordedPaymentCount,
    denominator: value.activeAppointments,
  }
}

function coveragePercent(value: BusinessTotals): number | null {
  return value.activeAppointments > 0
    ? value.recordedPaymentCount / value.activeAppointments * 100
    : null
}

function observedPaymentValue(value: BusinessTotals, measured: number): number | null {
  return value.activeAppointments > 0 && value.recordedPaymentCount === 0 ? null : measured
}

function metricMap(
  context: ReportingContext,
  currentRows: readonly BusinessLedgerRow[],
  previousRows?: readonly BusinessLedgerRow[],
  entityId: string = context.account.id,
): ReportMetricMap {
  const current = totals(currentRows), previous = previousRows === undefined ? undefined : totals(previousRows)
  const common = {
    context,
    source: 'outcomes' as const,
    entity: { level: 'business' as const, id: entityId.slice(0, 160) },
  }
  const prior = <T extends number | null>(value: T): T | undefined => previous === undefined ? undefined : value
  const currentLedgerCoverage = ledgerCoverage(current)
  const previousLedgerCoverage = previous ? ledgerCoverage(previous) : undefined
  const currentPaymentCoverage = paymentCoverage(current)
  const previousPaymentCoverage = previous ? paymentCoverage(previous) : undefined
  const currentPaidBookings = observedPaymentValue(current, current.paidBookings)
  const currentAmountPaid = observedPaymentValue(current, current.amountPaid)
  const previousPaidBookings = previous ? observedPaymentValue(previous, previous.paidBookings) : null
  const previousAmountPaid = previous ? observedPaymentValue(previous, previous.amountPaid) : null
  return {
    ...businessDurationMetrics(context, currentRows, previousRows, entityId),
    paid_bookings: makeReportMetric({
      ...common, ...BUSINESS_ACCOUNT_METRIC_DEFINITIONS.paid_bookings,
      current: currentPaidBookings, previous: prior(previousPaidBookings),
      coverage: currentPaymentCoverage, previousCoverage: previousPaymentCoverage,
      reason: 'No valid native amount_paid value was observed for an active appointment in this period.',
      previousReason: 'No valid native amount_paid value was observed for an active appointment in the comparison period.',
    }),
    amount_paid: makeReportMetric({
      ...common, ...BUSINESS_ACCOUNT_METRIC_DEFINITIONS.amount_paid,
      current: currentAmountPaid, previous: prior(previousAmountPaid),
      coverage: currentPaymentCoverage, previousCoverage: previousPaymentCoverage,
      reason: 'No valid native amount_paid value was observed for an active appointment in this period.',
      previousReason: 'No valid native amount_paid value was observed for an active appointment in the comparison period.',
    }),
    active_appointments: makeReportMetric({
      ...common, ...BUSINESS_ACCOUNT_METRIC_DEFINITIONS.active_appointments,
      current: current.activeAppointments, previous: prior(previous?.activeAppointments ?? null),
      coverage: currentLedgerCoverage, previousCoverage: previousLedgerCoverage,
    }),
    value_bearing_bookings: makeReportMetric({
      ...common, key: 'value_bearing_bookings', label: 'Value-bearing bookings', unit: 'count',
      definition: BUSINESS_DRIVER_DEFINITIONS.value_bearing_bookings,
      current: current.valueBearingBookings, previous: prior(previous?.valueBearingBookings ?? null),
      coverage: currentLedgerCoverage, previousCoverage: previousLedgerCoverage,
    }),
    booked_value: makeReportMetric({
      ...common, ...BUSINESS_ACCOUNT_METRIC_DEFINITIONS.booked_value,
      current: current.bookedValue, previous: prior(previous?.bookedValue ?? null),
      coverage: currentLedgerCoverage, previousCoverage: previousLedgerCoverage,
    }),
    unknown_payment_count: makeReportMetric({
      ...common, key: 'unknown_payment_count', label: 'Unknown payment records', unit: 'count',
      definition: 'Unique active appointments whose recorded collected value value is null or invalid.',
      current: current.unknownPaymentCount, previous: prior(previous?.unknownPaymentCount ?? null),
      coverage: currentLedgerCoverage, previousCoverage: previousLedgerCoverage,
    }),
    payment_coverage: makeReportMetric({
      ...common, key: 'payment_coverage', label: 'Payment field coverage', unit: 'percent',
      definition: 'Active appointments with a valid recorded collected value value divided by all active appointments, multiplied by 100.',
      current: coveragePercent(current), previous: prior(previous ? coveragePercent(previous) : null),
      coverage: currentLedgerCoverage, previousCoverage: previousLedgerCoverage,
      reason: 'No active appointments exist in this period, so payment-field coverage has no denominator.',
      previousReason: 'No active appointments exist in the comparison period, so payment-field coverage has no denominator.',
    }),
  }
}

function days(from: string, to: string): string[] {
  const result: string[] = []
  for (let time = Date.parse(`${from}T00:00:00Z`); time <= Date.parse(`${to}T00:00:00Z`); time += 86_400_000) {
    result.push(new Date(time).toISOString().slice(0, 10))
  }
  return result
}

function series(
  context: ReportingContext,
  rows: readonly BusinessLedgerRow[],
  from: string,
  to: string,
): ReportSeriesPoint[] {
  const unique = uniqueRows(rows)
  return days(from, to).map(date => {
    const previousDate = new Date(Date.parse(`${date}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10)
    const dayContext: ReportingContext = {
      ...context,
      range: { from: date, to: date },
      comparison: { from: previousDate, to: previousDate },
    }
    return {
      date,
      metrics: metricMap(dayContext, unique.filter(row => row.booking_date_et === date), undefined,
        `${context.account.id}:day:${date}`),
    }
  })
}

export function categorizeAppointmentType(name: string): BusinessTypeRow['category'] {
  const normalized = name.toLowerCase()
  if (/\b(session|mini)\b/.test(normalized)) return 'photography'
  if (/\bstudio rental\b/.test(normalized)) return 'rental'
  return 'unknown'
}

/** Callers deduplicate appointment IDs before grouping native service populations. */
export function groupBusinessAppointmentTypes<T extends BusinessLedgerRow>(rows: readonly T[]): Map<string, T[]> {
  const grouped = new Map<string, T[]>()
  for (const row of rows) {
    const name = row.appointment_type?.trim() || '(unknown)'
    const nativeId = row.appointment_type_id
    if (nativeId != null && (!Number.isSafeInteger(nativeId) || nativeId <= 0)) {
      throw new Error('outcome_invalid_appointment_type_id')
    }
    const legacyId = /^(outcome-type|outcome-label):/.test(name) ? `outcome-label:${name}` : name
    const id = nativeId == null ? legacyId : `outcome-type:${nativeId}`
    grouped.set(id, [...(grouped.get(id) ?? []), row])
  }
  return grouped
}

export function businessAppointmentTypeName(rows: readonly BusinessLedgerRow[]): string {
  return [...new Set(rows.map(row => row.appointment_type?.trim() || '(unknown)'))]
    .sort((left, right) => left.localeCompare(right)).join(' / ')
}

function typeRows(
  context: ReportingContext, rows: readonly BusinessLedgerRow[], previousRows: readonly BusinessLedgerRow[],
): BusinessTypeRow[] {
  const current = groupBusinessAppointmentTypes(rows)
  const previous = groupBusinessAppointmentTypes(previousRows)
  return [...new Set([...current.keys(), ...previous.keys()])]
    .map(id => {
      const observed = current.get(id) ?? previous.get(id)!
      const name = businessAppointmentTypeName(observed)
      const categories = new Set(observed.map(row => categorizeAppointmentType(row.appointment_type?.trim() || '(unknown)')))
      return { id, name, category: categories.size === 1 ? [...categories][0] : 'unknown' as const,
        metrics: metricMap(context, current.get(id) ?? [], previous.get(id) ?? [],
          `${context.account.id}:type:${id}`),
      }
    }).sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id))
}

export function buildBusinessReport(
  context: ReportingContext,
  currentRows: readonly BusinessLedgerRow[],
  previousRows: readonly BusinessLedgerRow[],
): BusinessReport {
  const current = uniqueRows(currentRows)
  const previous = uniqueRows(previousRows)
  return {
    metrics: metricMap(context, current, previous),
    series: series(context, current, context.range.from, context.range.to),
    comparisonSeries: series(context, previous, context.comparison.from, context.comparison.to),
    types: typeRows(context, current, previous),
    sourceDescription: SOURCE_DESCRIPTION,
  }
}
