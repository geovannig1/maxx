import { roundMoney } from '@/lib/utils/format-currency'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createClaimedSeries, type ClaimedSeries } from '@/lib/cockpit/series-contract'
import {
  classifyWindowDays, summariseCoverage,
  type DailyValueRow, type SyncAttempt,
} from '@/lib/cockpit/window-days'
import {
  buildAttributionLadder,
  type AttributionLadder, type LadderCounts, type LadderMoneyInput, type MetaInput,
} from '@/lib/cockpit/attribution-ladder'
import { byAudience, byConcept, buildTodayRead, type AdRow, type GroupPerformance, type TodayRead } from '@/lib/cockpit/audience-performance'
import { COCKPIT_TIMEZONE, type CockpitRange } from './evidence'
import { requireOutcomeCurrency } from '@/lib/outcomes/aggregation'
import { isCausalContributionMetric } from '@/lib/economics/causal-metric'

/**
 * Server readers for the two objects the rebuilt Today page adds: a daily delivery series and the
 * attribution ladder.
 *
 * Aggregation is pure and exported separately from the queries, so the arithmetic is testable
 * without a database — the queries only fetch rows.
 */

const num = (value: unknown): number | null => {
  if (value === null || value === undefined) return null
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

export type DeliveryMetric = 'spend' | 'results' | 'impressions' | 'link_clicks'

const METRIC_COLUMN: Record<DeliveryMetric, string> = {
  spend: 'spend', results: 'bookings', impressions: 'impressions', link_clicks: 'link_clicks',
}
const METRIC_LABEL: Record<DeliveryMetric, string> = {
  spend: 'Meta spend', results: 'Meta-claimed results', impressions: 'Impressions', link_clicks: 'Link clicks',
}
const METRIC_UNIT: Record<DeliveryMetric, 'money' | 'count'> = {
  spend: 'money', results: 'count', impressions: 'count', link_clicks: 'count',
}

export interface DeliverySeriesInputs {
  rows: DailyValueRow[]
  attempts: SyncAttempt[]
}

/** Pure: turn fetched rows into a validated, frozen series. */
export function assembleDeliverySeries(args: {
  metric: DeliveryMetric
  range: CockpitRange
  asOf: string
  metaAccountId: string
  inputs: DeliverySeriesInputs
}): ClaimedSeries {
  const days = classifyWindowDays({
    window: { start: args.range.start, end: args.range.end },
    rows: args.inputs.rows,
    attempts: args.inputs.attempts,
  })
  return createClaimedSeries({
    seriesId: `meta.${args.metric}.daily:${args.range.start}:${args.range.end}`,
    metricKey: `meta.${args.metric}`,
    label: METRIC_LABEL[args.metric],
    unit: METRIC_UNIT[args.metric],
    granularity: 'day',
    source: { system: 'meta', head: 'daily_insights', evidencePlane: 'meta_delivery' },
    entity: { level: 'account', id: args.metaAccountId },
    window: args.range,
    asOf: args.asOf,
    measurementKind: args.metric === 'results' ? 'modelled' : 'measured',
    availability: { state: 'available', blockerCodes: [] },
    coverage: summariseCoverage(days),
    points: days,
  })
}

export async function readDeliverySeriesInputs(
  db: SupabaseClient,
  adAccountId: string,
  range: CockpitRange,
  metric: DeliveryMetric,
): Promise<DeliverySeriesInputs> {
  const column = METRIC_COLUMN[metric]
  const [insights, syncs] = await Promise.all([
    // Static column list: Supabase's typed `select` cannot parse an interpolated column name, and
    // the metric is picked off the row below instead.
    db.from('daily_insights')
      .select('date_start, spend, bookings, impressions, link_clicks')
      .eq('ad_account_id', adAccountId)
      .eq('entity_level', 'account')
      .gte('date_start', range.start)
      .lte('date_start', range.end),
    // Coverage is what proves an absent day means "no delivery" rather than "never fetched", so
    // every successful attempt that touches the window counts, whenever it ran.
    db.from('api_sync_logs')
      .select('date_range_start, date_range_end, status')
      .eq('ad_account_id', adAccountId)
      .not('date_range_start', 'is', null)
      .not('date_range_end', 'is', null)
      .lte('date_range_start', range.end)
      .gte('date_range_end', range.start),
  ])
  if (insights.error) throw new Error(`cockpit_series_insights_unavailable:${insights.error.message}`)
  if (syncs.error) throw new Error(`cockpit_series_coverage_unavailable:${syncs.error.message}`)

  const rows: DailyValueRow[] = []
  for (const raw of insights.data ?? []) {
    const record = raw as unknown as Record<string, unknown>
    const date = typeof record.date_start === 'string' ? record.date_start : null
    const value = num(record[column])
    // A row present but null-valued is not a measurement; leaving it out lets the classifier
    // decide honestly rather than coercing it to zero here.
    if (date !== null && value !== null) rows.push({ date, value })
  }
  const attempts: SyncAttempt[] = (syncs.data ?? []).map((raw) => {
    const record = raw as unknown as Record<string, unknown>
    return {
      dateRangeStart: typeof record.date_range_start === 'string' ? record.date_range_start : null,
      dateRangeEnd: typeof record.date_range_end === 'string' ? record.date_range_end : null,
      status: String(record.status ?? ''),
    }
  })
  return { rows, attempts }
}

export async function readDeliverySeries(
  db: SupabaseClient,
  adAccountId: string,
  metaAccountId: string,
  range: CockpitRange,
  metric: DeliveryMetric,
  asOf: string,
): Promise<ClaimedSeries> {
  const inputs = await readDeliverySeriesInputs(db, adAccountId, range, metric)
  return assembleDeliverySeries({ metric, range, asOf, metaAccountId, inputs })
}

// ── Attribution ladder ────────────────────────────────────────────────────────

export interface LadderRows {
  /** From `v_business_outcomes` — the canonical business classifier (state 'cancelled' read as 'canceled'). */
  bookings: Array<{ id: unknown; business_state: unknown; price: unknown; amount_paid: unknown }>
  /** From `outcomes` — the only place utm/fbclid live. */
  appointments: Array<{ id: unknown; utm_source: unknown; fbclid: unknown }>
  linkedAppointmentIds: unknown[]
  /** Account-level `daily_insights` rows across the same window. */
  delivery: Array<{
    bookings: unknown
    bookings_view_through: unknown
    appointment_value: unknown
    appointment_value_view_through: unknown
  }>
}

/** Pure: fold fetched rows into the ladder. */
export function assembleAttributionLadder(rows: LadderRows): AttributionLadder {
  let valueBearing = 0
  let zeroValue = 0
  let bookedValue = 0
  let collectedAmount = 0
  let amountPaidKnown = 0
  let amountPaidTotal = 0
  const valueBearingIds = new Set<string>()
  const cancelledIds = new Set<string>()

  for (const row of rows.bookings) {
    const state = String(row.business_state ?? '')
    if (state === 'canceled') { cancelledIds.add(String(row.id)); continue }
    if (state === 'active_value_bearing') { valueBearing += 1; valueBearingIds.add(String(row.id)) }
    else if (state === 'active_zero_value') zeroValue += 1

    bookedValue += num(row.price) ?? 0
    amountPaidTotal += 1
    const paid = num(row.amount_paid)
    // A missing checkout amount is unknown, never $0 — so it raises no total and the sum it does
    // not join becomes an observed lower bound.
    if (paid !== null) { collectedAmount += paid; amountPaidKnown += 1 }
  }

  // Every rung is measured over the SAME population — the value-bearing bookings counted on the
  // first rung — so the ladder nests by construction rather than by luck. Counting paid signals
  // over all appointments would let a zero-value booking with a utm tag push a lower rung above a
  // higher one, turning the funnel into a chart of unrelated numbers.
  let withPaidSignal = 0
  let withFbclid = 0
  const linkedIds = new Set(rows.linkedAppointmentIds.map(String))
  let webhookLinked = 0
  for (const row of rows.appointments) {
    const id = String(row.id)
    if (!valueBearingIds.has(id)) continue
    const hasFbclid = typeof row.fbclid === 'string' && row.fbclid !== ''
    const hasUtm = typeof row.utm_source === 'string' && row.utm_source !== ''
    if (hasFbclid || hasUtm) withPaidSignal += 1
    if (hasFbclid) withFbclid += 1
    if (linkedIds.has(id)) webhookLinked += 1
  }

  let results = 0
  let viewThrough = 0
  let daysMissingViewThroughSplit = 0
  let anyViewThroughReported = false
  // The value split is tracked with its OWN reported-flag, not the count's. Meta can break results
  // out by window on a day it does not break value out, so borrowing the count's flag would assert
  // a $0 view-through share that was never measured.
  let valueAmount = 0
  let viewThroughValue = 0
  let anyViewThroughValueReported = false
  for (const row of rows.delivery) {
    results += num(row.bookings) ?? 0
    const vt = num(row.bookings_view_through)
    if (vt === null) daysMissingViewThroughSplit += 1
    else { viewThrough += vt; anyViewThroughReported = true }

    valueAmount += num(row.appointment_value) ?? 0
    const vtValue = num(row.appointment_value_view_through)
    if (vtValue !== null) { viewThroughValue += vtValue; anyViewThroughValueReported = true }
  }

  const counts: LadderCounts = {
    valueBearingBookings: valueBearing,
    zeroValueBookings: zeroValue,
    withPaidSignal,
    withFbclid,
    webhookLinked,
    webhookLinkedCancelled: [...cancelledIds].filter((id) => linkedIds.has(id)).length,
  }
  const money: LadderMoneyInput = {
    bookedValue: roundMoney(bookedValue),
    collectedAmount: roundMoney(collectedAmount),
    amountPaidKnown, amountPaidTotal,
  }
  const meta: MetaInput = {
    results,
    viewThrough: anyViewThroughReported ? viewThrough : null,
    daysMissingViewThroughSplit,
    valueAmount: roundMoney(valueAmount),
    viewThroughValue: anyViewThroughValueReported ? roundMoney(viewThroughValue) : null,
  }
  return buildAttributionLadder({ counts, money, meta })
}

export async function readAttributionLadder(
  db: SupabaseClient,
  adAccountId: string,
  range: CockpitRange,
): Promise<AttributionLadder> {
  const [bookings, appointments, linked, delivery] = await Promise.all([
    // Enabled outcome sources only, one currency (src/lib/outcomes/aggregation.ts).
    db.from('v_business_outcomes')
      .select('id, currency, business_state, price:gross_value, amount_paid:collected_value')
      .eq('ad_account_id', adAccountId)
      .eq('source_enabled', true)
      .gte('business_date', range.start).lte('business_date', range.end),
    db.from('v_business_outcomes')
      .select('id, utm_source, fbclid')
      .eq('ad_account_id', adAccountId)
      .eq('source_enabled', true)
      .gte('business_date', range.start).lte('business_date', range.end),
    db.from('outcome_touch_links')
      .select('outcome_id')
      .eq('ad_account_id', adAccountId),
    db.from('daily_insights')
      .select('bookings, bookings_view_through, appointment_value, appointment_value_view_through')
      .eq('ad_account_id', adAccountId).eq('entity_level', 'account')
      .gte('date_start', range.start).lte('date_start', range.end),
  ])
  for (const [name, result] of Object.entries({ bookings, appointments, linked, delivery })) {
    if (result.error) throw new Error(`cockpit_ladder_${name}_unavailable:${result.error.message}`)
  }
  requireOutcomeCurrency((bookings.data ?? []) as Array<{ currency?: string | null }>)
  return assembleAttributionLadder({
    bookings: ((bookings.data ?? []) as LadderRows['bookings']).map((row) => (
      row.business_state === 'cancelled' ? { ...row, business_state: 'canceled' } : row
    )),
    appointments: (appointments.data ?? []) as LadderRows['appointments'],
    // Links are filtered to the window by the value-bearing id set above, so no join is needed.
    linkedAppointmentIds: (linked.data ?? []).map((row) => (row as { outcome_id: unknown }).outcome_id),
    delivery: (delivery.data ?? []) as LadderRows['delivery'],
  })
}

export { COCKPIT_TIMEZONE }

// ── Audience / concept performance ────────────────────────────────────────────

/** Ad-level delivery for the window, keyed by ad name so the taxonomy can group it. */
export async function readAdRows(
  db: SupabaseClient, adAccountId: string, range: CockpitRange,
): Promise<AdRow[]> {
  const { data, error } = await db
    .from('daily_insights')
    .select('spend, bookings, link_clicks, impressions, ads!inner(ad_name, effective_status)')
    .eq('ad_account_id', adAccountId)
    .eq('entity_level', 'ad')
    .gte('date_start', range.start)
    .lte('date_start', range.end)
  if (error) throw new Error(`cockpit_ad_rows_unavailable:${error.message}`)

  // One row per ad-day arrives; the taxonomy groups by name, so fold to one row per ad first.
  const perAd = new Map<string, AdRow>()
  for (const raw of data ?? []) {
    const row = raw as unknown as Record<string, unknown>
    const ad = row.ads as { ad_name?: unknown; effective_status?: unknown } | null
    const adName = typeof ad?.ad_name === 'string' ? ad.ad_name : null
    if (!adName) continue
    const existing = perAd.get(adName) ?? {
      adName, status: typeof ad?.effective_status === 'string' ? ad.effective_status : null,
      spend: 0, results: 0, clicks: 0, impressions: 0,
    }
    existing.spend += num(row.spend) ?? 0
    existing.results += num(row.bookings) ?? 0
    existing.clicks += num(row.link_clicks) ?? 0
    existing.impressions += num(row.impressions) ?? 0
    perAd.set(adName, existing)
  }
  return [...perAd.values()]
}

// ── Page loader ───────────────────────────────────────────────────────────────

export const TRACK_RECORD_DISPLAY_FLOOR = 6

export interface TrackRecordPlay {
  play: string
  worked: number
  failed: number
  inconclusive: number
}

export interface TrackRecord {
  /** Only plays meeting the display floor. A small-n win-rate is noise this page refuses to print. */
  plays: TrackRecordPlay[]
  /** Decisive (worked + failed) reviewed outcomes across ALL plays, so the empty state can tell
   * "none reviewed" from "not enough reviewed". */
  totalDecisive: number
  /** Outcomes recorded but not yet owner-reviewed. */
  pendingReview: number
}

export interface OutcomeRowInput {
  flag_type: string | null
  metric_name: string | null
  outcome: string | null
  outcome_note: string | null
  review_status: string | null
}

/**
 * The owner-visible record (Ledger C′′). The gates replicate the trusted win-rate gates in
 * learning/patterns.ts exactly (causal-metric gate, owner-approval gate, estimate-only exclusion),
 * but the counts come from recommendation_outcomes directly: learned_patterns stores only a rounded
 * win_rate, and "3 of 4 reviewed calls worked" is unrecoverable from a rounded percentage.
 */
export function summarizeTrackRecord(rows: OutcomeRowInput[]): TrackRecord {
  const byPlay = new Map<string, TrackRecordPlay>()
  let pendingReview = 0
  for (const row of rows) {
    if (!isCausalContributionMetric(row.metric_name)) continue
    if (row.outcome === null) continue
    const reviewStatus = row.review_status ?? 'pending'
    if (reviewStatus === 'pending') { pendingReview++; continue }
    if (reviewStatus !== 'approved') continue
    if ((row.outcome_note ?? '').includes('estimate-only')) continue
    if (row.outcome !== 'worked' && row.outcome !== 'failed' && row.outcome !== 'inconclusive') continue
    const play = row.flag_type ?? 'unknown'
    if (!byPlay.has(play)) byPlay.set(play, { play, worked: 0, failed: 0, inconclusive: 0 })
    byPlay.get(play)![row.outcome]++
  }
  const plays = [...byPlay.values()]
  return {
    plays: plays.filter((p) => p.worked + p.failed >= TRACK_RECORD_DISPLAY_FLOOR),
    totalDecisive: plays.reduce((sum, p) => sum + p.worked + p.failed, 0),
    pendingReview,
  }
}

async function readTrackRecord(db: SupabaseClient, adAccountDbId: string): Promise<TrackRecord> {
  // All-time on purpose — the copy on the page says "across all reviewed outcomes", and the stored
  // window_days on learned_patterns is known-mislabeled for this population (Ledger E).
  const { data, error } = await db
    .from('recommendation_outcomes')
    .select('flag_type, metric_name, outcome, outcome_note, review_status')
    .eq('ad_account_id', adAccountDbId)
    .not('outcome', 'is', null)
  if (error) throw new Error(error.message)
  return summarizeTrackRecord((data ?? []) as OutcomeRowInput[])
}

export interface TodayExtras {
  ladder: AttributionLadder | null
  spendSeries: ClaimedSeries | null
  read: TodayRead | null
  audiences: GroupPerformance[]
  concepts: GroupPerformance[]
  /** Null when the read failed, so the block says "temporarily unavailable" rather than implying
   * an empty record. */
  trackRecord: TrackRecord | null
  /** Present when a read failed, so the page can say so rather than imply emptiness. */
  unavailableReason: string | null
}

/**
 * Load the two additions to the Today page.
 *
 * These are display surfaces, not decision inputs, so a failure degrades to "not shown with a
 * stated reason" rather than taking the whole page down — but it is never allowed to degrade to a
 * confident empty ladder, which would read as "no bookings" instead of "could not read".
 */
export async function loadTodayExtras(range: { from: string; to: string }): Promise<TodayExtras> {
  const { getAdminClient } = await import('@/lib/supabase/admin')
  const { resolveOnlyActiveAccount } = await import('@/lib/accounts/active-account')

  const db = getAdminClient()
  const resolution = await resolveOnlyActiveAccount(db)
  if (!resolution.ok) {
    return {
      ladder: null, spendSeries: null, read: null, audiences: [], concepts: [],
      trackRecord: null,
      unavailableReason: `account_scope_unavailable:${resolution.reason}`,
    }
  }
  const account = resolution.account
  const cockpitRange: CockpitRange = {
    start: range.from, end: range.to, basis: 'closed_account_days', timezone: COCKPIT_TIMEZONE,
  }
  const asOf = new Date().toISOString()

  const [ladder, spendSeries, adRows, trackRecord] = await Promise.all([
    readAttributionLadder(db, account.id, cockpitRange).catch((error: unknown) => {
      console.error('today_ladder_unavailable', error)
      return null
    }),
    readDeliverySeries(db, account.id, account.accountId, cockpitRange, 'spend', asOf).catch((error: unknown) => {
      console.error('today_spend_series_unavailable', error)
      return null
    }),
    // The read is lifetime-scoped on purpose: a group needs enough bookings to separate, and the
    // default month-to-date window rarely supplies them. The window governs the ladder and the
    // trend; the guidance looks at the whole record.
    readAdRows(db, account.id, { ...cockpitRange, start: '2000-01-01' }).catch((error: unknown) => {
      console.error('today_ad_rows_unavailable', error)
      return [] as AdRow[]
    }),
    readTrackRecord(db, account.id).catch((error: unknown) => {
      console.error('today_track_record_unavailable', error)
      return null
    }),
  ])
  const audiences = byAudience(adRows)
  const concepts = byConcept(adRows)
  return {
    ladder, spendSeries, audiences, concepts, trackRecord,
    read: adRows.length > 0 ? buildTodayRead(audiences) : null,
    unavailableReason: ladder === null && spendSeries === null ? 'today_extras_read_failed' : null,
  }
}
