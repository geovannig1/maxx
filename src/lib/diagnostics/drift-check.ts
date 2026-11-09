import { getAdminClient } from '@/lib/supabase/admin'
import { nyDaysAgo } from '@/lib/utils/date-utils'
import { getAdPlatform } from '@/lib/platforms/registry'
import { insertAlertsDeduped } from '@/lib/alerts/insert'
import { findAppointmentConfirmedResults } from '@/lib/sync/upsert-insights'
import { formatMoney, formatMoneyAmount, roundMoney } from '@/lib/utils/format-currency'

// DATA-DRIFT GUARDRAIL.
//
// The single question underneath every trust defect this account has had: "does what we STORE still equal
// what Meta says RIGHT NOW?" The reconciliation report is warehouse-vs-warehouse (all copies freeze
// together), so a restatement the sync missed — or a future regression of the yesterday-only-sync class —
// would present internally-consistent numbers that are all wrong together, with zero automated signal.
// This check re-fetches LIVE Meta account-level spend for the trailing complete week and diffs it against
// BOTH stored layers (daily_insights AND the daily_reports rollups the dashboard reads). Read-only;
// drift ⇒ one deduped WARNING alert naming the worst day, never an auto-fix.

/** Per-day tolerance: |live − stored| flags only when it exceeds BOTH the absolute and relative floors
 *  (same-day API jitter is real; restatements are dollars, not cents). */
export const DRIFT_TOL_ABS = 1.0 // $
export const DRIFT_TOL_PCT = 0.02 // 2% of the live value

/** Bookings are integers and low-volume — ANY 1-booking gap is material (the 2× double-count showed up
 *  as 1→2 per day, which the $1/2% spend tolerance would MISS). Abs floor 0.5 ⇒ every ≥1 diff flags. */
export const DRIFT_TOL_BOOKINGS_ABS = 0.5
export const DRIFT_TOL_BOOKINGS_PCT = 0

export interface DriftTolerance {
  abs: number
  pct: number
}
export const SPEND_TOLERANCE: DriftTolerance = { abs: DRIFT_TOL_ABS, pct: DRIFT_TOL_PCT }
export const BOOKINGS_TOLERANCE: DriftTolerance = { abs: DRIFT_TOL_BOOKINGS_ABS, pct: DRIFT_TOL_BOOKINGS_PCT }

export interface DayDiff {
  date: string
  live: number | null // null = Meta returned no row for the day (no delivery)
  stored: number | null // null = the layer has no row for the day
  delta: number // stored − live (0-filled sides)
  drifted: boolean
}

export interface LayerDrift {
  layer: 'daily_insights' | 'daily_reports' | 'bookings'
  days: DayDiff[]
  drifted_days: number
  worst: DayDiff | null // largest |delta| among drifted days
}

export interface DriftReport {
  available: boolean
  reason: string | null
  window: { since: string; until: string }
  layers: LayerDrift[]
  verdict: 'aligned' | 'drift'
  note: string
}

function exceedsTolerance(live: number, stored: number, tol: DriftTolerance): boolean {
  const delta = Math.abs(stored - live)
  return delta > tol.abs && delta > Math.abs(live) * tol.pct
}

/** PURE: per-day live-vs-stored diff for one stored layer (spend by default; bookings with the integer
 *  tolerance). A day the LIVE side has (value > tolerance) but the layer is missing = drift (the freeze
 *  class); a live no-delivery day with stored ≈ 0 is aligned. */
export function diffLayer(
  layer: LayerDrift['layer'],
  liveByDay: Map<string, number>,
  storedByDay: Map<string, number>,
  windowDays: string[],
  tol: DriftTolerance = SPEND_TOLERANCE,
): LayerDrift {
  const days: DayDiff[] = windowDays.map((date) => {
    const live = liveByDay.has(date) ? liveByDay.get(date)! : null
    const stored = storedByDay.has(date) ? storedByDay.get(date)! : null
    const l = live ?? 0
    const s = stored ?? 0
    let drifted: boolean
    if (live === null && stored === null) drifted = false
    else if (stored === null) drifted = l > tol.abs // live value the warehouse never recorded
    else if (live === null) drifted = s > tol.abs // warehouse claims value Meta no longer reports
    else drifted = exceedsTolerance(l, s, tol)
    return { date, live, stored, delta: layer === 'bookings' ? Math.round((s - l) * 100) / 100 : roundMoney(s - l), drifted }
  })
  const driftedDays = days.filter((d) => d.drifted)
  const worst = driftedDays.length
    ? driftedDays.reduce((a, b) => (Math.abs(b.delta) > Math.abs(a.delta) ? b : a))
    : null
  return { layer, days, drifted_days: driftedDays.length, worst }
}

function windowDates(since: string, until: string): string[] {
  const out: string[] = []
  const d = new Date(since + 'T00:00:00Z')
  const end = new Date(until + 'T00:00:00Z')
  while (d <= end) {
    out.push(d.toISOString().slice(0, 10))
    d.setUTCDate(d.getUTCDate() + 1)
  }
  return out
}

/** IMPURE: run the guardrail for the trailing 7 COMPLETE days. Degrades to available:false on any fetch
 *  failure (a broken check must say so, not report "aligned"). When `raiseAlert` and drift is found,
 *  inserts ONE deduped warning alert naming the worst day/layer. */
