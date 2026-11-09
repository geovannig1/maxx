import type { SupabaseClient } from '@supabase/supabase-js'
import { classifyBusinessState, type BusinessState } from '@/lib/outcomes/business-facts'
import { getConfirmationFacts, type ConfirmationFacts } from '@/lib/outcomes/confirmation-facts'
import { requireOutcomeLedgerHealth } from '@/lib/outcomes/source-health'
import {
  readPaidTouchAdAssignments,
  type PaidTouchAdAssignmentRead,
} from '@/lib/economics/paid-touch-assignment-reader'
import { getAdminClient } from '@/lib/supabase/admin'
import { requireOutcomeCurrency } from '@/lib/outcomes/aggregation'
import { makeReportMetric, UNKNOWN_FIELD_COVERAGE } from './claims'
import { summarizePaidTouchBookingLag, type PaidTouchBookingLagSummary } from './measurement-lag'
import type {
  MeasurementReport,
  ReportMetricMap,
  ReportSection,
  ReportingContext,
  ReportingRange,
} from './contracts'

const PAGE_SIZE = 1_000
const MAX_OUTCOMES = 10_000

interface MeasurementLedgerRow {
  /** The outcome uuid: the key paid-touch links are recorded under, for every source. */
  id: string
  price: number | null
  amount_paid: number | null
  canceled: boolean | null
  business_state: BusinessState | null
  booking_date_et: string | null
}

/** A `v_business_outcomes` row as read here (enabled sources only; state 'cancelled' in the database). */
interface MeasurementOutcomeRow {
  id: string
  currency: string
  price: number | null
  amount_paid: number | null
  status: string
  business_state: string | null
  booking_date_et: string | null
}

/** Read boundary: the outcome uuid is the cohort key the paid-touch reader expects. */
function toMeasurementLedgerRow({ status, business_state, currency, ...row }: MeasurementOutcomeRow): MeasurementLedgerRow {
  void currency // checked for the whole page by requireOutcomeCurrency; not part of the ledger row
  return {
    ...row,
    canceled: status === 'cancelled' || status === 'refunded',
    business_state: (business_state === 'cancelled' ? 'canceled' : business_state) as BusinessState | null,
  }
}

interface PaidWindowRead {
  cohortSize: number
  linkedCount: number
  lag: PaidTouchBookingLagSummary
}

const SOURCE_DESCRIPTION =
  'Paid association uses immutable first-party paid-touch links for active value-bearing bookings created in the selected account-timezone dates. Paid-touch lag uses observed touch and booking-created timestamps only for linked eligible bookings. CAPI delivery uses live-accepted lineage for website confirmations created in those dates. Confirmation delivery does not establish current appointment status.'

function sameLedgerRow(left: MeasurementLedgerRow, right: MeasurementLedgerRow): boolean {
  return left.id === right.id
    && left.price === right.price
    && left.amount_paid === right.amount_paid
    && left.canceled === right.canceled
    && left.business_state === right.business_state
    && left.booking_date_et === right.booking_date_et
}

function uniqueLedgerRows(rows: readonly MeasurementLedgerRow[]): MeasurementLedgerRow[] {
  const byId = new Map<string, MeasurementLedgerRow>()
  for (const row of rows) {
    const existing = byId.get(row.id)
    if (existing && !sameLedgerRow(existing, row)) {
      throw new Error('paid_association_conflicting_ledger_row')
    }
    if (!existing) byId.set(row.id, row)
  }
  return [...byId.values()]
}

