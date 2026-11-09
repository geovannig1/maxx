import 'server-only'
import { BetaAnalyticsDataClient } from '@google-analytics/data'
import { DEFAULT_GA4_BOOKING_EVENT } from './event-names'

// GA4 Data API client. Reads credentials from env so nothing is hardcoded:
//   GA4_PROPERTY_ID            e.g. 123456789
//   GA4_SERVICE_ACCOUNT_JSON   the FULL service-account JSON (the file containing "private_key")
// GA4 receives confirmation-event telemetry. Without appointment identity it is not a booking or
// money source: events may duplicate or retain nominal appointment value without ledger validation.

let client: BetaAnalyticsDataClient | null = null

interface ClientResult {
  client: BetaAnalyticsDataClient | null
  reason: string | null
  diagnostics: Record<string, unknown>
}

function getClient(): ClientResult {
  const raw = process.env.GA4_SERVICE_ACCOUNT_JSON
  const propertyId = process.env.GA4_PROPERTY_ID

  // Safe diagnostics — booleans/lengths only, NEVER the private key value.
  const diagnostics: Record<string, unknown> = {
    GA4_PROPERTY_ID_present: !!propertyId,
    GA4_PROPERTY_ID_value: propertyId ?? null,
    GA4_SERVICE_ACCOUNT_JSON_present: !!raw,
    GA4_SERVICE_ACCOUNT_JSON_length: raw?.length ?? 0,
    json_parse_ok: false,
    has_client_email: false,
    has_private_key: false,
    private_key_has_real_newlines: false,
    client_email: null as string | null,
  }

  if (!raw) {
    return { client: null, reason: 'GA4_SERVICE_ACCOUNT_JSON is not set in the environment.', diagnostics }
  }

  let creds: { client_email?: string; private_key?: string }
  try {
    creds = JSON.parse(raw)
    diagnostics.json_parse_ok = true
  } catch {
    return {
      client: null,
      reason:
        'GA4_SERVICE_ACCOUNT_JSON did not JSON.parse — it is likely truncated or mangled. Put the ENTIRE one-line JSON wrapped in single quotes in .env.local.',
      diagnostics,
    }
  }

  diagnostics.has_client_email = !!creds.client_email
  diagnostics.has_private_key = !!creds.private_key
  diagnostics.private_key_has_real_newlines =
    typeof creds.private_key === 'string' && creds.private_key.includes('\n')
  diagnostics.client_email = creds.client_email ?? null

  if (!creds.client_email || !creds.private_key) {
    return {
      client: null,
      reason: 'Parsed JSON is missing client_email or private_key — that is not the full service-account key file.',
      diagnostics,
    }
  }

  if (!client) {
    client = new BetaAnalyticsDataClient({
      credentials: { client_email: creds.client_email, private_key: creds.private_key },
    })
  }
  return { client, reason: null, diagnostics }
}

export interface Ga4BookingRow {
  date: string
  purchases: number
  revenue: number
}

export async function getGa4Bookings(
  startDate: string,
  endDate: string
): Promise<{
  available: boolean
  reason?: string
  rows: Ga4BookingRow[]
  totals: { purchases: number; revenue: number }
  diagnostics?: Record<string, unknown>
}> {
  const propertyId = process.env.GA4_PROPERTY_ID
  const { client: c, reason, diagnostics } = getClient()

  if (!c || !propertyId) {
    return {
      available: false,
      reason: reason ?? (!propertyId ? 'GA4_PROPERTY_ID is not set.' : 'GA4 not configured.'),
      rows: [],
      totals: { purchases: 0, revenue: 0 },
      diagnostics,
    }
  }

  const [resp] = await c.runReport({
    property: `properties/${propertyId}`,
    dateRanges: [{ startDate, endDate }],
    dimensions: [{ name: 'date' }],
    metrics: [{ name: 'ecommercePurchases' }, { name: 'purchaseRevenue' }],
    orderBys: [{ dimension: { dimensionName: 'date' } }],
  })

  const rows: Ga4BookingRow[] = (resp.rows ?? []).map((r) => ({
    date: r.dimensionValues?.[0]?.value ?? '',
    purchases: Number(r.metricValues?.[0]?.value ?? 0),
    revenue: Number(r.metricValues?.[1]?.value ?? 0),
  }))

  const totals = rows.reduce(
    (acc, r) => ({ purchases: acc.purchases + r.purchases, revenue: acc.revenue + r.revenue }),
    { purchases: 0, revenue: 0 }
  )

  return { available: true, rows, totals }
}

