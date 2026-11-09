import { PAID_COHORT_POLICY } from './paid-cohort-policy'
import { roundMoney } from '@/lib/utils/format-currency'

export type PaidCohortKind = 'recent_scale' | 'matured_cut'
export type PaidCohortEntityLevel = 'account' | 'campaign' | 'adset' | 'ad'

export type PaidCohortBlockerCode =
  | 'activation_missing'
  | 'pre_activation_window'
  | 'maturity_lag_not_met'
  | 'invalid_timezone'
  | 'invalid_source_boundary'
  | 'stale_insight_source'
  | 'appointment_source_unavailable'
  | 'stale_appointment_state'
  | 'missing_account_insight_days'
  | 'duplicate_account_insights'
  | 'duplicate_ad_insights'
  | 'invalid_insight_metrics'
  | 'spend_reconciliation_failed'
  | 'incomplete_insight_identity'
  | 'landing_page_views_unavailable'
  | 'capture_coverage_mismatch'
  | 'paid_completeness_manifest_unavailable'
  | 'paid_completeness_manifest_mismatch'
  | 'paid_capture_source_incomplete'
  | 'paid_linker_source_incomplete'
  | 'incomplete_touch_identity'
  | 'invalid_touch_time'
  | 'duplicate_touch_id'
  | 'orphan_link_touch'
  | 'link_touch_mismatch'
  | 'appointment_state_missing'
  | 'invalid_appointment_value'
  | 'invalid_appointment_revenue'
  | 'source_cannot_carry_token'

export interface PaidCohortInsightInput {
  dateStart: string
  entityLevel: 'account' | 'campaign' | 'adset' | 'ad'
  metaCampaignId?: string | null
  metaAdsetId?: string | null
  metaAdId?: string | null
  spend: number | string | null
  landingPageViews: number | string | null
  syncedAt?: string | null
}

export interface PaidTouchCohortInput {
  id: string
  observedAt: string
  identityComplete: boolean
  metaCampaignId: string | null
  metaAdsetId: string | null
  metaAdId: string | null
  /** Identifies the CLICK. Two observations sharing an fbclid are one click seen twice. */
  fbclid: string | null
}

export interface PaidTouchLinkCohortInput {
  appointmentId: number
  lastTouchId: string
  lastInteractionAt: string
  linkedAt?: string | null
}

export interface PaidAppointmentCohortInput {
  id: number
  price: number | string | null
  amountPaid?: number | string | null
  canceled: boolean
  syncedAt: string | null
}

export interface PaidCohortCompletenessManifestInput {
  id: string
  evaluationRunId: string
  cohortKind: PaidCohortKind
  windowStart: string
  windowEnd: string
  sourceNotBefore: string
  captureCompletedAt: string
  linkerCompletedAt: string
  captureComplete: boolean
  linkerComplete: boolean
  captureEligibleInputs: number
  capturedTouches: number
  eligibleAppointments: number
  evaluatedAppointments: number
  linkedAppointments: number
  blockerCodes: string[]
}

export interface PaidCohortBuildInput {
  generationId: string
  evaluationRunId: string
  cohortKind: PaidCohortKind
  accountMetaId: string
  timezone: string
  window: { start: string; end: string }
  asOfDate: string
  sourceNotBefore: string
  appointmentSourceComplete: boolean
  appointmentSourceHead: string | null
  appointmentSourceWindowBasis?: 'booking_date_et' | null
  appointmentSourceWindowStart?: string | null
  appointmentSourceWindowEnd?: string | null
  maturityLagDays: number
  /** Kinds of the account's ENABLED outcome sources that cannot carry an attribution token (csv). Their
   *  outcomes can never be linked to a touch, so any one makes the cohort incomplete. */
  tokenlessSourceKinds: readonly string[]
  completenessManifest: PaidCohortCompletenessManifestInput | null
  activation: { id: string; activatedAt: string } | null
  insights: PaidCohortInsightInput[]
  touches: PaidTouchCohortInput[]
  links: PaidTouchLinkCohortInput[]
  appointments: PaidAppointmentCohortInput[]
}