async function readLedgerWindow(
  client: SupabaseClient,
  accountId: string,
  range: ReportingRange,
  currency: string,
): Promise<MeasurementLedgerRow[]> {
  const rows: MeasurementLedgerRow[] = []
  for (let from = 0; from <= MAX_OUTCOMES; from += PAGE_SIZE) {
    const { data, error } = await client
      .from('v_business_outcomes')
      .select('id, currency, price:gross_value, amount_paid:collected_value, status, business_state, booking_date_et:business_date')
      .eq('ad_account_id', accountId)
      .eq('source_enabled', true)
      .gte('business_date', range.from)
      .lte('business_date', range.to)
      .order('id', { ascending: true })
      .range(from, from + PAGE_SIZE - 1)
    if (error) throw new Error('paid_association_ledger_read_unavailable')
    if (!Array.isArray(data)) throw new Error('paid_association_ledger_read_unavailable')
    requireOutcomeCurrency(data as MeasurementOutcomeRow[], currency)
    const page = (data as MeasurementOutcomeRow[]).map(toMeasurementLedgerRow)
    rows.push(...page)
    if (rows.length > MAX_OUTCOMES) throw new Error('paid_association_cohort_too_large')
    if (page.length < PAGE_SIZE) return uniqueLedgerRows(rows)
  }
  throw new Error('paid_association_cohort_too_large')
}

function activeValueBearingRows(rows: readonly MeasurementLedgerRow[]): MeasurementLedgerRow[] {
  return uniqueLedgerRows(rows)
    .filter(row => (row.business_state ?? classifyBusinessState(row)) === 'active_value_bearing')
    .sort((left, right) => left.id.localeCompare(right.id))
}

function expectedBookingDates(rows: readonly MeasurementLedgerRow[]): Map<string, string> {
  return new Map(rows.flatMap(row => row.booking_date_et === null ? [] : [[row.id, row.booking_date_et]]))
}

function validateAssignmentRead(
  outcomeIds: readonly string[],
  read: PaidTouchAdAssignmentRead,
  asOf: string,
  expectedBookingDateByOutcomeId: ReadonlyMap<string, string>,
): PaidWindowRead {
  const requested = new Set(outcomeIds)
  const assigned = new Set<string>()
  if (read.requestedOutcomeCount !== outcomeIds.length) {
    throw new Error('paid_association_assignment_count_mismatch')
  }
  for (const assignment of read.assignments) {
    if (!requested.has(assignment.outcomeId) || assigned.has(assignment.outcomeId)) {
      throw new Error('paid_association_assignment_population_mismatch')
    }
    assigned.add(assignment.outcomeId)
  }
  for (const outcomeId of read.incompleteIdentityOutcomeIds) {
    if (!requested.has(outcomeId) || assigned.has(outcomeId)) {
      throw new Error('paid_association_assignment_population_mismatch')
    }
    assigned.add(outcomeId)
  }
  return {
    cohortSize: outcomeIds.length,
    linkedCount: assigned.size,
    lag: summarizePaidTouchBookingLag({
      assignments: read.assignments, linkedCount: assigned.size, asOf, expectedBookingDateByOutcomeId,
    }),
  }
}

async function readPaidWindow(
  client: SupabaseClient,
  context: ReportingContext,
  range: ReportingRange,
  asOf: string,
): Promise<PaidWindowRead> {
  const activeRows = activeValueBearingRows(await readLedgerWindow(client, context.account.id, range, context.currency))
  const outcomeIds = activeRows.map(row => row.id)
  const read = await readPaidTouchAdAssignments(client, context.account.id, outcomeIds, asOf)
  return validateAssignmentRead(outcomeIds, read, asOf, expectedBookingDates(activeRows))
}

function paidCoverage(read: PaidWindowRead | null) {
  return read === null
    ? UNKNOWN_FIELD_COVERAGE
    : { state: 'partial' as const, numerator: read.linkedCount, denominator: read.cohortSize }
}

function paidValue(read: PaidWindowRead | null): number | null {
  return read !== null && read.linkedCount > 0 ? read.linkedCount : null
}

function lagCoverage(read: PaidWindowRead | null) {
  return read === null || read.lag.linkedCount <= 0
    ? UNKNOWN_FIELD_COVERAGE
    : { state: 'partial' as const, numerator: read.lag.sampleCount, denominator: read.lag.linkedCount }
}

function lagSampleValue(read: PaidWindowRead | null): number | null {
  return read !== null && read.lag.sampleCount > 0 ? read.lag.sampleCount : null
}