/** Per-campaign GA confirmation TELEMETRY. Not bookings, not revenue — see
 *  Ga4ConfirmationTelemetryBucket. Campaign-level BUSINESS results require an appointment-id join. */
export interface Ga4CampaignTelemetryRow {
  campaign: string
  confirmationEvents: number
  eventValue: number
}

/**
 * GA confirmation-event counts/values by **session campaign** — a telemetry-coverage diagnostic,
 * never a paid ROAS numerator. Campaign money additionally requires exact appointment identity,
 * full-window coverage, contradiction-free origin, complete mapping, and authoritative spend.
 * Session tagging is only meaningful once ads carry correct UTMs and the session is not reset by a cross-domain
 * redirect (see the tracking attribution analysis). Until then most rows return as
 * "(not set)"/"(direct)" — which makes this function a useful attribution-coverage check too.
 */
export async function getGa4ConfirmationTelemetryByCampaign(
  startDate: string,
  endDate: string
): Promise<{
  available: boolean
  reason?: string
  rows: Ga4CampaignTelemetryRow[]
  totals: { confirmationEvents: number; eventValue: number }
  attributedShare: number | null // share of confirmation EVENTS tied to a real (named) campaign
}> {
  const propertyId = process.env.GA4_PROPERTY_ID
  const { client: c, reason } = getClient()

  if (!c || !propertyId) {
    return {
      available: false,
      reason: reason ?? (!propertyId ? 'GA4_PROPERTY_ID is not set.' : 'GA4 not configured.'),
      rows: [],
      totals: { confirmationEvents: 0, eventValue: 0 },
      attributedShare: null,
    }
  }

  // Pull the channel group alongside the campaign so we can EXCLUDE non-paid sessions that
  // happen to carry a utm_campaign (e.g. an email blast token-overlapping a Meta campaign name).
  // Only paid-channel revenue may be attributed to a paid campaign.
  // ONE booking definition everywhere: count the custom GA4_BOOKING_EVENT (like getGa4RevenueBySource
  // and getGa4BookingsByAppointmentType), NOT native ecommercePurchases/purchaseRevenue — the two
  // families disagree (different events, different totals), and the native metrics returned NO
  // campaign-attributed rows while the custom event attributes cleanly (a paid booking carries
  // the full Meta campaign name on the custom event).
  // NOT business bookings: no per-event exclusion is possible without appointment identity, so these
  // are GA telemetry (GA4_BOOKINGS_SCOPE_NOTE). See reconcileGa4Bookings for the ledger-anchored join.
  const eventRows = await runBookingEventRows(c, propertyId, startDate, endDate, ['sessionCampaignName', 'sessionDefaultChannelGroup'])

  // "Unattributed" = GA4's placeholder campaigns. If most purchases land here, attribution is broken.
  const UNATTRIBUTED = new Set(['(not set)', '(direct)', '(referral)', '(organic)', '(none)', '(unknown)', ''])
  const paidByCampaign = new Map<string, { purchases: number; revenue: number }>()
  let totalPurchases = 0
  let totalRevenue = 0
  let paidTotalPurchases = 0
  let paidNamedPurchases = 0
  for (const r of eventRows) {
    const campaign = r.dims[0] || '(unknown)'
    const channel = r.dims[1] || '(unknown)'
    const purchases = r.bookings
    const revenue = r.revenue
    totalPurchases += purchases
    totalRevenue += revenue
    if (classifyChannel(channel) !== 'paid') continue // skip non-paid — the non-paid leak fix
    paidTotalPurchases += purchases
    const a = paidByCampaign.get(campaign) ?? { purchases: 0, revenue: 0 }
    a.purchases += purchases
    a.revenue += revenue
    paidByCampaign.set(campaign, a)
    if (!UNATTRIBUTED.has(campaign)) paidNamedPurchases += purchases
  }

  // Per-campaign rows are PAID-only (so matching can't pick up organic utm_campaigns)…
  const rows: Ga4CampaignTelemetryRow[] = [...paidByCampaign.entries()]
    .map(([campaign, v]) => ({ campaign, confirmationEvents: v.purchases, eventValue: v.revenue }))
    .sort((a, b) => b.confirmationEvents - a.confirmationEvents)
  // Totals stay BLENDED (all channels) as telemetry context only. They are never used for MER.
  const totals = { confirmationEvents: totalPurchases, eventValue: totalRevenue }
  // Coverage = share of ALL purchases that are paid AND tied to a real (named) campaign.
  // Campaign-telemetry HEALTH = of PAID-channel confirmation events, how many carry a named campaign.
  // Non-paid events correctly have no paid campaign; counting them in the denominator would measure
  // channel mix rather than campaign-tagging health. Neither statistic is outcome attribution.
  const attributedShare = paidTotalPurchases > 0 ? paidNamedPurchases / paidTotalPurchases : null

  return { available: true, rows, totals, attributedShare }
}

