import type { SupabaseClient } from '@supabase/supabase-js'
import { aggregateBusinessFacts, type LedgerAppointmentLite, type LedgerRowLike } from '@/lib/outcomes/business-facts'
import { requireOutcomeLedgerHealth } from '@/lib/outcomes/source-health'
import { requireOutcomeCurrency } from '@/lib/outcomes/aggregation'
import { readLatestPaidCohortPair, type PaidCohortPairEvidence } from '@/lib/attribution/paid-cohort-reader'
import { PAID_COHORT_POLICY } from '@/lib/attribution/paid-cohort-policy'
import { listOutcomeAdapters } from '@/lib/outcomes/registry'
import { accountDateRangeToHalfOpenInstants } from '@/lib/economics/account-date-window'
import { gaJoinableLedger, reconcileGa4Bookings } from '@/lib/ga4/booking-reconciliation'
import { getGa4IdentifiedBookingEvents, type Ga4IdentifiedBookingEvents } from '@/lib/ga4/client'
import type {
  ExecutiveOutcomeEvidenceV1,
  ExecutiveOutcomeWeeklyFactsV1,
  ExecutiveOutcomeWindowFactsV1,
  ExecutiveCapiFactsV1,
  ExecutiveEvidenceSourceReadV1,
  ExecutiveEvidenceWindowKeyV1,
  ExecutiveEvidenceWindowRequestV1,
  ExecutiveGaIdentityFactsV1,
  ExecutivePaidCohortFactsV1,
  ExecutiveTrackingFactsV1,
  ExecutiveWindowFactsV1,
} from './executive-evidence.types'
import { accountTimezone } from '@/config/business-config'
import { outcomeWords } from '@/config/outcome-nouns'

// What this business calls its outcomes (NEXT_PUBLIC_OUTCOME_NOUN).
const OW = outcomeWords()

const PAGE_SIZE = 1_000
const MAX_PAGES = 100
const WINDOW_KEYS: ExecutiveEvidenceWindowKeyV1[] = ['lastDay', 'trailing7', 'prior7', 'monthToDate', 'postChange']

interface DatedLedgerRow extends Omit<LedgerAppointmentLite, 'id'> {
  /** The outcome uuid. */
  id: string
  /** The source's own id and kind: interpreted only for sources whose analytics event carries it. */
  externalId: string
  sourceKind: string
  booking_date_et: string
  datetime_created?: string | null
  capi_send_error?: string | null
  origin_observed_at?: string | null
}

/** A `v_business_outcomes` row as read here; mapped to the appointment-flavoured pure row at the boundary. */
interface OutcomeLedgerRow {
  id: string
  external_id: string
  source_kind: string
  currency: string
  booking_date_et: string
  datetime_created?: string | null
  price: number | null
  amount_paid?: number | null
  status: string
  business_state?: string | null
  web_origin_state?: LedgerAppointmentLite['web_origin_state']
  capi_send_error?: string | null
  origin_observed_at?: string | null
}