function lagReason(read: PaidWindowRead | null): string {
  return read === null ? 'paid_association_read_unavailable' : read.lag.blocker
}

function paidMetrics(
  context: ReportingContext,
  current: PaidWindowRead | null,
  previous: PaidWindowRead | null,
): ReportMetricMap {
  return {
    linked_value_bearing_bookings: makeReportMetric({
      context,
      key: 'linked_value_bearing_bookings',
      label: 'Paid-linked value-bearing bookings',
      definition: 'Observed lower bound of unique active value-bearing bookings created in the selected account-timezone dates with an immutable first-party paid-touch link. Incomplete Meta ad identity remains an account-level paid link; a missing link does not prove an organic booking because exact-window capture and linker completeness are unproven.',
      source: 'first_party_attribution',
      unit: 'count',
      current: paidValue(current),
      previous: paidValue(previous),
      entity: { level: 'business', id: context.account.id },
      coverage: paidCoverage(current),
      previousCoverage: paidCoverage(previous),
      reason: current === null ? 'paid_association_read_unavailable' : 'paid_linker_completeness_unproven',
      previousReason: previous === null ? 'paid_association_read_unavailable' : 'paid_linker_completeness_unproven',
      measurementKind: 'associated_noncausal',
      attributionScope: 'meta_click_associated_noncausal',
      basis: 'booking_created_date_et',
      sourceHead: context.asOf,
    }),
    paid_touch_booking_lag_sample_bookings: makeReportMetric({
      context,
      key: 'paid_touch_booking_lag_sample_bookings',
      label: 'Paid-touch booking-lag sample bookings',
      definition: 'Count of linked eligible bookings whose immutable paid-touch assignment included valid observed paid-touch timestamp and booking-created timestamp chronology. Missing samples do not imply zero lag or a complete paid cohort.',
      source: 'first_party_attribution',
      unit: 'count',
      current: lagSampleValue(current),
      previous: lagSampleValue(previous),
      entity: { level: 'business', id: context.account.id },
      coverage: lagCoverage(current),
      previousCoverage: lagCoverage(previous),
      reason: lagReason(current),
      previousReason: lagReason(previous),
      measurementKind: 'associated_noncausal',
      basis: 'booking_created_date_et',
      sourceHead: context.asOf,
    }),
    median_paid_touch_to_booking_lag_days: makeReportMetric({
      context,
      key: 'median_paid_touch_to_booking_lag_days',
      label: 'Median paid-touch to booking lag',
      definition: 'Median elapsed days from the observed paid-touch timestamp to recorded booking creation among linked eligible bookings with valid chronology. This is paid-touch association timing, not a causal conversion window or booking-to-service lead time.',
      source: 'first_party_attribution',
      unit: 'days',
      current: current?.lag.medianDays ?? null,
      previous: previous?.lag.medianDays ?? null,
      entity: { level: 'business', id: context.account.id },
      coverage: lagCoverage(current),
      previousCoverage: lagCoverage(previous),
      reason: lagReason(current),
      previousReason: lagReason(previous),
      measurementKind: 'associated_noncausal',
      basis: 'booking_created_date_et',
      sourceHead: context.asOf,
    }),
    p90_paid_touch_to_booking_lag_days: makeReportMetric({
      context,
      key: 'p90_paid_touch_to_booking_lag_days',
      label: 'P90 paid-touch to booking lag',
      definition: 'Empirical nearest-rank p90 elapsed days from the observed paid-touch timestamp to recorded booking creation in the linked eligible sample. The p90 is computed with exact retained timestamp fractions before display rounding and does not describe unlinked or unconverted visitors.',
      source: 'first_party_attribution',
      unit: 'days',
      current: current?.lag.p90Days ?? null,
      previous: previous?.lag.p90Days ?? null,
      entity: { level: 'business', id: context.account.id },
      coverage: lagCoverage(current),
      previousCoverage: lagCoverage(previous),
      reason: lagReason(current),
      previousReason: lagReason(previous),
      measurementKind: 'associated_noncausal',
      basis: 'booking_created_date_et',
      sourceHead: context.asOf,
    }),
    longest_paid_touch_to_booking_lag_days: makeReportMetric({
      context,
      key: 'longest_paid_touch_to_booking_lag_days',
      label: 'Longest observed paid-touch to booking lag',
      definition: 'Longest elapsed days from the observed paid-touch timestamp to recorded booking creation in the validated linked eligible sample. It describes retained observed timing only; it does not establish unconverted visitor behavior.',
      source: 'first_party_attribution',
      unit: 'days',
      current: current?.lag.longestDays ?? null,
      previous: previous?.lag.longestDays ?? null,
      entity: { level: 'business', id: context.account.id },
      coverage: lagCoverage(current),
      previousCoverage: lagCoverage(previous),
      reason: lagReason(current),
      previousReason: lagReason(previous),
      measurementKind: 'associated_noncausal',
      basis: 'booking_created_date_et',
      sourceHead: context.asOf,
    }),
  }
}