export interface Ga4Traffic {
  available: boolean
  reason?: string
  pageViews: number
  sessions: number
  users: number
  newUsers: number
  engagementRate: number | null // 0..1 (range-level, computed by GA4)
  avgSessionDuration: number | null // seconds
  bounceRate: number | null // 0..1
}

/**
 * GA4 traffic + engagement for a date range — the GA4-source-of-truth view of site activity
 * (page views, sessions, users, engagement), to sit alongside Meta's clicks/LPV estimates. Rates
 * (engagement/bounce/avg-duration) are queried as range totals (no date dimension) so GA4 computes
 * them correctly over the whole window rather than us averaging daily rates.
 */
export async function getGa4Traffic(startDate: string, endDate: string): Promise<Ga4Traffic> {
  const propertyId = process.env.GA4_PROPERTY_ID
  const { client: c, reason } = getClient()

  if (!c || !propertyId) {
    return {
      available: false,
      reason: reason ?? (!propertyId ? 'GA4_PROPERTY_ID is not set.' : 'GA4 not configured.'),
      pageViews: 0, sessions: 0, users: 0, newUsers: 0,
      engagementRate: null, avgSessionDuration: null, bounceRate: null,
    }
  }

  const [resp] = await c.runReport({
    property: `properties/${propertyId}`,
    dateRanges: [{ startDate, endDate }],
    metrics: [
      { name: 'screenPageViews' },
      { name: 'sessions' },
      { name: 'totalUsers' },
      { name: 'newUsers' },
      { name: 'engagementRate' },
      { name: 'averageSessionDuration' },
      { name: 'bounceRate' },
    ],
  })

  const m = resp.rows?.[0]?.metricValues ?? []
  const num = (i: number) => Number(m[i]?.value ?? 0)
  const opt = (i: number) => (m[i]?.value != null ? Number(m[i]!.value) : null)

  return {
    available: true,
    pageViews: num(0),
    sessions: num(1),
    users: num(2),
    newUsers: num(3),
    engagementRate: opt(4),
    avgSessionDuration: opt(5),
    bounceRate: opt(6),
  }
}

// ── Session-channel telemetry: paid vs non-paid via GA default channel grouping ──────────────────
// GA classifies sessions into default channel groups. This describes acquisition telemetry; it does
// not prove an ad caused a business outcome. "Paid" = the paid channel groups; "Organic" is the
// historical UI name for everything non-paid (organic search/social, direct, referral, email, …).

export type TrafficSource = 'complete' | 'paid' | 'organic'