function toDatedLedgerRow({ currency, external_id, source_kind, status, business_state, ...row }: OutcomeLedgerRow): DatedLedgerRow {
  void currency // checked for the whole page by requireOutcomeCurrency; not part of the ledger row
  return {
    ...row,
    externalId: external_id,
    sourceKind: source_kind,
    canceled: status === 'cancelled' || status === 'refunded',
    business_state: (business_state === 'cancelled' ? 'canceled' : business_state) as LedgerAppointmentLite['business_state'],
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function nonnegative(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number : null
}

function shiftDate(date: string, days: number): string {
  return new Date(new Date(`${date}T00:00:00.000Z`).getTime() + days * 86_400_000).toISOString().slice(0, 10)
}

function weeklyWindows(lastCompleteDate: string): Array<{ start: string; end: string }> {
  return Array.from({ length: 8 }, (_, index) => {
    const end = shiftDate(lastCompleteDate, -index * 7)
    return { start: shiftDate(end, -6), end }
  }).reverse()
}

function latest(values: unknown[]): string | null {
  return (
    values
      .filter((value): value is string => typeof value === 'string' && Boolean(value))
      .sort()
      .at(-1) ?? null
  )
}

export function mapExecutiveOutcomeWindowFactsV1(rows: readonly LedgerRowLike[]): ExecutiveOutcomeWindowFactsV1 {
  const facts = aggregateBusinessFacts(rows)
  const canceledAmountPaidObserved = rows
    .filter((row) => (row.business_state ?? (row.canceled ? 'canceled' : null)) === 'canceled')
    .reduce((total, row) => total + (row.amount_paid ?? 0), 0)
  return {
    activeAppointments: facts.confirmedAppointments,
    valueBearingBookings: facts.valueBearingBookings,
    zeroValueAppointments: facts.zeroValueAppointments,
    bookedValue: facts.bookedValue,
    activeAmountPaidObserved: facts.observedCollectedValue,
    activeAmountPaidRevenue: facts.recordedOutcomeValue,
    amountPaidCoverage: { ...facts.amountPaidCoverage },
    canceledAppointments: facts.canceledAppointments,
    canceledAmountPaidObserved,
  }
}

async function readLedgerRows(
  db: SupabaseClient,
  request: ExecutiveEvidenceWindowRequestV1,
  minimumStart?: string,
): Promise<{ rows: DatedLedgerRow[]; head: string }> {
  const starts = WINDOW_KEYS.map((key) => request.windows[key].startDate).filter(
    (value): value is string => value !== null,
  )
  const start = minimumStart ?? [...starts, weeklyWindows(request.lastCompleteDate)[0].start].sort()[0]
  const health = await requireOutcomeLedgerHealth(
    db,
    request.accountId,
    start,
    request.lastCompleteDate,
    Date.parse(request.asOf),
  )
  const rows: DatedLedgerRow[] = []
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const from = page * PAGE_SIZE
    const result = await db
      .from('v_business_outcomes')
      .select(
        'id,external_id,source_kind,currency,booking_date_et:business_date,datetime_created:occurred_at,price:gross_value,amount_paid:collected_value,status,business_state,web_origin_state,capi_send_error:conversion_send_error,origin_observed_at',
      )
      .eq('ad_account_id', request.accountId)
      .eq('source_enabled', true)
      .gte('business_date', start)
      .lte('business_date', request.lastCompleteDate)
      .order('id', { ascending: true })
      .range(from, from + PAGE_SIZE - 1)
    if (result.error) throw new Error(`executive outcome ledger read failed: ${result.error.message}`)
    if (!Array.isArray(result.data)) throw new Error('executive outcome ledger returned a non-array result')
    requireOutcomeCurrency(result.data as OutcomeLedgerRow[])
    rows.push(...(result.data as OutcomeLedgerRow[]).map(toDatedLedgerRow))
    if (result.data.length < PAGE_SIZE) {
      // A reconciled source supplies the evidence head; push-only sources count as received at asOf.
      const reconciled = health.sources.some((source) => source.completeness === 'reconciled')
      if (reconciled && !health.lastReconciledAt) throw new Error('Outcome ledger health head is unavailable')
      rows.sort((a, b) => a.booking_date_et.localeCompare(b.booking_date_et)
        || (a.datetime_created ?? '').localeCompare(b.datetime_created ?? '') || a.id.localeCompare(b.id))
      return { rows, head: health.lastReconciledAt ?? request.asOf }
    }
  }
  throw new Error(`executive outcome ledger exceeded ${PAGE_SIZE * MAX_PAGES} rows`)
}

function rowsIn(rows: DatedLedgerRow[], start: string, end: string): DatedLedgerRow[] {
  return rows.filter((row) => row.booking_date_et >= start && row.booking_date_et <= end)
}

export async function readExecutiveOutcomeEvidenceV1(
  db: SupabaseClient,
  request: ExecutiveEvidenceWindowRequestV1,
): Promise<ExecutiveEvidenceSourceReadV1<ExecutiveOutcomeEvidenceV1>> {
  const { rows, head } = await readLedgerRows(db, request)
  const blockers: string[] = []
  const byWindow = {} as ExecutiveWindowFactsV1<ExecutiveOutcomeWindowFactsV1>
  for (const key of WINDOW_KEYS) {
    const window = request.windows[key]
    if (window.availability !== 'available' || !window.startDate) {
      byWindow[key] = null
      continue
    }
    const fact = mapExecutiveOutcomeWindowFactsV1(rowsIn(rows, window.startDate, window.endDate))
    byWindow[key] = fact
    if (fact.activeAmountPaidRevenue === null) blockers.push(`outcome_amount_paid_coverage_incomplete:${key}`)
  }
  const weeklyTrend8: ExecutiveOutcomeWeeklyFactsV1[] = weeklyWindows(request.lastCompleteDate).map((window, index) => {
    const fact = mapExecutiveOutcomeWindowFactsV1(rowsIn(rows, window.start, window.end))
    if (fact.activeAmountPaidRevenue === null) {
      blockers.push(`outcome_amount_paid_coverage_incomplete:weeklyTrend8:${index}`)
    }
    return { ...fact, windowStart: window.start, windowEnd: window.end }
  })
  return {
    availability: blockers.length ? 'partial' : 'available',
    head,
    blockerCodes: unique(blockers),
    data: { byWindow, weeklyTrend8 },
  }
}

async function readTrackingRows(
  db: SupabaseClient,
  table: 'paid_touch_observations' | 'outcome_touch_links',
  columns: string,
  accountId: string,
  timeColumn: 'observed_at' | 'outcome_created_at',
  start: string,
  end: string,
): Promise<Record<string, unknown>[]> {
  const rows: Record<string, unknown>[] = []
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const from = page * PAGE_SIZE
    const result = await db
      .from(table)
      .select(columns)
      .eq('ad_account_id', accountId)
      .gte(timeColumn, start)
      .lt(timeColumn, end)
      .order('id', { ascending: true })
      .range(from, from + PAGE_SIZE - 1)
    if (result.error) throw new Error(`${table} read failed: ${result.error.message}`)
    const data: unknown = result.data
    if (!Array.isArray(data) || !data.every(isRecord)) {
      throw new Error(`${table} returned an invalid result`)
    }
    rows.push(...data)
    if (data.length < PAGE_SIZE) return rows
  }
  throw new Error(`${table} exceeded ${PAGE_SIZE * MAX_PAGES} rows`)
}

