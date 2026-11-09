import { z } from 'zod'
import { classifyBusinessState } from '@/lib/outcomes/business-facts'
import type { BusinessLedgerRow } from './business-metrics'
import {
  ReportingDateSchema, type BusinessCustomerFollowup, type ReportMetric,
  type ReportMetricMap, type ReportingContext, type ReportingRange,
} from './contracts'
import { makeReportMetric } from './claims'

export interface BusinessCustomerFollowupRow extends BusinessLedgerRow {
  email: string | null
  datetime: string | null
  datetime_created: string | null
}

type Row = BusinessCustomerFollowupRow
const emailSchema = z.string().email()
const ROW_FIELDS: readonly (keyof Row)[] = [
  'id', 'price', 'amount_paid', 'canceled', 'business_state', 'booking_date_et',
  'appointment_type', 'appointment_type_id', 'email', 'datetime', 'datetime_created', 'appointment_duration',
]
export const BUSINESS_CUSTOMER_FOLLOWUP_HORIZONS = [
  { id: '7_day', name: '7-day follow-up', days: 7 },
  { id: '14_day', name: '14-day follow-up', days: 14 },
  { id: '30_day', name: '30-day follow-up', days: 30 },
] as const

export const BUSINESS_CUSTOMER_FOLLOWUP_METRIC_KEYS = [
  'cohort_customers', 'eligible_customers', 'repeat_customers', 'repeat_rate',
  'repeat_bookings', 'repeat_booked_value', 'repeat_booked_value_per_eligible_customer',
] as const

export const BUSINESS_CUSTOMER_FOLLOWUP_DEFINITIONS: Readonly<Record<
  typeof BUSINESS_CUSTOMER_FOLLOWUP_METRIC_KEYS[number], string
>> = {
  cohort_customers: 'Distinct valid normalized-email identities whose earliest active positive-price booking in retained history was created within the cohort-entry window.',
  eligible_customers: 'Cohort customers whose complete stated ET calendar-day horizon elapsed from their earliest qualifying booking through the observation date.',
  repeat_customers: 'Eligible cohort customers with at least one later-day active positive-price booking created after cohort entry and no later than that customer’s horizon deadline.',
  repeat_rate: 'Repeat customers divided by eligible customers, multiplied by 100; unavailable when no customer has the complete horizon.',
  repeat_bookings: 'Later-day active positive-price bookings for eligible cohort customers, created after cohort entry and through each customer’s horizon deadline.',
  repeat_booked_value: 'Sum of current recorded scheduled price for counted repeat bookings; current mutable ledger facts do not establish historical payment state.',
  repeat_booked_value_per_eligible_customer: 'Repeat booked value divided by eligible customers; unavailable when no customer has the complete horizon.',
} as const

function uniqueRows(rows: readonly Row[]): Row[] {
  const byId = new Map<string | number, Row>()
  for (const row of rows) {
    const previous = byId.get(row.id)
    if (previous && ROW_FIELDS.some(field => !Object.is(previous[field], row[field]))) {
      throw new Error(`outcome_conflicting_duplicate_id:${row.id}`)
    }
    if (!previous) byId.set(row.id, row)
  }
  return [...byId.values()]
}

function identity(row: Row): string | null {
  const email = row.email?.trim().toLowerCase()
  return email && emailSchema.safeParse(email).success ? email : null
}

function qualifying(row: Row): boolean {
  return (row.business_state ?? classifyBusinessState(row)) === 'active_value_bearing'
    && typeof row.price === 'number' && Number.isFinite(row.price) && row.price > 0
}

function shiftedDate(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10)
}

interface CustomerHistory { entry: string; rows: Row[] }

function retainedCustomerHistory(rows: readonly Row[], observedThrough: string): Map<string, CustomerHistory> {
  const histories = new Map<string, CustomerHistory>()
  for (const row of uniqueRows(rows)) {
    const date = row.booking_date_et
    const email = identity(row)
    if (!email || !date || !ReportingDateSchema.safeParse(date).success || date > observedThrough || !qualifying(row)) continue
    const previous = histories.get(email)
    histories.set(email, previous
      ? { entry: previous.entry < date ? previous.entry : date, rows: [...previous.rows, row] }
      : { entry: date, rows: [row] })
  }
  return histories
}

function inRange(date: string, range: ReportingRange): boolean {
  return date >= range.from && date <= range.to
}

interface FollowupTotals {
  cohortCustomers: number
  eligibleCustomers: number
  repeatCustomers: number
  repeatBookings: number
  repeatBookedValue: number
}

function totals(histories: ReadonlyMap<string, CustomerHistory>, range: ReportingRange, days: number, observedThrough: string): FollowupTotals {
  const cohort = [...histories.values()].filter(customer => inRange(customer.entry, range))
  const eligible = cohort.filter(customer => shiftedDate(customer.entry, days) <= observedThrough)
  let repeatCustomers = 0
  let repeatBookings = 0
  let repeatBookedValue = 0
  for (const customer of eligible) {
    const deadline = shiftedDate(customer.entry, days)
    const repeats = customer.rows.filter(row => row.booking_date_et! > customer.entry && row.booking_date_et! <= deadline)
    if (repeats.length) repeatCustomers += 1
    repeatBookings += repeats.length
    repeatBookedValue += repeats.reduce((sum, row) => sum + row.price!, 0)
  }
  return { cohortCustomers: cohort.length, eligibleCustomers: eligible.length,
    repeatCustomers, repeatBookings, repeatBookedValue }
}

function complete(count: number) {
  return { state: 'complete' as const, numerator: count, denominator: count }
}

function maturity(range: ReportingRange, matureThrough: string) {
  return { state: range.to <= matureThrough ? 'settled' as const : 'partial' as const, matureThrough }
}