// The PAID set, pinned to GA4's documented `sessionDefaultChannelGroup` values (reviewed 2026-06-29).
// It's a closed allow-list: any group NOT here (incl. GA4's `Unassigned`/`(other)` and the `(unknown)`
// fallback) is treated as ORGANIC — consistent with the owner-approved definition "Organic = everything
// non-paid". Note: `Cross-network` (largely Google Performance Max) and `Paid Search` are counted as
// paid per that "all paid channels" decision, so the bucket can include non-Meta paid traffic. It is
// never divided by Meta spend; paid money is computed only from the exact joined cohort.
const PAID_CHANNEL_GROUPS = new Set([
  'Paid Search', 'Paid Social', 'Paid Shopping', 'Paid Video', 'Display', 'Cross-network', 'Paid Other',
])

export function classifyChannel(group: string): 'paid' | 'organic' {
  return PAID_CHANNEL_GROUPS.has(group) ? 'paid' : 'organic'
}

// META-scoped paid: the GA4 default channel group that Meta (Facebook/Instagram) paid traffic maps to.
// Used to isolate Meta-adjacent telemetry in diagnostics. Other paid social (for example TikTok) can
// still land here, so this classification is not a paid-outcome identity join.
const META_PAID_CHANNELS = new Set(['Paid Social'])
export function isMetaPaidChannel(group: string): boolean {
  return META_PAID_CHANNELS.has(group)
}

export interface Ga4TrafficBucket {
  pageViews: number // exact (each session belongs to one channel group → additive)
  sessions: number // exact (additive across channels)
  // users / newUsers are the SUM of per-channel totalUsers — they OVERCOUNT a visitor who used more than
  // one channel in the window (GA4 de-duplicates users per dimension value, not across them). Treat as
  // approximate; sessions/pageViews and the recomputed rates below are exact.
  users: number
  newUsers: number
  engagementRate: number | null // 0..1 — recomputed Σengaged ÷ Σsessions (exact)
  avgSessionDuration: number | null // seconds — session-weighted (exact)
  bounceRate: number | null // 0..1 — = 1 − engagementRate (GA4's own definition)
}

export interface ChannelRow {
  channel: string
  source: 'paid' | 'organic'
  sessions: number
  pageViews: number
}

export interface Ga4TrafficBySource {
  available: boolean
  reason?: string
  paid: Ga4TrafficBucket
  organic: Ga4TrafficBucket
  byChannel: ChannelRow[]
}

function emptyBucket(): Ga4TrafficBucket {
  return { pageViews: 0, sessions: 0, users: 0, newUsers: 0, engagementRate: null, avgSessionDuration: null, bounceRate: null }
}

/** GA4 traffic split into paid vs organic by session default channel group. Rates are recomputed from
 *  summed engaged-sessions / sessions (never averaged across channels), so each bucket's rate is correct. */
export async function getGa4TrafficBySource(startDate: string, endDate: string): Promise<Ga4TrafficBySource> {
  const propertyId = process.env.GA4_PROPERTY_ID
  const { client: c, reason } = getClient()
  if (!c || !propertyId) {
    return { available: false, reason: reason ?? 'GA4 not configured.', paid: emptyBucket(), organic: emptyBucket(), byChannel: [] }
  }

  const [resp] = await c.runReport({
    property: `properties/${propertyId}`,
    dateRanges: [{ startDate, endDate }],
    dimensions: [{ name: 'sessionDefaultChannelGroup' }],
    metrics: [
      { name: 'screenPageViews' }, { name: 'sessions' }, { name: 'totalUsers' },
      { name: 'newUsers' }, { name: 'engagedSessions' }, { name: 'averageSessionDuration' },
    ],
    orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
    limit: 100,
  })

  // Accumulate raw counts per bucket (so rates are recomputed from totals, not averaged).
  const acc = {
    paid: { pageViews: 0, sessions: 0, users: 0, newUsers: 0, engagedSessions: 0, durWeighted: 0 },
    organic: { pageViews: 0, sessions: 0, users: 0, newUsers: 0, engagedSessions: 0, durWeighted: 0 },
  }
  const byChannel: ChannelRow[] = []

  for (const r of resp.rows ?? []) {
    const channel = r.dimensionValues?.[0]?.value ?? '(unknown)'
    const v = (i: number) => Number(r.metricValues?.[i]?.value ?? 0)
    const pageViews = v(0), sessions = v(1), users = v(2), newUsers = v(3), engaged = v(4), avgDur = v(5)
    const src = classifyChannel(channel)
    const a = acc[src]
    a.pageViews += pageViews; a.sessions += sessions; a.users += users; a.newUsers += newUsers
    a.engagedSessions += engaged; a.durWeighted += avgDur * sessions
    byChannel.push({ channel, source: src, sessions, pageViews })
  }

  const finalize = (a: typeof acc.paid): Ga4TrafficBucket => {
    const engagementRate = a.sessions > 0 ? a.engagedSessions / a.sessions : null
    return {
      pageViews: a.pageViews, sessions: a.sessions, users: a.users, newUsers: a.newUsers,
      engagementRate,
      avgSessionDuration: a.sessions > 0 ? a.durWeighted / a.sessions : null,
      bounceRate: engagementRate != null ? 1 - engagementRate : null,
    }
  }

  return { available: true, paid: finalize(acc.paid), organic: finalize(acc.organic), byChannel }
}