export async function readExecutiveTrackingEvidenceV1(
  db: SupabaseClient,
  request: ExecutiveEvidenceWindowRequestV1,
  landingPageViews: number | null,
): Promise<ExecutiveEvidenceSourceReadV1<ExecutiveTrackingFactsV1>> {
  if (request.timezone !== accountTimezone()) throw new Error('paid-touch date helper does not support this timezone')
  const window = request.windows.trailing7
  if (!window.startDate) throw new Error('trailing-seven window is unavailable')
  const instants = accountDateRangeToHalfOpenInstants({
    start: window.startDate,
    end: window.endDate,
  })
  const [touches, links] = await Promise.all([
    readTrackingRows(
      db,
      'paid_touch_observations',
      'id,identity_complete,observed_at,created_at',
      request.accountId,
      'observed_at',
      instants.start,
      instants.end,
    ),
    readTrackingRows(
      db,
      'outcome_touch_links',
      'id,outcome_id,outcome_created_at,linked_at',
      request.accountId,
      'outcome_created_at',
      instants.start,
      instants.end,
    ),
  ])
  const blockers = landingPageViews === null ? ['tracking_landing_page_views_unavailable'] : []
  if (landingPageViews !== null && landingPageViews !== touches.length) {
    blockers.push('tracking_capture_coverage_mismatch')
  }
  return {
    availability: blockers.length ? 'partial' : 'available',
    head: latest([
      ...touches.flatMap((row) => [row.observed_at, row.created_at]),
      ...links.flatMap((row) => [row.outcome_created_at, row.linked_at]),
    ]),
    blockerCodes: blockers,
    data: {
      landingPageViews,
      paidTouchObservations: touches.length,
      identityCompleteTouches: touches.filter((row) => row.identity_complete === true).length,
      identityIncompleteTouches: touches.filter((row) => row.identity_complete !== true).length,
      linkedAppointments: links.length,
    },
  }
}

