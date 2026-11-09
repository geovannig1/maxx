import { z } from 'zod'
import { classifyBusinessState } from '@/lib/outcomes/business-facts'
import { etDateOf } from '@/lib/utils/date-utils'
import {
  ReportingDateSchema, type BusinessCustomers, type BusinessLeadTime, type BusinessUpcoming,
  type ReportMetricMap, type ReportSection, type ReportingContext, type ReportingRange,
} from './contracts'
import { makeReportMetric, type ReportMetricInput } from './claims'
import { upcomingBusinessContext } from './business-intelligence-context'
import { businessAppointmentTypeName, groupBusinessAppointmentTypes } from './business-metrics'
import { businessDurationMetrics } from './business-duration-metrics'
import { buildBusinessCustomerFollowup, type BusinessCustomerFollowupRow } from './business-customer-followup'

/** Private ledger projection; builders serialize aggregates, never these identity fields. */
export type BusinessIntelligenceRow = BusinessCustomerFollowupRow

type Row = BusinessIntelligenceRow
type Coverage = NonNullable<ReportMetricInput['coverage']>
const timestampSchema = z.string().datetime({ offset: true })
const emailSchema = z.string().email()
const ROW_FIELDS: readonly (keyof Row)[] = [
  'id', 'price', 'amount_paid', 'canceled', 'business_state', 'booking_date_et',
  'appointment_type', 'appointment_type_id', 'email', 'datetime', 'datetime_created', 'appointment_duration',
]
const CUSTOMER_GROUPS = [
  { id: 'prior_booking', name: 'Prior booking in retained history' },
  { id: 'first_observed', name: 'First observed in retained history' },
  { id: 'unidentified', name: 'Unidentified bookings' },
] as const
const CUSTOMER_LABELS = {
  identified_customers: 'Identified customers', prior_booking_customers: 'Customers with a prior booking',
  first_observed_customers: 'First-observed customers', unidentified_bookings: 'Unidentified bookings',
  multiple_booking_customers: 'Customers with multiple cohort bookings',
}
/** Shared exact source definitions; interpretation must not infer meaning from a key alone. */
export const BUSINESS_CUSTOMER_DEFINITIONS: Readonly<Record<string, string>> = {
  bookings: 'Unique active value-bearing appointments in the scoped retained ledger.',
  paid_bookings: 'Unique active value-bearing appointments with a valid native amount_paid greater than zero; incomplete payment fields make this an observed lower bound.',
  amount_paid: 'Sum of valid recorded collected value on active value-bearing appointments; incomplete payment fields make this an observed lower bound, not processor settlement.',
  booked_value: 'Sum of recorded scheduled prices on active value-bearing appointments; distinct from amount paid.',
  customers: 'Distinct valid normalized-email identities in this retained-ledger cohort group; unidentified bookings do not establish a customer count.',
  ...Object.fromEntries(Object.entries(CUSTOMER_LABELS).map(([key, label]) => [key, key === 'multiple_booking_customers'
    ? 'Distinct normalized-email identities with more than one active value-bearing booking in the cohort.'
    : `${label} among active value-bearing booking-created cohorts. Prior means a qualifying booking before cohort start; first observed in retained history does not establish acquisition.`])),
}
const LEAD_BUCKETS = [
  { id: 'under_1', name: 'Under 1 day', from: 0, to: 1 },
  { id: '1_7', name: '1 to under 7 days', from: 1, to: 7 },
  { id: '7_14', name: '7 to under 14 days', from: 7, to: 14 },
  { id: '14_30', name: '14 to under 30 days', from: 14, to: 30 },
  { id: '30_plus', name: '30 days or more', from: 30, to: Infinity },
] as const

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

function activeValueBearing(row: Row): boolean {
  return (row.business_state ?? classifyBusinessState(row)) === 'active_value_bearing'
}

function inRange(date: string | null, range: ReportingRange): boolean {
  return date !== null && ReportingDateSchema.safeParse(date).success && date >= range.from && date <= range.to
}

function identity(row: Row): string | null {
  const email = row.email?.trim().toLowerCase()
  return email && emailSchema.safeParse(email).success ? email : null
}

function finite(value: number | null): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function coverage(numerator: number, denominator: number, partial = false): Coverage {
  return { state: partial || numerator !== denominator ? 'partial' : 'complete', numerator, denominator }
}