/** GA confirmation-event TELEMETRY. The field names are deliberately not `bookings`/`revenue`:
 *  those names are what let raw, unlinked GA aggregates be consumed as money across the app.
 *
 *  These events carry no appointment identity, so they cannot be joined to the ledger, deduplicated
 *  against it, or checked against ledger lifecycle state. They are a browser-attribution signal and nothing
 *  more. Business counts and booked value come from the outcome business facts (src/lib/outcomes/business-facts.ts); exact per-channel results
 *  come from an appointment-id join (see ga4/booking-reconciliation.ts). */
export interface Ga4ConfirmationTelemetryBucket {
  /** GA eventCount. NOT a booking count. */
  confirmationEvents: number
  /** GA eventValue — the value the SCHEDULER DISPLAYED, which for a comp is the NOMINAL price.
   *  NOT revenue and NOT booked value. */
  eventValue: number
}
export interface Ga4ConfirmationTelemetryBySource {
  available: boolean
  reason?: string
  paid: Ga4ConfirmationTelemetryBucket
  organic: Ga4ConfirmationTelemetryBucket
  /** Meta-scoped paid (Paid Social channel only). Subset of `paid`. */
  metaPaid: Ga4ConfirmationTelemetryBucket
  byChannel: Array<{ channel: string; source: 'paid' | 'organic'; confirmationEvents: number; eventValue: number }>
  /** Rows whose summed eventValue was 0. Reported, never silently dropped. */
  zeroValueEvents: number
}

/** The GA4 event that fires on a completed booking. The site's GTM sends a CUSTOM `appointment_confirmed`
 *  event (with value/currency) on the outcome-source confirmation — NOT a native `purchase` event — so GA4's
 *  ecommerce metrics (ecommercePurchases/purchaseRevenue) stay 0 and HID the bookings (the app showed
 *  none). We count THAT event instead. Override via GA4_BOOKING_EVENT if the GTM event
 *  name ever changes. (Root cause found by inspecting the live GTM container — the Meta-tuned tracking is
 *  correct; only the app was querying the wrong event name.) */
export const GA4_BOOKING_EVENT = process.env.GA4_BOOKING_EVENT ?? DEFAULT_GA4_BOOKING_EVENT

/** Evidence-scope label every consumer must show next to counts fed by runBookingEventRows.
 *  These are GA confirmation EVENTS with no appointment identity, so they cannot be joined to the
 *  outcome ledger and are not business bookings. (The previous constant claimed "excludes $0 (test)
 *  bookings"; it had NO consumer, so the exclusion it described was applied silently and disclosed
 *  nowhere.) */
export const GA4_BOOKINGS_SCOPE_NOTE =
  'GA web-attribution telemetry (legacy, unlinked) — not business bookings; canonical bookings and revenue come from the outcome ledger'