export interface PaidCohortUnitPayload {
  entity_level: PaidCohortEntityLevel
  entity_id: string
  spend: number | null
  landing_page_views: number | null
  captured_touches: number
  bookings: number
  booked_value: number
  complete: boolean
  blocker_codes: PaidCohortBlockerCode[]
  metrics: Record<string, number | null>
}

export interface PaidCohortGenerationPayload {
  id: string
  cohort_kind: PaidCohortKind
  window_start: string
  window_end: string
  activation_id: string | null
  account_spend: number | null
  entity_spend: number | null
  landing_page_views: number | null
  captured_landing_views: number
  complete: boolean
  blocker_codes: PaidCohortBlockerCode[]
  source_heads: Record<string, string | null>
  metrics: Record<string, number | null>
  units: PaidCohortUnitPayload[]
}

interface AdAggregate {
  campaignId: string
  adsetId: string
  adId: string
  spend: number
  landingPageViews: number
  landingPageViewsKnown: boolean
  capturedTouches: number
  /** Distinct fbclids behind capturedTouches. capturedTouches - this = duplicate observations. */
  capturedClicks: Set<string>
  bookings: number
  bookedValue: number
  recordedRevenue: number
  zeroValueBookings: number
  canceledLinks: number
  blockers: Set<PaidCohortBlockerCode>
}

const SPEND_RECONCILIATION_TOLERANCE = 0.02
const COVERAGE_MISMATCH_TOLERANCE = 0.20
const COVERAGE_MISMATCH_ABSOLUTE_TOLERANCE = 25
const COVERAGE_MISMATCH_ZERO_SIDE_CAP = 25
const DAY_MS = 86_400_000

function sorted<T extends string>(values: Iterable<T>): T[] {
  return [...new Set(values)].sort()
}

function utcDateMs(date: string): number {
  const value = new Date(`${date}T00:00:00.000Z`).getTime()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(value)) {
    throw new Error(`Invalid cohort date: ${date}`)
  }
  return value
}

function inclusiveDates(start: string, end: string): string[] {
  const first = utcDateMs(start)
  const last = utcDateMs(end)
  if (first > last) throw new Error('Paid cohort window start follows its end.')
  const dates: string[] = []
  for (let time = first; time <= last; time += DAY_MS) {
    dates.push(new Date(time).toISOString().slice(0, 10))
  }
  return dates
}

function localDate(iso: string, timezone: string): string | null {
  const time = new Date(iso).getTime()
  if (!Number.isFinite(time)) return null
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(new Date(time))
    const value = Object.fromEntries(parts.map((part) => [part.type, part.value]))
    return `${value.year}-${value.month}-${value.day}`
  } catch {
    return null
  }
}

function metric(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
}

function freshAtOrAfter(value: string | null | undefined, boundaryMs: number): boolean {
  if (!Number.isFinite(boundaryMs) || !value) return false
  const observedMs = new Date(value).getTime()
  return Number.isFinite(observedMs) && observedMs >= boundaryMs
}

function sameInstant(left: string, right: string): boolean {
  const leftMs = new Date(left).getTime()
  const rightMs = new Date(right).getTime()
  return Number.isFinite(leftMs) && Number.isFinite(rightMs) && leftMs === rightMs
}

function nonnegativeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0
}

function identity(
  campaignId: string | null | undefined,
  adsetId: string | null | undefined,
  adId: string | null | undefined,
): { campaignId: string; adsetId: string; adId: string } | null {
  const ids = [campaignId, adsetId, adId]
  if (ids.some((id) => typeof id !== 'string' || !/^\d{1,32}$/.test(id))) return null
  return { campaignId: campaignId!, adsetId: adsetId!, adId: adId! }
}

function adKey(ids: { campaignId: string; adsetId: string; adId: string }): string {
  return `${ids.campaignId}|${ids.adsetId}|${ids.adId}`
}

function dayAdKey(date: string, ids: { campaignId: string; adsetId: string; adId: string }): string {
  return `${date}|${adKey(ids)}`
}