function common(context: ReportingContext, entityId: string) {
  return { context, source: 'outcomes' as const, entity: { level: 'business' as const, id: entityId.slice(0, 160) } }
}

function nativeTotals(rows: readonly Row[]) {
  const recorded = rows.filter(row => finite(row.amount_paid))
  const priced = rows.filter(row => finite(row.price))
  return {
    bookings: rows.length,
    paid_bookings: rows.length && !recorded.length ? null : recorded.filter(row => row.amount_paid! > 0).length,
    amount_paid: rows.length && !recorded.length ? null : recorded.reduce((sum, row) => sum + row.amount_paid!, 0),
    booked_value: rows.length && !priced.length ? null : priced.reduce((sum, row) => sum + row.price!, 0),
    unknown_payment_count: rows.length - recorded.length,
    ledger: coverage(rows.length, rows.length),
    payment: coverage(recorded.length, rows.length),
    price: coverage(priced.length, rows.length),
  }
}

function nativeMetrics(
  context: ReportingContext, rows: readonly Row[], previousRows: readonly Row[] | undefined,
  entityId: string, upcoming = false,
): ReportMetricMap {
  const current = nativeTotals(rows)
  const previous = previousRows === undefined ? undefined : nativeTotals(previousRows)
  const entries = [
    ['bookings', upcoming ? 'Recorded bookings' : 'Bookings', 'count', 'ledger', BUSINESS_CUSTOMER_DEFINITIONS.bookings],
    ['paid_bookings', 'Paid bookings', 'count', 'payment', BUSINESS_CUSTOMER_DEFINITIONS.paid_bookings],
    ['amount_paid', 'Amount paid', 'money', 'payment', BUSINESS_CUSTOMER_DEFINITIONS.amount_paid],
    ['booked_value', 'Booked value', 'money', 'price', BUSINESS_CUSTOMER_DEFINITIONS.booked_value],
    ['unknown_payment_count', 'Unknown payment records', 'count', 'ledger', 'Active value-bearing appointments without a valid native amount_paid field.'],
  ] as const
  return { ...businessDurationMetrics(context, rows, previousRows, entityId, upcoming),
    ...Object.fromEntries(entries.filter(([key]) => upcoming ? key !== 'paid_bookings' : key !== 'unknown_payment_count')
    .map(([field, label, unit, basis, definition]) => {
      const key = upcoming && field === 'bookings' ? 'recorded_bookings' : field
      return [key, makeReportMetric({
        ...common(context, entityId), key, label, unit, definition,
        current: upcoming && !rows.length ? null : current[field], previous: previous?.[field],
        coverage: upcoming ? { ...current[basis], state: 'partial' } : current[basis],
        previousCoverage: previous?.[basis],
        reason: upcoming && !rows.length ? 'No qualifying future records were observed; future source completeness is unverified.'
          : 'No valid native field was observed in this cohort.',
        ...(upcoming ? { comparison: 'none' as const, basis: 'service_date_et' as const } : {}),
      })]
    })) }
}

function customerCohort(history: readonly Row[], range: ReportingRange) {
  const rows = history.filter(row => inRange(row.booking_date_et, range))
  const priorIdentities = new Set(history.filter(row => row.booking_date_et! < range.from).map(identity).filter(Boolean))
  const identified = new Map<string, Row[]>()
  const groups: Record<typeof CUSTOMER_GROUPS[number]['id'], Row[]> = { prior_booking: [], first_observed: [], unidentified: [] }
  for (const row of rows) {
    const email = identity(row)
    if (email) identified.set(email, [...(identified.get(email) ?? []), row])
    const id = email ? priorIdentities.has(email) ? 'prior_booking' : 'first_observed' : 'unidentified'
    groups[id].push(row)
  }
  const priorCustomers = [...identified.keys()].filter(email => priorIdentities.has(email)).length
  return { groups, counts: {
    identified_customers: identified.size,
    prior_booking_customers: priorCustomers,
    first_observed_customers: identified.size - priorCustomers,
    unidentified_bookings: groups.unidentified.length,
    multiple_booking_customers: [...identified.values()].filter(values => values.length > 1).length,
  }, coverage: coverage(rows.length - groups.unidentified.length, rows.length, true) }
}

