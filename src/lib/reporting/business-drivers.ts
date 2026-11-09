import { ReportingContextSchema, type ReportingData, type ReportMetric } from './contracts'
import type { ReviewEvidence } from './review/contracts'
import { metricEvidence } from './review/evidence'
import { compareCreativeEvidenceInstants as compareInstants } from './creative-assignment-contract'
import { BUSINESS_DRIVER_DEFINITIONS } from './business-driver-definitions'

export interface BusinessDriverPeriod {
  bookedValue: number | null
  bookings: number | null
  valuePerBooking: number | null
  recordedHours: number | null
}
export interface BusinessDriverRow {
  id: string
  name: string
  category: 'rental' | 'photography' | 'unknown'
  rowIndex: number | null
  current: BusinessDriverPeriod
  prior: BusinessDriverPeriod
  change: BusinessDriverPeriod
  decomposition: {
    state: 'matched' | 'current_only' | 'prior_only' | 'empty' | 'unavailable'
    bookingCount: number | null
    valuePerBooking: number | null
    wholeContribution: number | null
  }
  evidence: {
    bookedValue: ReviewEvidence | null
    bookings: ReviewEvidence | null
    recordedHours: ReviewEvidence | null
    durationRecordedBookings: ReviewEvidence | null
    durationCoverage: ReviewEvidence | null
  }
  limitations: string[]
}
export interface BusinessDriverReconciliation {
  headline: number | null
  serviceSum: number | null
  residual: number | null
  state: 'reconciled' | 'residual' | 'unavailable'
}
export interface BusinessDrivers {
  state: 'available' | 'partial' | 'unavailable'
  sourceAsOf: string | null
  account: BusinessDriverRow
  services: BusinessDriverRow[]
  reconciliation: { current: BusinessDriverReconciliation; prior: BusinessDriverReconciliation }
  limitations: string[]
}

type Period = 'current' | 'prior'
type Claim = ReportMetric['current']
type Key = keyof BusinessDriverRow['evidence']
const FIELDS = {
  bookedValue: ['booked_value', 'money'], bookings: ['value_bearing_bookings', 'count'],
  recordedHours: ['recorded_booked_hours', 'hours'], durationRecordedBookings: ['duration_recorded_bookings', 'count'],
  durationCoverage: ['duration_coverage', 'percent'],
} as const
const claimOf = (ref: ReviewEvidence | null, period: Period) => period === 'current' ? ref?.metric.current : ref?.metric.previous
const finite = (value: number): number | null => Number.isFinite(value) ? value : null
const difference = (a: number | null, b: number | null) => a === null || b === null ? null : finite(a - b)
const close = (a: number, b: number, scale: number, terms = 2) => Math.abs(a - b) <= Number.EPSILON * Math.max(1, scale) * Math.max(4, terms + 1)