type ConfirmationMetricKey =
  | 'eligible_website_confirmations'
  | 'accepted_live_confirmations'
  | 'origin_unknown_confirmations'
  | 'legacy_stamp_unverified'

interface ConfirmationMetricDefinition {
  key: ConfirmationMetricKey
  label: string
  definition: string
  value: (facts: ConfirmationFacts) => number
  population: (facts: ConfirmationFacts) => number
}

const CAPI_METRICS: readonly ConfirmationMetricDefinition[] = [
  {
    key: 'eligible_website_confirmations',
    label: 'CAPI-eligible website confirmations',
    definition: 'Website-origin confirmations created in the selected account-timezone dates. Delivery counts the confirmation event when it occurred; it does not establish current appointment status.',
    value: facts => facts.websiteConfirmations,
    population: facts => facts.totalConfirmations,
  },
  {
    key: 'accepted_live_confirmations',
    label: 'Live-accepted CAPI confirmations',
    definition: 'Website-origin confirmations in the selected creation-date cohort with a conversion_deliveries live_accepted_at lineage marker. Test sends and legacy parent timestamps do not count as accepted.',
    value: facts => facts.websiteWithAcceptedCapi,
    population: facts => facts.websiteConfirmations,
  },
  {
    key: 'origin_unknown_confirmations',
    label: 'Confirmations with unknown origin',
    definition: 'Confirmations created in the selected dates whose website versus staff/manual origin was not established. They are excluded from CAPI eligibility rather than assumed either way.',
    value: facts => facts.originUnknownConfirmations,
    population: facts => facts.totalConfirmations,
  },
  {
    key: 'legacy_stamp_unverified',
    label: 'Unverified legacy CAPI stamps',
    definition: 'Website confirmations carrying a legacy capi_sent_at timestamp without live-accepted delivery lineage. These timestamps are visible but never treated as Meta acceptance.',
    value: facts => facts.websiteLegacyStampUnverified,
    population: facts => facts.websiteConfirmations,
  },
] as const

function capiCoverage(facts: ConfirmationFacts | null, population: ConfirmationMetricDefinition['population']) {
  if (facts === null) return UNKNOWN_FIELD_COVERAGE
  const size = population(facts)
  return { state: 'complete' as const, numerator: size, denominator: size }
}

function capiMetrics(
  context: ReportingContext,
  current: ConfirmationFacts | null,
  previous: ConfirmationFacts | null,
): ReportMetricMap {
  return Object.fromEntries(CAPI_METRICS.map(metric => [metric.key, makeReportMetric({
    context,
    key: metric.key,
    label: metric.label,
    definition: metric.definition,
    source: 'capi',
    unit: 'count',
    current: current === null ? null : metric.value(current),
    previous: previous === null ? null : metric.value(previous),
    entity: { level: 'business', id: context.account.id },
    coverage: capiCoverage(current, metric.population),
    previousCoverage: capiCoverage(previous, metric.population),
    reason: 'capi_confirmation_read_unavailable',
    previousReason: 'capi_confirmation_read_unavailable',
    measurementKind: 'measured',
    attributionScope: 'capi_event_delivery',
    basis: 'booking_created_date_et',
    sourceHead: context.asOf,
  })]))
}