export async function runDriftCheck(
  adAccountDbId: string,
  opts: { raiseAlert?: boolean; includeBookings?: boolean } = {},
): Promise<DriftReport> {
  const since = nyDaysAgo(7)
  const until = nyDaysAgo(1)
  const dates = windowDates(since, until)
  const empty: DriftReport = {
    available: false,
    reason: null,
    window: { since, until },
    layers: [],
    verdict: 'aligned',
    note: '',
  }

  const db = getAdminClient()
  const { data: acct } = await db.from('ad_accounts').select('account_id').eq('id', adAccountDbId).maybeSingle()
  const metaAccountId = (acct?.account_id as string | undefined) ?? null
  if (!metaAccountId) return { ...empty, reason: 'No ad account row / Meta account id.' }

  // LIVE truth: account-level per-day spend straight from Meta, right now.
  let liveByDay: Map<string, number>
  try {
    const rows = await getAdPlatform('meta').insights.fetchInsights({ accountId: metaAccountId, level: 'account', since, until })
    liveByDay = new Map(rows.map((r) => [r.date_start, Number(r.spend ?? 0)]))
  } catch (err) {
    return { ...empty, reason: `Live Meta fetch failed: ${err instanceof Error ? err.message : String(err)}` }
  }

  // LIVE bookings truth: Ads Manager's Results per campaign (account level carries no results field),
  // summed per day. This is the layer that catches booking-extraction corruption (the per-window double-count class) —
  // spend can match perfectly while bookings are silently wrong.
  let liveBookingsByDay: Map<string, number> | null = null
  if (opts.includeBookings === true) {
    try {
      const campRows = await getAdPlatform('meta').insights.fetchInsights({ accountId: metaAccountId, level: 'campaign', since, until })
      liveBookingsByDay = new Map()
      for (const r of campRows) {
        const day = r.date_start
        liveBookingsByDay.set(day, (liveBookingsByDay.get(day) ?? 0) + findAppointmentConfirmedResults(r.results))
      }
    } catch {
      liveBookingsByDay = null // degrade: spend layers still run; bookings layer reports unavailable via note
    }
  }

  // Stored layer 1: daily_insights account rows (what every engine reads).
  const { data: di } = await db
    .from('daily_insights')
    .select('date_start, spend, bookings')
    .eq('ad_account_id', adAccountDbId)
    .eq('entity_level', 'account')
    .gte('date_start', since)
    .lte('date_start', until)
  const insightsByDay = new Map((di ?? []).map((r) => [r.date_start as string, Number(r.spend ?? 0)]))
  const storedBookingsByDay = new Map((di ?? []).map((r) => [r.date_start as string, Number(r.bookings ?? 0)]))

  // Stored layer 2: daily_reports rollups (what the dashboard KPIs/trend read).
  const { data: dr } = await db
    .from('daily_reports')
    .select('report_date, total_spend')
    .eq('ad_account_id', adAccountDbId)
    .gte('report_date', since)
    .lte('report_date', until)
  const reportsByDay = new Map((dr ?? []).map((r) => [r.report_date as string, Number(r.total_spend ?? 0)]))

  const layers = [
    diffLayer('daily_insights', liveByDay, insightsByDay, dates),
    // daily_reports only exist for days a report ran — a missing report row is absence, not drift.
    // Restrict the comparison to days that HAVE a report row.
    diffLayer('daily_reports', liveByDay, reportsByDay, dates.filter((d) => reportsByDay.has(d))),
    // Bookings layer (the per-window double-count class): live campaign Results sum vs stored account
    // bookings, integer tolerance — a single-booking gap flags. Skipped if the live fetch failed.
    ...(liveBookingsByDay
      ? [diffLayer('bookings', liveBookingsByDay, storedBookingsByDay, dates, BOOKINGS_TOLERANCE)]
      : []),
  ]

  const drifted = layers.some((l) => l.drifted_days > 0)
  const worstLayer = layers.filter((l) => l.worst).sort((a, b) => Math.abs(b.worst!.delta) - Math.abs(a.worst!.delta))[0]
  const fmtVal = (layer: LayerDrift['layer'], n: number) => (layer === 'bookings' ? `${n} bookings` : `${formatMoney(n)}`)
  const note = drifted
    ? `Warehouse has drifted from live Meta: worst gap ${worstLayer.layer} ${worstLayer.worst!.date} (stored ${fmtVal(worstLayer.layer, worstLayer.worst!.stored ?? 0)} vs live ${fmtVal(worstLayer.layer, worstLayer.worst!.live ?? 0)}). The next sync's rolling restatement should heal spend; a persistent BOOKINGS gap means the extraction is wrong — do not trust CPA until it matches Ads Manager.`
    : `Warehouse matches live Meta per day across ${dates.length} complete days (spend within ${formatMoneyAmount(DRIFT_TOL_ABS)}/${DRIFT_TOL_PCT * 100}%${liveBookingsByDay ? ', bookings exact' : '; bookings layer unavailable'}).`

  const report: DriftReport = {
    available: true,
    reason: null,
    window: { since, until },
    layers,
    verdict: drifted ? 'drift' : 'aligned',
    note,
  }

  if (drifted && opts.raiseAlert) {
    await insertAlertsDeduped(db, [
      {
        ad_account_id: adAccountDbId,
        alert_date: until,
        entity_level: 'account',
        campaign_id: null,
        adset_id: null,
        ad_id: null,
        meta_campaign_id: null,
        meta_adset_id: null,
        meta_ad_id: null,
        alert_type: 'data_drift',
        severity: 'warning',
        title: 'Warehouse numbers drifted from live Meta',
        message: note,
        metric_name: worstLayer.layer === 'bookings' ? 'bookings' : 'spend',
        metric_value: worstLayer.worst!.stored,
        threshold_value: null,
        baseline_value: worstLayer.worst!.live,
        is_resolved: false,
      },
    ])
  }

  return report
}