/** Booking-event rows for the custom confirmation event, keyed by the CALLER's dimensions.
 *
 *  This function used to drop any dateHourMinute bucket whose summed eventValue was 0 and
 *  call that "excluding test bookings". Both halves were wrong:
 *
 *    * VALUE IS NOT EVIDENCE THAT A BOOKING IS REAL. GA carries the value the scheduler DISPLAYED.
 *      A comp shows its nominal price, so an appointment with ledger price=0 / price_sold=125 /
 *      ledger-excluded appointment arrived here as a $125 event and was counted as a real $125
 *      booking. Canonical appointment-state and comp facts live in the outcome ledger; see
 *      v_business_outcomes.
 *    * THE BUCKET IS NOT AN APPOINTMENT. The rule was all-or-nothing per minute, so a genuine booking
 *      and a $0 test in the same minute were BOTH kept, and two tests in the same minute were BOTH
 *      dropped. "bookings are sparse, so each row ≈ one event" is an assumption, not an identity.
 *
 *  So no exclusion is applied here any more. These rows are GA TELEMETRY, not business bookings, and
 *  are labelled as such (GA4_BOOKINGS_SCOPE_NOTE). Business truth comes from the ledger; the join is
 *  reconcileGa4Bookings(). `zeroValueRows` is reported so the count is visible instead of silent.
 *
 *  GRANULARITY IS `date`, NOT `dateHourMinute`, AND THAT IS LOAD-BEARING. GA4 serves `date` and
 *  `dateHour` from retained daily aggregate tables, but `dateHourMinute` forces the query onto
 *  event-level data, which is subject to the property's `eventDataRetention` setting — two months by
 *  default, deleting one further day every day. Over a window longer than the retention period, the
 *  same event and filter return the same totals for `sessionDefaultChannelGroup` alone and with
 *  `date`, but only the retained tail with `dateHourMinute` — most events and most value,
 *  dropped with no error, no sampling flag and no `(other)` row — the
 *  API simply does not return what retention has deleted. That silently corrupted every consumer of
 *  this function: the evidence gate, campaign ROAS, the dashboard, the client report, and the
 *  learning-confidence coverage figure.
 *
 *  The minute granularity bought nothing. Two of the three callers never read it, and the third used
 *  it only to slice a date back out of the string — which `date` supplies directly, at full fidelity. */