function settled<T>(result: PromiseSettledResult<T>): T | null {
  return result.status === 'fulfilled' ? result.value : null
}

function healthFailureNote(error: unknown): string {
  const message = error instanceof Error ? error.message : ''
  return message.match(/outcome_[a-z0-9_]+/i)?.[0] ?? 'outcome_ledger_health_unavailable'
}

export async function readMeasurementReport(
  context: ReportingContext,
): Promise<ReportSection<MeasurementReport>> {
  const client = getAdminClient()
  let sourceAsOf: string
  try {
    const health = await requireOutcomeLedgerHealth(
      client,
      context.account.id,
      context.comparison.from,
      context.range.to,
      Date.parse(context.asOf),
    )
    sourceAsOf = health.lastReconciledAt ?? context.asOf
  } catch (error) {
    return { state: 'unavailable', data: null, asOf: null, notes: [healthFailureNote(error)] }
  }

  const [paidCurrentResult, paidPreviousResult, capiCurrentResult, capiPreviousResult] =
    await Promise.allSettled([
      readPaidWindow(client, context, context.range, sourceAsOf),
      readPaidWindow(client, context, context.comparison, sourceAsOf),
      getConfirmationFacts(context.account.id, context.range.from, context.range.to, client),
      getConfirmationFacts(context.account.id, context.comparison.from, context.comparison.to, client),
    ])

  const paidCurrent = settled(paidCurrentResult)
  const paidPrevious = settled(paidPreviousResult)
  const capiCurrent = settled(capiCurrentResult)
  const capiPrevious = settled(capiPreviousResult)
  // The request context is the packet's observation cutoff. A wall-clock stamp taken after
  // these reads would exceed that cutoff and make an otherwise valid packet impossible to merge.
  const capiObservedAt = context.asOf
  const paidFailed = paidCurrentResult.status === 'rejected' || paidPreviousResult.status === 'rejected'
  const capiFailed = capiCurrent === null || capiPrevious === null
  const notes = [
    ...(paidFailed ? ['paid_association_read_unavailable'] : []),
    ...(capiFailed ? ['capi_confirmation_read_unavailable'] : []),
  ]
  const hasPaidEvidence = paidCurrent !== null || paidPrevious !== null
  const hasCapiEvidence = capiCurrent !== null || capiPrevious !== null
  if (!hasPaidEvidence && !hasCapiEvidence) {
    return { state: 'unavailable', data: null, asOf: null, notes }
  }

  const paidContext = { ...context, asOf: sourceAsOf }
  const capiContext = { ...context, asOf: capiObservedAt }

  return {
    state: 'partial',
    data: {
      paidAssociation: paidMetrics(paidContext, paidCurrent, paidPrevious),
      capi: capiMetrics(capiContext, capiCurrent, capiPrevious),
      paidAssociationNotes: [
        'Paid-linked bookings are an observed lower bound because no exact-window capture and linker completeness manifest exists for arbitrary reporting dates.',
        'Observed paid-touch-to-booking lag uses median and empirical nearest-rank p90 over linked eligible bookings with retained assignment timestamps; it is not booking-to-service lead time, a click metric, attribution, or unconverted visitor maturity.',
        ...(paidFailed ? ['One or both paid-association period reads were unavailable.'] : []),
      ],
      capiNotes: [
        'CAPI eligibility uses website-origin confirmations created in the selected dates. Delivery evidence records the confirmation event, not current appointment status; unknown origins remain not evaluable.',
        `The eligibility ledger was reconciled at ${sourceAsOf}; accepted-delivery lineage was read at ${capiObservedAt}.`,
        ...(capiFailed ? ['One or both CAPI confirmation period reads were unavailable.'] : []),
      ],
      sourceDescription: SOURCE_DESCRIPTION,
    },
    asOf: capiObservedAt,
    notes,
  }
}