function validSource(data: ReportingData): boolean {
  try {
    return ReportingContextSchema.safeParse(data.context).success && ['available', 'partial'].includes(data.business.state)
      && data.business.data !== null && data.business.asOf !== null && compareInstants(data.business.asOf, data.context.asOf) <= 0
  } catch { return false }
}
function nativeClaim(data: ReportingData, ref: ReviewEvidence | null, key: Key, entityId: string, period: Period): Claim | null {
  if (!ref) return null
  const claim = claimOf(ref, period), metric = ref.metric, [metricKey, unit] = FIELDS[key]
  const definition = BUSINESS_DRIVER_DEFINITIONS[metricKey], range = period === 'current' ? data.context.range : data.context.comparison
  if (!claim || metric.key !== metricKey || metric.event !== null || metric.definition !== definition
    || claim.metricKey !== `outcomes.${metricKey}` || claim.formula !== definition.slice(0, 500) || claim.definitionVersion !== 1
    || claim.source.system !== 'outcomes' || claim.source.role !== 'business_truth' || claim.source.evidencePlane !== 'outcome_business'
    || claim.entity.level !== 'business' || claim.entity.id !== entityId || claim.unit !== unit
    || claim.attributionScope !== 'all_sources' || claim.measurementKind !== 'operational'
    || claim.authority.state !== 'diagnostic' || claim.authority.policyVersion !== 'reporting-v1'
    || claim.window.start !== range.from || claim.window.end !== range.to || claim.window.timezone !== data.context.timezone
    || claim.window.basis !== 'booking_created_date_et' || claim.coverage.state !== 'complete'
    || claim.freshness.state === 'stale' || claim.maturity.state === 'partial'
    || claim.availability.state !== 'available' || typeof claim.value !== 'number' || !Number.isFinite(claim.value) || claim.value < 0
    || unit === 'count' && !Number.isSafeInteger(claim.value)
    || !Number.isSafeInteger(claim.coverage.numerator) || claim.coverage.numerator !== claim.coverage.denominator) return null
  try {
    if (compareInstants(claim.asOf, data.business.asOf!) !== 0
      || claim.freshness.observedAt && compareInstants(claim.freshness.observedAt, claim.asOf) > 0) return null
  } catch { return null }
  const comparison = claim.comparison
  if (period === 'prior' ? comparison.method !== 'none' || comparison.window !== null
    : comparison.method !== 'prior_equal_period' || comparison.window?.start !== data.context.comparison.from
      || comparison.window?.end !== data.context.comparison.to || comparison.window?.basis !== claim.window.basis
      || comparison.window?.timezone !== data.context.timezone) return null
  return claim
}
function observationMatches(a: Claim, b: Claim): boolean {
  try { return a.source.head === b.source.head && a.setupFingerprint === b.setupFingerprint && compareInstants(a.asOf, b.asOf) === 0 }
  catch { return false }
}
function pairedPopulation(data: ReportingData, refs: BusinessDriverRow['evidence'], entity: string, period: Period): boolean {
  const value = nativeClaim(data, refs.bookedValue, 'bookedValue', entity, period)
  const count = nativeClaim(data, refs.bookings, 'bookings', entity, period)
  return !!value && !!count && observationMatches(value, count) && value.coverage.denominator === count.coverage.denominator
    && (count.value as number) <= count.coverage.denominator! && ((count.value === 0) === (value.value === 0))
}
function periodValues(data: ReportingData, refs: BusinessDriverRow['evidence'], entity: string, period: Period): BusinessDriverPeriod {
  const value = nativeClaim(data, refs.bookedValue, 'bookedValue', entity, period)
  const count = nativeClaim(data, refs.bookings, 'bookings', entity, period)
  const bookedValue = value?.value as number | undefined ?? null
  const bookings = count && (count.value as number) <= count.coverage.denominator! ? count.value as number : null
  const hours = nativeClaim(data, refs.recordedHours, 'recordedHours', entity, period)
  const dated = nativeClaim(data, refs.durationRecordedBookings, 'durationRecordedBookings', entity, period)
  const coverage = nativeClaim(data, refs.durationCoverage, 'durationCoverage', entity, period)
  const completeHours = count && bookings !== null && hours && dated && observationMatches(count, hours) && observationMatches(count, dated)
    && hours.coverage.denominator === bookings && dated.value === bookings && dated.coverage.denominator === bookings
    && (bookings === 0 ? hours.value === 0 : (hours.value as number) > 0 && coverage?.value === 100 && coverage.coverage.denominator === bookings && observationMatches(count, coverage))
  const average = bookings !== null && bookings > 0 && bookedValue !== null && pairedPopulation(data, refs, entity, period)
    ? finite(bookedValue / bookings) : null
  return { bookedValue, bookings, valuePerBooking: average !== null && average > 0 ? average : null,
    recordedHours: completeHours ? hours.value as number : null }
}
function decompose(current: BusinessDriverPeriod, prior: BusinessDriverPeriod, change: BusinessDriverPeriod, paired: boolean): BusinessDriverRow['decomposition'] {
  const empty = { state: 'unavailable' as const, bookingCount: null, valuePerBooking: null, wholeContribution: null }
  if (!paired || change.bookedValue === null || change.bookings === null || current.bookings === null || prior.bookings === null) return empty
  if (current.bookings === 0 || prior.bookings === 0) return { ...empty,
    state: current.bookings === 0 ? prior.bookings === 0 ? 'empty' : 'prior_only' : 'current_only', wholeContribution: change.bookedValue }
  if (current.valuePerBooking === null || prior.valuePerBooking === null) return empty
  const bookingCount = (current.bookings - prior.bookings) * (current.valuePerBooking / 2 + prior.valuePerBooking / 2)
  const valuePerBooking = (current.valuePerBooking - prior.valuePerBooking) * (current.bookings / 2 + prior.bookings / 2)
  if (![bookingCount, valuePerBooking, bookingCount + valuePerBooking].every(Number.isFinite)
    || !close(bookingCount + valuePerBooking, change.bookedValue, Math.max(current.bookedValue!, prior.bookedValue!, Math.abs(bookingCount), Math.abs(valuePerBooking)))) return empty
  return { state: 'matched', bookingCount, valuePerBooking, wholeContribution: null }
}
function driverRow(data: ReportingData, identity: Pick<BusinessDriverRow, 'id' | 'name' | 'category' | 'rowIndex'>, allowed: boolean, duplicate = false): BusinessDriverRow {
  const entity = identity.rowIndex === null ? data.context.account.id : `${data.context.account.id}:type:${identity.id}`.slice(0, 160)
  const path = identity.rowIndex === null ? ['metrics'] : ['types', identity.rowIndex, 'metrics']
  const evidence = Object.fromEntries(Object.entries(FIELDS).map(([field, [key]]) => {
    const ref = allowed && !duplicate ? metricEvidence(data, 'business', [...path, key]) : null
    return [field, ref && (nativeClaim(data, ref, field as Key, entity, 'current') || nativeClaim(data, ref, field as Key, entity, 'prior')) ? ref : null]
  })) as BusinessDriverRow['evidence']
  const current = periodValues(data, evidence, entity, 'current'), prior = periodValues(data, evidence, entity, 'prior')
  const change = Object.fromEntries(Object.keys(current).map(key => {
    const ref = evidence[key === 'valuePerBooking' ? 'bookedValue' : key as Key]
    const a = claimOf(ref, 'current'), b = claimOf(ref, 'prior')
    return [key, a && b && observationMatches(a, b) ? difference(current[key as keyof BusinessDriverPeriod], prior[key as keyof BusinessDriverPeriod]) : null]
  })) as unknown as BusinessDriverPeriod
  const paired = pairedPopulation(data, evidence, entity, 'current') && pairedPopulation(data, evidence, entity, 'prior')
  const decomposition = decompose(current, prior, change, paired)
  return { ...identity, current, prior, change, decomposition, evidence, limitations: [
    ...(duplicate ? ['Duplicate or ambiguous native service identity; this row cannot enter driver arithmetic.'] : []),
    ...(['current', 'prior'] as const).flatMap(period => {
      const value = period === 'current' ? current : prior
      return [value.bookedValue === null ? `${period}: compatible booked-value evidence is unavailable.` : '',
        value.bookings === null ? `${period}: compatible value-bearing booking-count evidence is unavailable.` : '',
        value.bookedValue !== null && value.bookings !== null && !pairedPopulation(data, evidence, entity, period)
          ? `${period}: booked value and booking count have incompatible coverage, source observations or zero/nonzero populations; their average and driver split are withheld.` : '',
        value.recordedHours === null ? `${period}: optional recorded hours are unavailable or duration coverage is incomplete.` : ''].filter(Boolean)
    }),
    ...(decomposition.state === 'unavailable' ? ['The signed two-period driver split is unavailable; incomplete or incompatible evidence and nonfinite arithmetic are not replaced with zero.'] : []),
  ] }
}
function reconcile(account: BusinessDriverRow, services: BusinessDriverRow[], period: Period): BusinessDriverReconciliation {
  const headline = account[period].bookedValue, values = services.map(row => row[period].bookedValue)
  const first = headline !== null ? claimOf(account.evidence.bookedValue, period) : claimOf(services[0]?.evidence.bookedValue ?? null, period)
  const matched = services.every(row => { const claim = claimOf(row.evidence.bookedValue, period); return first && claim && observationMatches(first, claim) })
  const sum = (services.length > 0 || headline !== null) && matched && values.every(value => value !== null)
    ? finite(values.reduce<number>((total, value) => total + value!, 0)) : null
  const residual = difference(headline, sum)
  return { headline, serviceSum: sum, residual, state: residual === null ? 'unavailable'
    : close(headline!, sum!, Math.max(headline!, sum!), services.length) ? 'reconciled' : 'residual' }
}