async function runBookingEventRows(
  c: BetaAnalyticsDataClient,
  propertyId: string,
  startDate: string,
  endDate: string,
  dimensions: string[],
): Promise<Array<{ dims: string[]; bookings: number; revenue: number; zeroValue: boolean; date: string }>> {
  const [resp] = await c.runReport({
    property: `properties/${propertyId}`,
    dateRanges: [{ startDate, endDate }],
    dimensions: [...dimensions.map((name) => ({ name })), { name: 'date' }],
    metrics: [{ name: 'eventCount' }, { name: 'eventValue' }],
    dimensionFilter: { filter: { fieldName: 'eventName', stringFilter: { value: GA4_BOOKING_EVENT, matchType: 'EXACT' } } },
    limit: 10000,
  })
  // A left-truncated aggregate is indistinguishable from a smaller account, so refuse rather than
  // under-report. GA4 states the true row count separately from the page it returned; this function
  // does not page, so any excess must fail loudly. Switching to `date` RAISES row cardinality on wide
  // windows (several times as many rows on one query), which is what makes this worth asserting now.
  // An ABSENT rowCount must not read as zero. `?? 0` made a missing count satisfy the guard forever
  // while `limit: 10000` could still be capping — a guard that cannot trip is the shape this file has
  // been bitten by twice.
  if (resp.rowCount === null || resp.rowCount === undefined) {
    throw new Error(
      `GA4 omitted rowCount for ${GA4_BOOKING_EVENT}, so truncation cannot be ruled out. `
      + 'Refusing rather than reporting a possibly-partial total.',
    )
  }
  // `(other)` is the silent one. GA4 aggregates excess dimension cardinality into a single `(other)`
  // row: metric TOTALS are preserved, so nothing reconciles wrong, but the dimension is destroyed —
  // a per-campaign or per-appointment split degrades into a bucket with no error and no flag. Higher
  // cardinality is exactly what raises the risk, and switching to `date` raised cardinality.
  if (resp.metadata?.dataLossFromOtherRow) {
    throw new Error(
      `GA4 aggregated part of the ${GA4_BOOKING_EVENT} result into an "(other)" row, so the dimension `
      + 'split is incomplete even though the totals reconcile. Narrow the window or reduce dimensions.',
    )
  }
  const reportedRows = Number(resp.rowCount)
  const returnedRows = (resp.rows ?? []).length
  if (reportedRows > returnedRows) {
    throw new Error(
      `GA4 returned ${returnedRows} of ${reportedRows} rows for ${GA4_BOOKING_EVENT} — the result is `
      + 'truncated and would understate every figure derived from it. Narrow the window or add paging.',
    )
  }
  const out: Array<{ dims: string[]; bookings: number; revenue: number; zeroValue: boolean; date: string }> = []
  for (const r of resp.rows ?? []) {
    const bookings = Number(r.metricValues?.[0]?.value ?? 0)
    const revenue = Number(r.metricValues?.[1]?.value ?? 0)
    // `date` is appended LAST by this function, so it is at index dimensions.length.
    const date = r.dimensionValues?.[dimensions.length]?.value ?? ''
    // NO value-based exclusion. A $0 row is reported, not dropped: dropping it silently hid the fact
    // that GA cannot tell a test from a booking, while still letting a NOMINALLY-priced comp through.
    out.push({
      dims: dimensions.map((_, i) => r.dimensionValues?.[i]?.value ?? ''),
      bookings, revenue, zeroValue: bookings > 0 && revenue <= 0, date,
    })
  }
  return out
}

/** GA confirmation-event telemetry split paid vs organic by session default channel group.
 *
 *  RENAMED from getGa4RevenueBySource. It never returned revenue: it returns GA eventCount and
 *  eventValue for an event that carries no appointment identity. Under the old name and the old
 *  field names (`bookings`, `revenue`) it was consumed as money by economics, campaign ROAS, the
 *  daily report, the dashboard and the evidence gate. The name and the field names now say what it
 *  is, so a money surface cannot consume it by accident. */
export async function getGa4ConfirmationTelemetryBySource(
  startDate: string, endDate: string,
): Promise<Ga4ConfirmationTelemetryBySource> {
  const propertyId = process.env.GA4_PROPERTY_ID
  const { client: c, reason } = getClient()
  const zero = () => ({ confirmationEvents: 0, eventValue: 0 })
  if (!c || !propertyId) {
    return { available: false, reason: reason ?? 'GA4 not configured.', paid: zero(), organic: zero(), metaPaid: zero(), byChannel: [], zeroValueEvents: 0 }
  }

  const eventRows = await runBookingEventRows(c, propertyId, startDate, endDate, ['sessionDefaultChannelGroup'])

  const paid = zero(); const organic = zero(); const metaPaid = zero()
  const perChannel = new Map<string, { confirmationEvents: number; eventValue: number }>()
  let zeroValueEvents = 0
  for (const r of eventRows) {
    const channel = r.dims[0] || '(unknown)'
    const src = classifyChannel(channel)
    const bucket = src === 'paid' ? paid : organic
    bucket.confirmationEvents += r.bookings; bucket.eventValue += r.revenue
    if (r.zeroValue) zeroValueEvents += r.bookings
    if (isMetaPaidChannel(channel)) { metaPaid.confirmationEvents += r.bookings; metaPaid.eventValue += r.revenue }
    const a = perChannel.get(channel) ?? { confirmationEvents: 0, eventValue: 0 }
    a.confirmationEvents += r.bookings; a.eventValue += r.revenue
    perChannel.set(channel, a)
  }
  const byChannel: Ga4ConfirmationTelemetryBySource['byChannel'] = [...perChannel.entries()]
    .map(([channel, v]) => ({ channel, source: classifyChannel(channel), ...v }))
    .sort((a, b) => b.confirmationEvents - a.confirmationEvents)

  return { available: true, paid, organic, metaPaid, byChannel, zeroValueEvents }
}