export async function readExecutiveCapiEvidenceV1(
  db: SupabaseClient,
  request: ExecutiveEvidenceWindowRequestV1,
  env: Record<string, string | undefined> = process.env,
): Promise<ExecutiveEvidenceSourceReadV1<ExecutiveCapiFactsV1>> {
  const window = request.windows.trailing7
  if (!window.startDate) throw new Error('trailing-seven window is unavailable')
  const health = await requireOutcomeLedgerHealth(
    db,
    request.accountId,
    window.startDate,
    window.endDate,
    Date.parse(request.asOf),
  )
  const result = await db
    .from('v_business_outcomes')
    .select('id,occurred_at,conversion_send_error,origin_observed_at')
    .eq('ad_account_id', request.accountId)
    .eq('source_enabled', true)
    .eq('web_origin_state', 'website')
    .gte('business_date', window.startDate)
    .lte('business_date', window.endDate)
    .order('id', { ascending: true })
    .limit(10_001)
  if (result.error) throw new Error(`CAPI-eligible ${OW.many} read failed: ${result.error.message}`)
  if (!Array.isArray(result.data) || result.data.length > 10_000)
    throw new Error(`CAPI ${OW.one} read unavailable or truncated`)
  const appointments = result.data as Record<string, unknown>[]
  const ids = appointments.map((row) => row.id).filter((id): id is string => typeof id === 'string' && id !== '')
  let deliveries: Record<string, unknown>[] = []
  for (let offset = 0; offset < ids.length; offset += 500) {
    const delivery = await db
      .from('conversion_deliveries')
      .select('outcome_id,send_mode,last_attempt_send_mode,last_attempt_at,live_accepted_at,failed_attempt_count')
      .in('outcome_id', ids.slice(offset, offset + 500))
    if (delivery.error) throw new Error(`CAPI delivery read failed: ${delivery.error.message}`)
    if (!Array.isArray(delivery.data)) throw new Error('CAPI delivery read returned a non-array result')
    deliveries = [...deliveries, ...(delivery.data as Record<string, unknown>[])]
  }
  const liveAttempt = (row: Record<string, unknown>) =>
    row.live_accepted_at != null || row.last_attempt_send_mode === 'live' || row.send_mode === 'live'
  // The conversion sender mode of the source that sends its own conversions (the reference adapter);
  // with none, conversions here are off.
  const mode = listOutcomeAdapters().flatMap((adapter) => adapter.conversionSendMode ? [adapter.conversionSendMode(env)] : [])[0] ?? 'off'
  return {
    availability: 'available',
    head: latest([
      health.lastReconciledAt,
      ...appointments.flatMap((row) => [row.occurred_at, row.origin_observed_at]),
      ...deliveries.map((row) => row.last_attempt_at),
    ]),
    blockerCodes: [],
    data: {
      mode: mode === 'test' ? 'shadow' : mode,
      eligibleAppointments: appointments.length,
      sentAppointments: deliveries.filter(liveAttempt).length,
      acceptedAppointments: deliveries.filter((row) => row.live_accepted_at != null).length,
      failedAppointments: deliveries.filter(
        (row) => liveAttempt(row) && row.live_accepted_at == null && (nonnegative(row.failed_attempt_count) ?? 0) > 0,
      ).length,
      expiredAppointments: appointments.filter((row) =>
        ['expired', 'missed-48h-window'].includes(String(row.conversion_send_error)),
      ).length,
    },
  }
}