function getAd(
  ads: Map<string, AdAggregate>,
  ids: { campaignId: string; adsetId: string; adId: string },
): AdAggregate {
  const key = adKey(ids)
  const existing = ads.get(key)
  if (existing) return existing
  const created: AdAggregate = {
    ...ids,
    spend: 0,
    landingPageViews: 0,
    landingPageViewsKnown: true,
    capturedTouches: 0,
    capturedClicks: new Set<string>(),
    bookings: 0,
    bookedValue: 0,
    recordedRevenue: 0,
    zeroValueBookings: 0,
    canceledLinks: 0,
    blockers: new Set(),
  }
  ads.set(key, created)
  return created
}

function coverageMatches(touches: number, landing: number): boolean {
  // ONE-SIDED. Only UNDER-capture can manufacture a false zero, which is the entire purpose of
  // this blocker: if we captured fewer touches than Meta reported landing views, clicks are
  // missing from the numerator and an exact zero would be a lie. OVER-capture is the expected
  // steady state and carries no such risk — our first-party server capture legitimately observes
  // clicks Meta's pixel-based Landing Page Views cannot (ITP, ad blockers, consent refusals), and
  // Meta restates LPV for several days after a click, so recently launched ads read high until it
  // settles. On a clean 100%-identity window, mature ads can reconcile near 100% while ads launched
  // a few days earlier sit at two to three times that purely on backfill lag.
  // Treating those symmetrically blocked the entire cohort on healthy data.
  if (touches >= landing) return true

  // Below here we are strictly under-captured, so landing > 0.
  if (touches === 0) {
    // Meta Pixel injected via GTM often undercounts on low-volume ads; tolerate a small absolute
    // number of landing views with no server capture at all rather than blocking the whole cohort.
    return landing <= COVERAGE_MISMATCH_ZERO_SIDE_CAP
  }
  const diff = landing - touches
  return diff <= COVERAGE_MISMATCH_ABSOLUTE_TOLERANCE || diff / landing <= COVERAGE_MISMATCH_TOLERANCE
}

function ratioMetrics(
  spend: number | null,
  bookings: number,
  bookedValue: number,
  recordedRevenue: number,
) {
  return {
    cpa: spend !== null && bookings > 0 ? spend / bookings : null,
    roas: spend !== null && spend > 0 ? bookedValue / spend : null,
    revenue_roas: spend !== null && spend > 0 ? recordedRevenue / spend : null,
  }
}

function aggregateUnit(
  level: PaidCohortEntityLevel,
  id: string,
  members: AdAggregate[],
  globalBlockers: Set<PaidCohortBlockerCode>,
  spendOverride?: number | null,
): PaidCohortUnitPayload {
  const local = new Set<PaidCohortBlockerCode>(globalBlockers)
  for (const member of members) for (const blocker of member.blockers) local.add(blocker)
  const spend = spendOverride === undefined
    ? members.reduce((sum, row) => sum + row.spend, 0)
    : spendOverride
  const landingKnown = members.every((row) => row.landingPageViewsKnown)
  const landing = landingKnown
    ? members.reduce((sum, row) => sum + row.landingPageViews, 0)
    : null
  const captured = members.reduce((sum, row) => sum + row.capturedTouches, 0)
  const bookings = members.reduce((sum, row) => sum + row.bookings, 0)
  const bookedValue = members.reduce((sum, row) => sum + row.bookedValue, 0)
  const recordedRevenue = members.reduce((sum, row) => sum + row.recordedRevenue, 0)
  const zeroValue = members.reduce((sum, row) => sum + row.zeroValueBookings, 0)
  const canceled = members.reduce((sum, row) => sum + row.canceledLinks, 0)
  return {
    entity_level: level,
    entity_id: id,
    spend: spend === null ? null : money(spend),
    landing_page_views: landing,
    captured_touches: captured,
    bookings,
    booked_value: money(bookedValue),
    complete: local.size === 0,
    blocker_codes: sorted(local),
    metrics: {
      ...ratioMetrics(spend === null ? null : money(spend), bookings, money(bookedValue), money(recordedRevenue)),
      outcome_recorded_revenue: money(recordedRevenue),
      zero_value_bookings: zeroValue,
      canceled_links: canceled,
    },
  }
}