export function buildBusinessCustomers(
  context: ReportingContext, rows: readonly Row[], observedThrough = etDateOf(context.asOf),
): ReportSection<BusinessCustomers> {
  const unique = uniqueRows(rows)
  const retained = unique.filter(row => row.booking_date_et !== null
    && ReportingDateSchema.safeParse(row.booking_date_et).success && row.booking_date_et <= context.range.to)
  const history = retained.filter(activeValueBearing)
  const current = customerCohort(history, context.range)
  const previous = customerCohort(history, context.comparison)
  const labels = CUSTOMER_LABELS
  const metrics = Object.fromEntries(Object.entries(labels).map(([key, label]) => [key, makeReportMetric({
    ...common(context, `${context.account.id}:customers`), key, label, unit: 'count',
    definition: BUSINESS_CUSTOMER_DEFINITIONS[key],
    current: current.counts[key as keyof typeof labels], previous: previous.counts[key as keyof typeof labels],
    coverage: current.coverage, previousCoverage: previous.coverage,
  })]))
  const groups = CUSTOMER_GROUPS.map(({ id, name }) => {
    const entityId = `${context.account.id}:customers:${id}`
    const count = (values: readonly Row[]) => new Set(values.map(identity).filter(Boolean)).size
    return { id, name, metrics: {
      customers: makeReportMetric({ ...common(context, entityId), key: 'customers', label: 'Customers', unit: 'count',
        definition: BUSINESS_CUSTOMER_DEFINITIONS.customers,
        current: id === 'unidentified' ? null : count(current.groups[id]),
        previous: id === 'unidentified' ? null : count(previous.groups[id]),
        coverage: coverage(id === 'unidentified' ? 0 : current.groups[id].length, current.groups[id].length, true),
        previousCoverage: coverage(id === 'unidentified' ? 0 : previous.groups[id].length, previous.groups[id].length, true),
        reason: 'Customer identity is unavailable.',
        previousReason: 'Customer identity is unavailable.',
      }),
      ...nativeMetrics(context, current.groups[id], previous.groups[id], entityId),
    } }
  })
  return { state: 'partial', asOf: context.asOf, data: { metrics, groups,
    historyFrom: retained.map(row => row.booking_date_et!).sort()[0] ?? null, historyTo: context.range.to,
    identityBasis: 'normalized_email', historyCoverage: 'retained_ledger',
    followup: buildBusinessCustomerFollowup(context, unique, observedThrough),
  }, notes: [
    'Customer identity uses valid trimmed, lowercased email only. Missing identities retain their booking and monetary contributions.',
    'First observed in the retained ledger is not a confirmed newly acquired customer. Earlier history outside the retained ledger is unknown; same-day bookings do not establish earlier sequence.',
    'Both booking-created cohorts use current mutable ledger facts, not historical customer or payment snapshots.',
    'Follow-up includes only identities first observed in each cohort within retained history; first observed does not establish acquisition. Equal 7-, 14- and 30-day horizons use current mutable ledger facts through the stated observation date.',
  ] }
}

function leadSample(rows: readonly Row[], range: ReportingRange) {
  const eligible = rows.filter(row => inRange(row.booking_date_et, range))
  const durations = eligible.flatMap(row => {
    if (!timestampSchema.safeParse(row.datetime_created).success || !timestampSchema.safeParse(row.datetime).success) return []
    const duration = (Date.parse(row.datetime!) - Date.parse(row.datetime_created!)) / 86_400_000
    return Number.isFinite(duration) && duration >= 0 ? [duration] : []
  }).sort((left, right) => left - right)
  return { eligible: eligible.length, durations, coverage: coverage(durations.length, eligible.length) }
}

function quantile(values: readonly number[], fraction: number): number | null {
  if (!values.length) return null
  const position = (values.length - 1) * fraction
  const lower = Math.floor(position)
  return values[lower] + (values[Math.ceil(position)] - values[lower]) * (position - lower)
}