export async function readExecutiveGaIdentityEvidenceV1(
  db: SupabaseClient,
  request: ExecutiveEvidenceWindowRequestV1,
  gaReader: (start: string, end: string) => Promise<Ga4IdentifiedBookingEvents> = getGa4IdentifiedBookingEvents,
): Promise<ExecutiveEvidenceSourceReadV1<ExecutiveGaIdentityFactsV1>> {
  const window = request.windows.trailing7
  if (!window.startDate) throw new Error('trailing-seven window is unavailable')
  const { rows } = await readLedgerRows(db, request, window.startDate)
  // Only sources whose analytics event carries their numeric external id join GA (aggregation rule 4).
  const ledger = gaJoinableLedger(rowsIn(rows, window.startDate, window.endDate))
  const [ga, boundary] = await Promise.all([
    gaReader(window.startDate, window.endDate),
    db
      .from('ga4_identity_boundary')
      .select('first_identified_date,provenance,last_confirmed_at')
      .eq('ad_account_id', request.accountId)
      .maybeSingle(),
  ])
  if (boundary.error) throw new Error(`GA identity boundary read failed: ${boundary.error.message}`)
  if (!ga.available) {
    return {
      availability: 'unavailable',
      head: null,
      blockerCodes: ['ga_identity_pending_configuration'],
      data: null,
    }
  }
  const provenBoundary = boundary.data?.provenance === 'observed' ? String(boundary.data.first_identified_date) : null
  const reconciliation = reconcileGa4Bookings(ledger, ga, {
    windowStart: window.startDate,
    provenBoundary,
  })
  const total = ga.events.reduce((sum, event) => sum + event.eventCount, 0)
  const identified = ga.events
    .filter((event) => event.appointmentId !== null)
    .reduce((sum, event) => sum + event.eventCount, 0)
  const blockers =
    reconciliation.scope === 'exact_appointment_join' ? [] : [`ga_identity_scope:${reconciliation.scope}`]
  return {
    availability: blockers.length ? 'partial' : 'available',
    head: String(boundary.data?.last_confirmed_at ?? request.asOf),
    blockerCodes: blockers,
    data: {
      confirmationEvents: total,
      identifiedEvents: identified,
      legacyUnlinkedEvents: reconciliation.legacyUnlinkedEvents,
      duplicateAppointments: reconciliation.duplicateAppointments.length,
      unmatchedAppointmentIds: reconciliation.unmatchedGaEvents.length,
      websiteBookingsMissingGa: reconciliation.unjoinedWebsiteBookings.length,
      unknownOriginAppointments: reconciliation.unknownOriginBookings.length,
      scope: reconciliation.scope,
    },
  }
}

export function mapExecutivePaidCohortEvidenceV1(pair: PaidCohortPairEvidence): ExecutivePaidCohortFactsV1 {
  const direction = (item: PaidCohortPairEvidence['recentScale']) => ({
    windowStart: item.windowStart,
    windowEnd: item.windowEnd,
    complete: item.complete && item.generationComplete,
    blockerCodes: unique([...item.blockerCodes, ...item.generationBlockerCodes]),
  })
  const recentScale = direction(pair.recentScale)
  const maturedCut = direction(pair.maturedCut)
  const spend = nonnegative(pair.recentScale.spend)
  const bookings = nonnegative(pair.recentScale.bookings)
  const revenue = nonnegative(pair.recentScale.metrics.outcome_recorded_revenue)
  const blockers = unique([
    ...recentScale.blockerCodes,
    ...maturedCut.blockerCodes,
    ...(spend === null ? ['paid_cohort_spend_unavailable'] : []),
    ...(bookings === null ? ['paid_cohort_bookings_unavailable'] : []),
    ...(revenue === null ? ['paid_cohort_revenue_unavailable'] : []),
  ])
  const complete = recentScale.complete && maturedCut.complete && blockers.length === 0
  return {
    policyVersion: PAID_COHORT_POLICY.policyVersion,
    complete,
    blockerCodes: blockers,
    recentScale,
    maturedCut,
    associatedSpend: spend,
    associatedValueBearingBookings: bookings,
    associatedAmountPaidRevenue: revenue,
  }
}

export async function readExecutivePaidCohortEvidenceV1(
  db: SupabaseClient,
  request: ExecutiveEvidenceWindowRequestV1,
): Promise<ExecutiveEvidenceSourceReadV1<ExecutivePaidCohortFactsV1>> {
  const account = await db
    .from('ad_accounts')
    .select('account_id')
    .eq('id', request.accountId)
    .eq('is_active', true)
    .maybeSingle()
  if (account.error) throw new Error(`paid cohort account read failed: ${account.error.message}`)
  const metaAccountId = typeof account.data?.account_id === 'string' ? account.data.account_id.trim() : ''
  if (!metaAccountId) throw new Error('paid cohort Meta account identity is unavailable')
  const pair = await readLatestPaidCohortPair(db, request.accountId, {
    entityLevel: 'account',
    entityId: metaAccountId,
  })
  if (!pair) {
    return {
      availability: 'unavailable',
      head: null,
      blockerCodes: ['paid_cohort_generation_unavailable'],
      data: null,
    }
  }
  const data = mapExecutivePaidCohortEvidenceV1(pair)
  return {
    availability: data.complete ? 'available' : 'partial',
    head: pair.recentScale.asOfDate,
    blockerCodes: [...data.blockerCodes],
    data,
  }
}