/** Observed arithmetic over this supplied native ledger snapshot; no source reads or causal estimates. */
export function deriveBusinessDrivers(data: ReportingData): BusinessDrivers {
  const allowed = validSource(data), rows = data.business.data?.types ?? []
  const ids = new Map<string, number>(), scoped = new Map<string, number>()
  for (const row of rows) {
    ids.set(row.id, (ids.get(row.id) ?? 0) + 1)
    const entity = `${data.context.account.id}:type:${row.id}`.slice(0, 160)
    scoped.set(entity, (scoped.get(entity) ?? 0) + 1)
  }
  const account = driverRow(data, { id: data.context.account.id, name: data.context.account.name ?? 'Outcome source account', category: 'unknown', rowIndex: null }, allowed)
  const services = rows.map((row, rowIndex) => driverRow(data, { id: row.id, name: row.name, category: row.category, rowIndex }, allowed,
    ids.get(row.id)! > 1 || scoped.get(`${data.context.account.id}:type:${row.id}`.slice(0, 160))! > 1))
  const reconciliation = { current: reconcile(account, services, 'current'), prior: reconcile(account, services, 'prior') }
  const available = [account, ...services].some(row => row.current.bookedValue !== null || row.prior.bookedValue !== null)
  const complete = Object.values(reconciliation).every(value => value.state === 'reconciled')
    && [account, ...services].every(row => row.decomposition.state !== 'unavailable')
  return { state: !available ? 'unavailable' : complete ? 'available' : 'partial', sourceAsOf: allowed ? data.business.asOf : null,
    account, services, reconciliation, limitations: [
      'Outcome source all-source booking-created cohorts describe current mutable ledger facts, not original booking-time prices or historical schedule snapshots.',
      'The symmetric components are arithmetic, not causal effects, pure price changes, a global between-service mix effect or profit.',
      'Payment and optional intelligence fields do not determine scheduled booked-value drivers. Hours require their own complete recorded-duration population.',
      ...(Object.values(reconciliation).some(value => value.state !== 'reconciled') ? ['Supplied service rows do not fully reconcile to the account in both periods; residuals and unavailable populations remain explicit.'] : []),
    ] }
}