export function buildBusinessLeadTime(context: ReportingContext, rows: readonly Row[]): ReportSection<BusinessLeadTime> {
  const eligible = uniqueRows(rows).filter(activeValueBearing)
  const current = leadSample(eligible, context.range)
  const previous = leadSample(eligible, context.comparison)
  const base = common(context, `${context.account.id}:lead_time`)
  const quantiles = [['median_lead_days', 'Median lead time', 0.5], ['p25_lead_days', '25th percentile lead time', 0.25],
    ['p75_lead_days', '75th percentile lead time', 0.75], ['p90_lead_days', '90th percentile lead time', 0.9]] as const
  const metrics = Object.fromEntries(quantiles.map(([key, label, fraction]) => [key, makeReportMetric({
    ...base, key, label, unit: 'days', definition: 'Linear-interpolated quantile of nonnegative elapsed days from native booking creation to current recorded service start among valid offset-aware timestamps.',
    current: quantile(current.durations, fraction), previous: quantile(previous.durations, fraction),
    coverage: current.coverage, previousCoverage: previous.coverage,
    reason: 'No valid booking-to-service durations were observed.', previousReason: 'No valid booking-to-service durations were observed.',
  })]))
  for (const [key, label, measure] of [['eligible_bookings', 'Eligible bookings', 'eligible'], ['dated_bookings', 'Dated bookings', 'dated']] as const) {
    metrics[key] = makeReportMetric({ ...base, key, label, unit: 'count',
      definition: measure === 'eligible' ? 'Unique active value-bearing bookings created in the cohort, including records without valid lead-time timestamps.'
        : 'Eligible bookings with valid offset-aware creation and service timestamps and a nonnegative elapsed duration.',
      current: measure === 'eligible' ? current.eligible : current.durations.length,
      previous: measure === 'eligible' ? previous.eligible : previous.durations.length,
      coverage: current.coverage, previousCoverage: previous.coverage,
    })
  }
  const buckets = LEAD_BUCKETS.map(({ id, name, from, to }) => ({ id, name, metrics: {
    bookings: makeReportMetric({ ...common(context, `${context.account.id}:lead_time:${id}`), key: 'bookings', label: 'Bookings', unit: 'count',
      definition: `Valid booking-to-service durations of ${name.toLowerCase()}; only dated bookings contribute to this sample.`,
      current: current.durations.filter(days => days >= from && days < to).length,
      previous: previous.durations.filter(days => days >= from && days < to).length,
      coverage: current.coverage, previousCoverage: previous.coverage,
    }),
  } }))
  return { state: !current.durations.length || current.coverage.state === 'partial' || previous.coverage.state === 'partial' ? 'partial' : 'available',
    asOf: context.asOf, data: { metrics, buckets }, notes: [
      'Booking-to-service lead time is not ad-touch conversion lag. It uses current stored service and creation timestamps, not historical schedule snapshots.',
      `${current.durations.length} of ${current.eligible} current bookings and ${previous.durations.length} of ${previous.eligible} prior bookings have valid durations; missing, invalid or negative durations are excluded.`,
    ] }
}

export function buildBusinessUpcoming(
  context: ReportingContext, rows: readonly Row[], observedAt: string,
): ReportSection<BusinessUpcoming> {
  if (!timestampSchema.safeParse(observedAt).success) throw new Error('business_observation_time_invalid')
  const futureContext = upcomingBusinessContext(context, observedAt)
  const retained = uniqueRows(rows).filter(row => activeValueBearing(row)
    && timestampSchema.safeParse(row.datetime).success && inRange(etDateOf(row.datetime!), futureContext.range))
  const dates = [...new Set(retained.map(row => etDateOf(row.datetime!)))].sort()
  const types = [...groupBusinessAppointmentTypes(retained)].map(([id, values]) => ({ id,
    name: businessAppointmentTypeName(values), metrics: nativeMetrics(futureContext, values, undefined,
      `${context.account.id}:upcoming:type:${id}`, true),
  })).sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id))
  return { state: 'partial', asOf: observedAt, data: {
    range: futureContext.range,
    metrics: nativeMetrics(futureContext, retained, undefined, `${context.account.id}:upcoming`, true),
    days: dates.map(date => ({ date, metrics: nativeMetrics({ ...futureContext, range: { from: date, to: date } },
      retained.filter(row => etDateOf(row.datetime!) === date), undefined, `${context.account.id}:upcoming:day:${date}`, true) })),
    types,
  }, notes: [
    'Future source completeness is unverified. Recorded active value-bearing bookings are a partial retained-ledger workload, not a complete schedule.',
    'Only observed dates and appointment types are shown. Empty reads and omitted dates do not establish open slots or available capacity.',
    'The horizon is tomorrow through the next 28 ET calendar days at observation time. Current stored status, type and service dates do not establish historical schedule or booking pickup.',
  ] }
}