/**
 * Normalise an accumulated money figure to whole minor units of the account currency (cents for USD).
 *
 * Spend is summed across days and ads in binary floating point, so a sum of exact 2dp inputs lands a
 * few femto-cents off — for example `512.4000000000001` for a recent_scale cohort.
 *
 * WHAT THIS IS NOT. An earlier version of this comment claimed the drift broke recommendation
 * generation. It did not, and the claim was wrong in a way worth recording. These columns are
 * unconstrained `numeric`, and PostgREST delivers them to the reader as JS NUMBERS, which take the
 * number branch of `nonnegativeNumber` — and that branch tolerates FLOAT_CENT_EPSILON (1e-9) while the
 * drift is ~1e-13. The strict string branch the old comment credited is never exercised by these
 * columns in production. Proof: stored generations and units that still hold drifted values are
 * rejected ZERO times on money by `scripts/audit-paid-cohort-rows.ts`. The publication outage was
 * `metrics.revenue_roas` alone — a JSONB ratio whose fourth decimal misses the nearest cent and so
 * fails even the tolerant number branch.
 *
 * WHAT IT IS. Storing accumulated money as whole cents, because that is what money is. It removes a
 * representation that only survives on a 1e-9 tolerance, and would be rejected outright if these
 * columns were ever tightened to `numeric(14,2)` or if a value arrived as a string. Rounding is exact
 * recovery, not approximation: every input is already whole cents (stored `daily_insights.spend` and
 * `appointment_value` rows are 2dp values, so none differs from its own 2dp rounding).
 *
 * Applied where a value enters a stored payload, not at each `+=`, so the arithmetic is untouched.
 */
function money(value: number): number {
  // the account currency's minor unit (whole yen for JPY, fils for KWD), not always cents.
  return roundMoney(value)
}