function baseMetric(
  context: ReportingContext, id: string, key: typeof BUSINESS_CUSTOMER_FOLLOWUP_METRIC_KEYS[number],
  label: string, unit: 'count' | 'money', current: number, previous: number,
  currentCoverage: number, previousCoverage: number, currentMaturity: ReturnType<typeof maturity>,
  previousMaturity: ReturnType<typeof maturity>,
): ReportMetric {
  return makeReportMetric({
    context, source: 'outcomes', entity: { level: 'business', id }, key, label, unit,
    definition: BUSINESS_CUSTOMER_FOLLOWUP_DEFINITIONS[key], current, previous,
    coverage: complete(currentCoverage), previousCoverage: complete(previousCoverage),
    maturity: currentMaturity, previousMaturity,
  })
}

function horizonMetrics(
  context: ReportingContext, histories: ReadonlyMap<string, CustomerHistory>,
  id: string, days: number, observedThrough: string,
): ReportMetricMap {
  const current = totals(histories, context.range, days, observedThrough)
  const previous = totals(histories, context.comparison, days, observedThrough)
  const entityId = `${context.account.id}:customers:followup:${id}`.slice(0, 160)
  const matureThrough = shiftedDate(observedThrough, -days)
  const currentMaturity = maturity(context.range, matureThrough)
  const previousMaturity = maturity(context.comparison, matureThrough)
  const cohort = baseMetric(context, entityId, 'cohort_customers', 'Cohort customers', 'count',
    current.cohortCustomers, previous.cohortCustomers, current.cohortCustomers, previous.cohortCustomers,
    currentMaturity, previousMaturity)
  const eligible = baseMetric(context, entityId, 'eligible_customers', 'Eligible customers', 'count',
    current.eligibleCustomers, previous.eligibleCustomers, current.cohortCustomers, previous.cohortCustomers,
    currentMaturity, previousMaturity)
  const repeatCustomers = baseMetric(context, entityId, 'repeat_customers', 'Repeat customers', 'count',
    current.repeatCustomers, previous.repeatCustomers, current.eligibleCustomers, previous.eligibleCustomers,
    currentMaturity, previousMaturity)
  const repeatBookings = baseMetric(context, entityId, 'repeat_bookings', 'Repeat bookings', 'count',
    current.repeatBookings, previous.repeatBookings, current.eligibleCustomers, previous.eligibleCustomers,
    currentMaturity, previousMaturity)
  const repeatBookedValue = baseMetric(context, entityId, 'repeat_booked_value', 'Repeat booked value', 'money',
    current.repeatBookedValue, previous.repeatBookedValue, current.eligibleCustomers, previous.eligibleCustomers,
    currentMaturity, previousMaturity)
  const rate = (value: FollowupTotals) => value.eligibleCustomers
    ? value.repeatCustomers / value.eligibleCustomers * 100 : null
  const perEligible = (value: FollowupTotals) => value.eligibleCustomers
    ? value.repeatBookedValue / value.eligibleCustomers : null
  const repeatCoverage = complete(current.eligibleCustomers)
  const previousRepeatCoverage = complete(previous.eligibleCustomers)
  return {
    cohort_customers: cohort,
    eligible_customers: eligible,
    repeat_customers: repeatCustomers,
    repeat_rate: makeReportMetric({
      context, source: 'outcomes', entity: { level: 'business', id: entityId },
      key: 'repeat_rate', label: 'Repeat rate', unit: 'percent',
      definition: BUSINESS_CUSTOMER_FOLLOWUP_DEFINITIONS.repeat_rate,
      current: rate(current), previous: rate(previous), coverage: repeatCoverage,
      previousCoverage: previousRepeatCoverage, maturity: currentMaturity, previousMaturity,
      reason: 'No eligible cohort customers have the complete follow-up horizon.',
      previousReason: 'No eligible comparison-cohort customers have the complete follow-up horizon.',
      measurementKind: 'derived', inputMetrics: [repeatCustomers, eligible],
    }),
    repeat_bookings: repeatBookings,
    repeat_booked_value: repeatBookedValue,
    repeat_booked_value_per_eligible_customer: makeReportMetric({
      context, source: 'outcomes', entity: { level: 'business', id: entityId },
      key: 'repeat_booked_value_per_eligible_customer', label: 'Repeat booked value per eligible customer', unit: 'money',
      definition: BUSINESS_CUSTOMER_FOLLOWUP_DEFINITIONS.repeat_booked_value_per_eligible_customer,
      current: perEligible(current), previous: perEligible(previous), coverage: repeatCoverage,
      previousCoverage: previousRepeatCoverage, maturity: currentMaturity, previousMaturity,
      reason: 'No eligible cohort customers have the complete follow-up horizon.',
      previousReason: 'No eligible comparison-cohort customers have the complete follow-up horizon.',
      measurementKind: 'derived', inputMetrics: [repeatBookedValue, eligible],
    }),
  }
}

export function buildBusinessCustomerFollowup(
  context: ReportingContext, rows: readonly Row[], observedThrough: string,
): BusinessCustomerFollowup {
  if (!ReportingDateSchema.safeParse(observedThrough).success) {
    throw new Error('business_followup_observation_date_invalid')
  }
  const histories = retainedCustomerHistory(rows, observedThrough)
  return {
    observedThrough,
    horizons: BUSINESS_CUSTOMER_FOLLOWUP_HORIZONS.map(horizon => ({ id: horizon.id, name: horizon.name,
      metrics: horizonMetrics(context, histories, horizon.id, horizon.days, observedThrough) })) as BusinessCustomerFollowup['horizons'],
  }
}