// REMOVED: getGa4BookingsByAppointmentType / Ga4BookingsByType.
// It had NO production caller — the `get_outcomes_by_label` MCP tool reads the outcome ledger via
// getOutcomesByLabel. Leaving an unused API whose fields were named `bookings`/`revenue` and
// whose values were raw GA aggregates is a future footgun, so it is deleted rather than deprecated.

/** GA4 dimension carrying the source appointment id on the confirmation event. FORWARD-ONLY: it must
 *  be registered as an event-scoped custom dimension in the MAIN property, and GA4 custom dimensions
 *  are never retroactive. Events that predate registration have no identity and can never be joined. */
export const GA4_APPOINTMENT_ID_DIMENSION = 'customEvent:appointment_id'

export interface Ga4IdentifiedBookingEvent {
  /** null when the dimension is registered but this event predates it (GA4 reports '(not set)'). */
  appointmentId: number | null
  channel: string
  /** GA sessionCampaignName. Needed for exact per-campaign allocation once identity exists. */
  campaign: string
  /** ET-ish date (YYYY-MM-DD) derived from GA's dateHourMinute. Used ONLY to prove the earliest date
   *  an identified event was observed — the appointment_id go-live boundary. Never a join key. */
  eventDate: string | null
  value: number
  /** GA's eventCount for this aggregate row. This adapter previously mapped every row to ONE
   *  event object and DISCARDED the count, so a row with eventCount=2 — the browser emitting the
   *  confirmation twice — reached the reconciler as a single event and raised no duplicate warning.
   *  The count is carried, never expanded into repeated objects (a large count would be a memory
   *  hazard and tells us nothing extra). */
  eventCount: number
}

export interface Ga4IdentifiedBookingEvents {
  available: boolean
  /** Why identity is unavailable. Never conflated with "there were no bookings". */
  reason?: string
  events: Ga4IdentifiedBookingEvent[]
}

/** Confirmation events carrying the source appointment id — the only GA read that can be joined to
 *  the ledger exactly.
 *
 *  Fails SOFT and SPECIFICALLY. If the custom dimension is not registered the API rejects the request,
 *  and that must surface as "attribution pending configuration", never as zero bookings: a query error
 *  and a real absence of bookings are opposite facts. Business totals never come from here. */
export async function getGa4IdentifiedBookingEvents(
  startDate: string,
  endDate: string,
): Promise<Ga4IdentifiedBookingEvents> {
  const propertyId = process.env.GA4_PROPERTY_ID
  const { client: c, reason } = getClient()
  if (!c || !propertyId) {
    return { available: false, reason: reason ?? 'GA4 not configured.', events: [] }
  }
  try {
    const rows = await runBookingEventRows(c, propertyId, startDate, endDate, [
      GA4_APPOINTMENT_ID_DIMENSION,
      'sessionDefaultChannelGroup',
      'sessionCampaignName',
    ])
    const events: Ga4IdentifiedBookingEvent[] = []
    for (const r of rows) {
      const raw = r.dims[0]
      const id = /^\d+$/.test(raw) ? Number(raw) : null
      const m = /^(\d{4})(\d{2})(\d{2})$/.exec(r.date)
      events.push({
        appointmentId: id,
        channel: r.dims[1] || '(unknown)',
        campaign: r.dims[2] || '(unknown)',
        eventDate: m ? `${m[1]}-${m[2]}-${m[3]}` : null,
        value: r.revenue,
        eventCount: Math.max(1, Math.round(r.bookings)),
      })
    }
    return { available: true, events }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return {
      available: false,
      reason: `appointment-level GA attribution is PENDING CONFIGURATION — register the event-scoped custom dimension "appointment_id" in GA4 property ${propertyId}. This is NOT a statement that there were zero bookings; ledger totals are unaffected. (${msg})`,
      events: [],
    }
  }
}