export function buildPaidCohortGeneration(input: PaidCohortBuildInput): PaidCohortGenerationPayload {
  const dates = inclusiveDates(input.window.start, input.window.end)
  const dateSet = new Set(dates)
  const globalBlockers = new Set<PaidCohortBlockerCode>()
  const manifestBlockers = new Set<PaidCohortBlockerCode>()
  const ads = new Map<string, AdAggregate>()
  const sourceBoundaryMs = new Date(input.sourceNotBefore).getTime()
  const appointmentWindowCovered = input.appointmentSourceWindowBasis === 'booking_date_et'
    && typeof input.appointmentSourceWindowStart === 'string'
    && typeof input.appointmentSourceWindowEnd === 'string'
    && input.appointmentSourceWindowStart <= input.window.start
    && input.appointmentSourceWindowEnd >= input.window.end

  const timezoneProbe = localDate(`${input.window.start}T12:00:00.000Z`, input.timezone)
  if (!timezoneProbe) globalBlockers.add('invalid_timezone')
  if (!Number.isFinite(sourceBoundaryMs)) globalBlockers.add('invalid_source_boundary')
  if (
    !input.appointmentSourceComplete
    || !appointmentWindowCovered
    || !freshAtOrAfter(input.appointmentSourceHead, sourceBoundaryMs)
  ) globalBlockers.add('appointment_source_unavailable')
  if (input.tokenlessSourceKinds.length > 0) globalBlockers.add('source_cannot_carry_token')
  if (!input.activation) {
    globalBlockers.add('activation_missing')
  } else {
    const activationDate = localDate(input.activation.activatedAt, input.timezone)
    if (!activationDate) globalBlockers.add('invalid_timezone')
    else if (input.window.start <= activationDate) globalBlockers.add('pre_activation_window')
  }
  if (
    input.cohortKind === 'matured_cut'
    && (utcDateMs(input.asOfDate) - utcDateMs(input.window.end)) / DAY_MS < input.maturityLagDays
  ) globalBlockers.add('maturity_lag_not_met')

  const accountRowsByDate = new Map<string, PaidCohortInsightInput[]>()
  const adRowsByGroup = new Map<string, PaidCohortInsightInput[]>()
  const adSpendByDate = new Map<string, number>()
  let insightMetricsValid = true
  let entitySpend = 0
  let latestInsight: string | null = null

  for (const row of input.insights) {
    if (!dateSet.has(row.dateStart)) continue
    if (row.syncedAt && (!latestInsight || row.syncedAt > latestInsight)) latestInsight = row.syncedAt
    if (row.entityLevel === 'account') {
      if (!freshAtOrAfter(row.syncedAt, sourceBoundaryMs)) {
        globalBlockers.add('stale_insight_source')
      }
      const rows = accountRowsByDate.get(row.dateStart) ?? []
      rows.push(row)
      accountRowsByDate.set(row.dateStart, rows)
      continue
    }
    if (row.entityLevel !== 'ad') continue
    const spend = metric(row.spend)
    const landing = metric(row.landingPageViews)
    if (spend === null) {
      insightMetricsValid = false
      continue
    }
    const relevant = spend > 0 || (landing ?? 0) > 0
    const ids = identity(row.metaCampaignId, row.metaAdsetId, row.metaAdId)
    if (!ids) {
      if (relevant) globalBlockers.add('incomplete_insight_identity')
      continue
    }
    const groupKey = dayAdKey(row.dateStart, ids)
    const groupRows = adRowsByGroup.get(groupKey) ?? []
    groupRows.push(row)
    adRowsByGroup.set(groupKey, groupRows)
    const aggregate = getAd(ads, ids)
    if (!freshAtOrAfter(row.syncedAt, sourceBoundaryMs)) {
      aggregate.blockers.add('stale_insight_source')
    }
    aggregate.spend += spend
    entitySpend += spend
    adSpendByDate.set(row.dateStart, (adSpendByDate.get(row.dateStart) ?? 0) + spend)
    if (row.landingPageViews === null || row.landingPageViews === undefined || landing === null) {
      aggregate.landingPageViewsKnown = false
      if (relevant) aggregate.blockers.add('landing_page_views_unavailable')
    } else {
      aggregate.landingPageViews += landing
    }
  }
  if (!insightMetricsValid) globalBlockers.add('invalid_insight_metrics')
  if ([...adRowsByGroup.values()].some((rows) => rows.length !== 1)) {
    globalBlockers.add('duplicate_ad_insights')
  }

  let accountSpend = 0
  let accountSpendKnown = true
  for (const date of dates) {
    const rows = accountRowsByDate.get(date) ?? []
    if (rows.length === 0) {
      globalBlockers.add('missing_account_insight_days')
      accountSpendKnown = false
      continue
    }
    if (rows.length !== 1) {
      globalBlockers.add('duplicate_account_insights')
      accountSpendKnown = false
      continue
    }
    const spend = metric(rows[0].spend)
    if (spend === null) {
      globalBlockers.add('invalid_insight_metrics')
      accountSpendKnown = false
      continue
    }
    accountSpend += spend
    const adSpend = adSpendByDate.get(date) ?? 0
    const reconciles = spend === 0
      ? adSpend === 0
      : Math.abs(adSpend - spend) / spend <= SPEND_RECONCILIATION_TOLERANCE
    if (!reconciles) globalBlockers.add('spend_reconciliation_failed')
  }

  const touchesById = new Map<string, PaidTouchCohortInput>()
  let inWindowCapturedTouches = 0
  let latestTouch: string | null = null
  for (const touch of input.touches) {
    if (touchesById.has(touch.id)) globalBlockers.add('duplicate_touch_id')
    touchesById.set(touch.id, touch)
    const date = localDate(touch.observedAt, input.timezone)
    if (!date) {
      globalBlockers.add('invalid_touch_time')
      continue
    }
    if (!dateSet.has(date)) continue
    inWindowCapturedTouches += 1
    if (!latestTouch || touch.observedAt > latestTouch) latestTouch = touch.observedAt
    const ids = identity(touch.metaCampaignId, touch.metaAdsetId, touch.metaAdId)
    if (!touch.identityComplete || !ids) {
      // An unassignable in-window touch makes account- and campaign-level zeroes unsafe. Keep known
      // unit metrics visible, but block the generation from becoming decision evidence.
      globalBlockers.add('incomplete_touch_identity')
      continue
    }
    const aggregate = getAd(ads, ids)
    aggregate.capturedTouches += 1
    // A reload / back-nav / SPA route change re-POSTs the SAME click, writing another observation.
    // fbclid identifies the click, so distinct fbclids is the click count and the gap between the
    // two is the duplicate rate. Touches with no fbclid fall back to their own id — one click each,
    // never collapsed with a real click.
    aggregate.capturedClicks.add(touch.fbclid ?? `touch:${touch.id}`)
  }

  // Coverage reconciliation is performed at the ad level across the whole window, not per day.
  // Meta Pixel/GTM injection timing and attribution-window delays make day-level matching brittle;
  // the ad-level total is the stable signal for whether server captures are in the right ballpark.
  for (const aggregate of ads.values()) {
    if (!aggregate.landingPageViewsKnown) continue
    if (!coverageMatches(aggregate.capturedTouches, aggregate.landingPageViews)) {
      aggregate.blockers.add('capture_coverage_mismatch')
    }
  }

  const appointments = new Map(input.appointments.map((row) => [row.id, row]))
  const seenAppointments = new Set<number>()
  const inWindowLinkedAppointments = new Set<number>()
  let latestLink: string | null = null
  for (const link of input.links) {
    const linkDate = localDate(link.lastInteractionAt, input.timezone)
    if (!linkDate) {
      globalBlockers.add('invalid_touch_time')
      continue
    }
    if (!dateSet.has(linkDate)) continue
    inWindowLinkedAppointments.add(link.appointmentId)
    if (link.linkedAt && (!latestLink || link.linkedAt > latestLink)) latestLink = link.linkedAt
    const touch = touchesById.get(link.lastTouchId)
    if (!touch) {
      globalBlockers.add('orphan_link_touch')
      continue
    }
    const ids = identity(touch.metaCampaignId, touch.metaAdsetId, touch.metaAdId)
    if (!touch.identityComplete || !ids) {
      // A linked appointment on an incomplete touch is the most dangerous false-zero case: the
      // booking is real, but its immutable Meta unit is unknown. Never discard it and then mark the
      // cohort complete with zero outcomes.
      globalBlockers.add('incomplete_touch_identity')
      continue
    }
    const aggregate = getAd(ads, ids)
    if (new Date(link.lastInteractionAt).getTime() !== new Date(touch.observedAt).getTime()) {
      aggregate.blockers.add('link_touch_mismatch')
      continue
    }
    if (seenAppointments.has(link.appointmentId)) {
      aggregate.blockers.add('link_touch_mismatch')
      continue
    }
    seenAppointments.add(link.appointmentId)
    const appointment = appointments.get(link.appointmentId)
    if (!appointment) {
      aggregate.blockers.add('appointment_state_missing')
      continue
    }
    if (!freshAtOrAfter(appointment.syncedAt, sourceBoundaryMs)) {
      aggregate.blockers.add('stale_appointment_state')
    }
    if (appointment.canceled) {
      aggregate.canceledLinks += 1
      continue
    }
    const price = metric(appointment.price)
    if (price === null) {
      aggregate.blockers.add('invalid_appointment_value')
      continue
    }
    const recordedRevenue = metric(appointment.amountPaid)
    if (recordedRevenue === null) {
      aggregate.blockers.add('invalid_appointment_revenue')
    }
    if (price > 0) {
      // Booking existence and scheduled booked value are already known. Preserve those facts even
      // when checkout-revenue coverage is missing; otherwise an incomplete amount_paid value turns a
      // real booking into a diagnostic zero. Completeness still blocks every money decision below.
      aggregate.bookings += 1
      aggregate.bookedValue += price
    } else {
      aggregate.zeroValueBookings += 1
    }
    if (recordedRevenue !== null) aggregate.recordedRevenue += recordedRevenue
  }

  // The exhaustive capture/linker manifest is a policy-v3 requirement. Under the v2 freeze
  // (see `paid_cohort_policy_cutovers`) no producer can honestly populate capture_eligible_inputs, so demanding the
  // manifest would block every generation forever rather than describe evidence quality. The
  // mismatch checks below still run whenever a manifest IS supplied, so v3 stays fully armed the
  // moment PAID_COHORT_POLICY.policyVersion returns to 3.
  const manifestRequired = PAID_COHORT_POLICY.policyVersion >= 3
  const completenessManifest = input.completenessManifest
  if (!completenessManifest) {
    if (manifestRequired) globalBlockers.add('paid_completeness_manifest_unavailable')
  } else {
    const manifestCounts = [
      completenessManifest.captureEligibleInputs,
      completenessManifest.capturedTouches,
      completenessManifest.eligibleAppointments,
      completenessManifest.evaluatedAppointments,
      completenessManifest.linkedAppointments,
    ]
    const identityMatches = completenessManifest.evaluationRunId === input.evaluationRunId
      && completenessManifest.cohortKind === input.cohortKind
      && completenessManifest.windowStart === input.window.start
      && completenessManifest.windowEnd === input.window.end
      && sameInstant(completenessManifest.sourceNotBefore, input.sourceNotBefore)
      && freshAtOrAfter(completenessManifest.captureCompletedAt, sourceBoundaryMs)
      && freshAtOrAfter(completenessManifest.linkerCompletedAt, sourceBoundaryMs)
      && manifestCounts.every(nonnegativeInteger)
    if (!identityMatches) globalBlockers.add('paid_completeness_manifest_mismatch')

    const captureComplete = completenessManifest.captureComplete
      && completenessManifest.captureEligibleInputs > 0
      && completenessManifest.captureEligibleInputs === completenessManifest.capturedTouches
    if (!captureComplete) globalBlockers.add('paid_capture_source_incomplete')
    if (completenessManifest.capturedTouches !== inWindowCapturedTouches) {
      globalBlockers.add('paid_completeness_manifest_mismatch')
    }

    const linkerComplete = completenessManifest.linkerComplete
      && completenessManifest.evaluatedAppointments === completenessManifest.eligibleAppointments
      && completenessManifest.linkedAppointments <= completenessManifest.evaluatedAppointments
    if (!linkerComplete) globalBlockers.add('paid_linker_source_incomplete')
    if (completenessManifest.linkedAppointments !== inWindowLinkedAppointments.size) {
      globalBlockers.add('paid_completeness_manifest_mismatch')
    }
    if (
      completenessManifest.captureComplete
      && completenessManifest.linkerComplete
      && completenessManifest.blockerCodes.length > 0
    ) globalBlockers.add('paid_completeness_manifest_mismatch')
  }

  for (const blocker of globalBlockers) manifestBlockers.add(blocker)
  for (const aggregate of ads.values()) {
    for (const blocker of aggregate.blockers) manifestBlockers.add(blocker)
  }
  const adRows = [...ads.values()].sort((a, b) => adKey(a).localeCompare(adKey(b)))
  const accountUnit = aggregateUnit(
    'account', input.accountMetaId, adRows, globalBlockers,
    accountSpendKnown ? accountSpend : null,
  )
  // Account completeness represents the whole manifest, including known local gaps.
  accountUnit.blocker_codes = sorted([...globalBlockers, ...manifestBlockers])
  accountUnit.complete = accountUnit.blocker_codes.length === 0

  const units: PaidCohortUnitPayload[] = [accountUnit]
  const hierarchy: Array<{ level: 'campaign' | 'adset'; idOf: (row: AdAggregate) => string }> = [
    { level: 'campaign', idOf: (row) => row.campaignId },
    { level: 'adset', idOf: (row) => row.adsetId },
  ]
  for (const item of hierarchy) {
    const ids = sorted(adRows.map(item.idOf))
    for (const id of ids) {
      units.push(aggregateUnit(item.level, id, adRows.filter((row) => item.idOf(row) === id), globalBlockers))
    }
  }
  for (const row of adRows) {
    units.push(aggregateUnit('ad', row.adId, [row], globalBlockers))
  }

  const bookings = adRows.reduce((sum, row) => sum + row.bookings, 0)
  const bookedValue = adRows.reduce((sum, row) => sum + row.bookedValue, 0)
  const recordedRevenue = adRows.reduce((sum, row) => sum + row.recordedRevenue, 0)
  const zeroValue = adRows.reduce((sum, row) => sum + row.zeroValueBookings, 0)
  const canceledLinks = adRows.reduce((sum, row) => sum + row.canceledLinks, 0)
  const landingKnown = adRows.every((row) => row.landingPageViewsKnown)
  const landingPageViews = landingKnown
    ? adRows.reduce((sum, row) => sum + row.landingPageViews, 0)
    : null
  const capturedTouches = adRows.reduce((sum, row) => sum + row.capturedTouches, 0)
  // Distinct clicks across all ads. Union rather than a sum of per-ad sizes: a single click cannot
  // belong to two ads, but taking the union keeps the invariant true by construction.
  const capturedClicks = new Set<string>()
  for (const row of adRows) for (const click of row.capturedClicks) capturedClicks.add(click)
  const duplicateTouches = capturedTouches - capturedClicks.size
  const blockerCodes = sorted([...globalBlockers, ...manifestBlockers])

  return {
    id: input.generationId,
    cohort_kind: input.cohortKind,
    window_start: input.window.start,
    window_end: input.window.end,
    activation_id: input.activation?.id ?? null,
    account_spend: accountSpendKnown ? money(accountSpend) : null,
    entity_spend: insightMetricsValid ? money(entitySpend) : null,
    landing_page_views: landingPageViews,
    captured_landing_views: capturedTouches,
    complete: blockerCodes.length === 0,
    blocker_codes: blockerCodes,
    source_heads: {
      activation: input.activation?.activatedAt ?? null,
      daily_insights: latestInsight,
      paid_touches: latestTouch,
      appointment_links: latestLink,
      appointment_ledger: input.appointmentSourceHead,
      appointment_ledger_window_basis: input.appointmentSourceWindowBasis ?? null,
      appointment_ledger_window_start: input.appointmentSourceWindowStart ?? null,
      appointment_ledger_window_end: input.appointmentSourceWindowEnd ?? null,
      paid_completeness_manifest: completenessManifest?.id ?? null,
      paid_completeness_manifest_run: completenessManifest?.evaluationRunId ?? null,
      paid_completeness_source_not_before: completenessManifest?.sourceNotBefore ?? null,
      paid_capture_completed_at: completenessManifest?.captureCompletedAt ?? null,
      paid_linker_completed_at: completenessManifest?.linkerCompletedAt ?? null,
    },
    metrics: {
      bookings,
      booked_value: money(bookedValue),
      outcome_recorded_revenue: money(recordedRevenue),
      zero_value_bookings: zeroValue,
      canceled_links: canceledLinks,
      // Duplicate-observation telemetry. coverageMatches is one-sided (only under-capture can
      // manufacture a false zero), so over-capture no longer raises a blocker — these two make the
      // over-capture VISIBLE instead. captured_clicks is the click count; captured_duplicate_touches
      // is how many observation rows were repeat views of a click already counted. A rising
      // duplicate rate means the capture endpoint is re-firing (it has no dedup: the fingerprint at
      // paid-touch-store.ts includes a client-generated capture_id, so only exact network retries
      // collapse) and the numerator is inflating silently.
      captured_clicks: capturedClicks.size,
      captured_duplicate_touches: duplicateTouches,
      capture_eligible_inputs: completenessManifest?.captureEligibleInputs ?? null,
      manifest_captured_touches: completenessManifest?.capturedTouches ?? null,
      linker_eligible_appointments: completenessManifest?.eligibleAppointments ?? null,
      linker_evaluated_appointments: completenessManifest?.evaluatedAppointments ?? null,
      manifest_linked_appointments: completenessManifest?.linkedAppointments ?? null,
      ...ratioMetrics(accountSpendKnown ? money(accountSpend) : null, bookings, money(bookedValue), money(recordedRevenue)),
    },
    units,
  }
}
