import { getAdminClient } from '@/lib/supabase/admin'
import { REC_THRESHOLDS } from '@/lib/recommendations/thresholds'
import { getTargetRange } from '@/lib/targets/target-ranges'
import { getGa4ConfirmationTelemetryByCampaign, getGa4Traffic, getGa4TrafficBySource, getGa4ConfirmationTelemetryBySource, type TrafficSource } from '@/lib/ga4/client'
import { getBusinessFactsForWindow } from '@/lib/outcomes/business-facts-reader'
import { computeTrust, type TrustScore } from '@/lib/trust/trust'
import { aggregateMetrics, INSIGHT_METRIC_COLUMNS } from '@/lib/metrics/aggregate'
import { priorPeriod, comparisonLabel, rangeLengthDays } from '@/lib/insights/compare'
import { type KpiSet } from '@/components/dashboard/KpiGrid'
import { nyDaysAgo } from '@/lib/utils/date-utils'
import { type ResolvedRange } from '@/lib/date-range'
import { detectOperatingMode } from '@/lib/modes/operating-mode'
import { anyActiveAdsetExitedLearning } from '@/lib/modes/learning-status'
import { readMediaBuyerRecommendationsEnabled } from '@/lib/economics/pragmatic-profit-evidence'
import {
  readOpenRecommendations,
  unavailableOpenRecommendationsRead,
  type OpenRecommendationsReadResult,
} from '@/lib/recommendations/store'
import { getLedgerForAccount, unresolvedConflicts, type LedgerRow } from '@/lib/recommendations/setup-ledger'
import { getDecisionsForAccount, decisionMapKey, entityKeyFor } from '@/lib/recommendations/decisions'
import { computeUtmCoverage, type UtmCoverageResult } from '@/lib/tracking/utm-coverage'
import { explainQuiet } from '@/lib/recommendations/quiet'
import { projectCurrentActionableTasks, projectDiagnosticAlert, projectFlagSurface } from '@/lib/authority/diagnostic-surface'
import { resolveOnlyActiveAccount } from '@/lib/accounts/active-account'
import {
  applyMetaSpendWindowHealth,
  dashboardReportOutcomesComplete,
  resolveDashboardMetaOutcomeReadHealth,
  resolveDashboardMetaReadHealth,
} from '@/lib/dashboard/read-health'
import { readAccountSpendWindow, type AccountSpendWindowSummary } from '@/lib/economics/ad-spend-reader'
import {
  accountInsightSpendPacing,
  accountInsightSpendTrend,
} from '@/lib/dashboard/insight-source-contract'
import { outcomeNoun } from '@/config/outcome-nouns'

// The Today page's server data-loader. Lives here (a co-located data module, not a component) to keep
// dashboard/page.tsx under the 500-line cap while staying inside Wave-1's file-ownership boundary.
// Pure fetch + shape; every render tier reads these fields by name.

export interface AlertRow {
  id: string
  severity: string
  title: string
  alert_type: string
  message: string
}

export interface TaskRow {
  id: string
  title: string
  priority: string
  status: string
  recommendation: string | null
}

export interface TrendRow {
  report_date: string
  total_spend: number | null
}

export interface CampaignRow {
  meta_campaign_id: string | null
  campaign_name: string | null
  status: string
  spend: number | null
  leads: number | null
  impressions: number | null
  clicks: number | null
  landing_page_views: number | null
}

export interface FlagRow {
  flag_type: string
  entity_level: string
  meta_ad_id: string | null
  meta_adset_id: string | null
  ad_name: string | null
  adset_name: string | null
  reason: string
  recommended_action: string | null
  cpa_in_window: number | null
  audience_type: string
}

export interface DashboardReportRow {
  report_date: string
  total_spend: number | null
  total_leads: number | null
  total_bookings: number | null
  business_outcomes: number | null
  business_revenue: number | null
  avg_cpl: number | null
  avg_cpb: number | null
}

function isCompleteOutcome(value: number | null): value is number {
  return value !== null && Number.isFinite(value) && value >= 0
}

export function aggregateDashboardReportKpis(rows: DashboardReportRow[]): KpiSet {
  const spend = rows.reduce((sum, row) => sum + Number(row.total_spend ?? 0), 0)
  const outcomesComplete = rows.length > 0 && rows.every((row) => (
    isCompleteOutcome(row.total_leads) && isCompleteOutcome(row.total_bookings)
  ))
  return aggregateDashboardReportKpisWithCompleteness(rows, outcomesComplete, spend)
}

function aggregateDashboardReportKpisWithCompleteness(
  rows: DashboardReportRow[],
  outcomesComplete: boolean,
  spend: number = rows.reduce((sum, row) => sum + Number(row.total_spend ?? 0), 0),
): KpiSet {
  const leads = outcomesComplete
    ? rows.reduce((sum, row) => sum + (row.total_leads as number), 0)
    : null
  const bookings = outcomesComplete
    ? rows.reduce((sum, row) => sum + (row.total_bookings as number), 0)
    : null
  return {
    spend,
    leads,
    bookings,
    realBookings: null,
    realRevenue: null,
    cpl: leads !== null && leads > 0 ? spend / leads : null,
    cpb: bookings !== null && bookings > 0 ? spend / bookings : null,
  }
}

function aggregateDashboardReportKpisForWindow(
  rows: DashboardReportRow[],
  window: { start: string; end: string },
): KpiSet {
  const spend = rows.reduce((sum, row) => sum + Number(row.total_spend ?? 0), 0)
  return aggregateDashboardReportKpisWithCompleteness(
    rows,
    dashboardReportOutcomesComplete(rows, window),
    spend,
  )
}

/** Await a record of promises in parallel, returning a record keyed the same way — so every result is
 *  read BY NAME. Replaces the old 12-element positional `Promise.all` destructure where a reordered query
 *  silently mismatched its variable. Parallelism is preserved (all promises are awaited together). */
async function awaitAll<T extends Record<string, PromiseLike<unknown>>>(obj: T): Promise<{ [K in keyof T]: Awaited<T[K]> }> {
  const keys = Object.keys(obj) as (keyof T)[]
  const values = await Promise.all(keys.map((k) => obj[k]))
  const out = {} as { [K in keyof T]: Awaited<T[K]> }
  keys.forEach((k, i) => { out[k] = values[i] as Awaited<T[typeof k]> })
  return out
}

export async function getDashboardData(range: ResolvedRange, source: TrafficSource) {
  const db = getAdminClient()
  const activeAccount = await resolveOnlyActiveAccount(db)
  const activeAccountId = activeAccount.ok ? activeAccount.account.id : null
  const yesterday = nyDaysAgo(1)
  const thirtyDaysAgo = nyDaysAgo(30)

  // Period-over-period: the prior window is the equal-length window immediately before the selected one.
  const prior = priorPeriod(range.from, range.to)
  const cmpLabel = comparisonLabel(range.from, range.to)

  // When account ownership is unresolved, every account-bearing query resolves to an explicit empty
  // result. No query is allowed to fall back to an unscoped, cross-account read.
  const noRows = Promise.resolve({ data: [] as never[], error: null })
  const noCount = Promise.resolve({ data: null, error: null, count: 0 })
  const noSingle = Promise.resolve({ data: null, error: null })

  // Daypart insights count (to decide whether to show heatmap)
  const daypartQuery = activeAccountId
    ? db.from('daypart_insights').select('id', { count: 'exact', head: true }).eq('ad_account_id', activeAccountId)
    : noCount

  const { headlineRowsRes, outcomeRows30Res, accountRowsRes, trendInsightRowsRes, insightRows30, alerts, tasks, flagsRaw, changeResult, daypartResult, lastSuccessResult, latestAttemptResult, outcomesReviewRes, activeAdsetBudgetRes, activeCampaignBudgetRes } = await awaitAll({
    // Headline KPIs — daily_reports across the selected window AND the prior window (one query, split below).
    headlineRowsRes: activeAccountId ? db.from('daily_reports').select('report_date, total_spend, total_leads, total_bookings, business_outcomes, business_revenue, avg_cpl, avg_cpb').eq('ad_account_id', activeAccountId).gte('report_date', prior.from).lte('report_date', range.to).order('report_date', { ascending: true }) : noRows,
    // 30-day modelled outcomes for operating-mode only. Daily report outcomes must prove every closed day.
    outcomeRows30Res: activeAccountId ? db.from('daily_reports').select('report_date, total_spend, total_leads, total_bookings, business_outcomes, business_revenue, avg_cpl, avg_cpb').eq('ad_account_id', activeAccountId).gte('report_date', thirtyDaysAgo).lte('report_date', yesterday).order('report_date', { ascending: true }) : noRows,
    // Account-level engagement/video insights across selected + prior windows (for deltas + sparklines).
    accountRowsRes: activeAccountId ? db.from('daily_insights').select(`date_start, ${INSIGHT_METRIC_COLUMNS}`).eq('ad_account_id', activeAccountId).eq('entity_level', 'account').gte('date_start', prior.from).lte('date_start', range.to).order('date_start', { ascending: true }) : noRows,
    // Trend/pacing: account daily_insights, not daily_reports snapshots, so stale report rows cannot move spend.
    trendInsightRowsRes: activeAccountId ? db.from('daily_insights').select('date_start, spend').eq('ad_account_id', activeAccountId).eq('entity_level', 'account').gte('date_start', thirtyDaysAgo).lte('date_start', yesterday).order('date_start', { ascending: true }) : noRows,
    // Campaign insights: 30 days so we show data even when paused
    insightRows30: activeAccountId ? db.from('daily_insights')
      .select('meta_campaign_id, spend, leads, impressions, clicks, landing_page_views')
      .eq('ad_account_id', activeAccountId)
      .eq('entity_level', 'campaign')
      .gte('date_start', range.from)
      .lte('date_start', range.to)
      .order('spend', { ascending: false })
      .limit(200) : noRows,
    alerts: activeAccountId ? db.from('alerts').select('id, severity, title, alert_type, message').eq('ad_account_id', activeAccountId).eq('is_resolved', false).order('detected_at', { ascending: false }).limit(10) : noRows,
    tasks: activeAccountId ? db.from('audit_tasks').select('id, title, priority, status, recommendation, action_decision:action_decisions(authority_tier, policy_version, authority_reason, owner_copy)').eq('ad_account_id', activeAccountId).in('status', ['open', 'in_progress']).order('created_at', { ascending: false }).limit(500) : noRows,
    flagsRaw: activeAccountId ? db.from('flags').select('flag_type, entity_level, meta_ad_id, meta_adset_id, reason, recommended_action, watch_next, cpa_in_window, audience_type').eq('ad_account_id', activeAccountId).eq('is_active', true).in('flag_type', ['winner', 'loser', 'scale_candidate']).order('flag_date', { ascending: false }).limit(6) : noRows,
    // Pending budget/status CHANGE requests (the /changes queue) — surfaced on the verdict too.
    changeResult: activeAccountId ? db.from('change_requests').select('id', { count: 'exact', head: true }).eq('ad_account_id', activeAccountId).eq('status', 'pending') : noCount,
    daypartResult: daypartQuery,
    // Freshness gate: most recent successful sync, and the latest attempt (any status).
    lastSuccessResult: activeAccountId ? db.from('api_sync_logs').select('completed_at').eq('ad_account_id', activeAccountId).eq('status', 'success').order('completed_at', { ascending: false }).limit(1).maybeSingle() : noSingle,
    latestAttemptResult: activeAccountId ? db.from('api_sync_logs').select('status, error_message').eq('ad_account_id', activeAccountId).order('created_at', { ascending: false }).limit(1).maybeSingle() : noSingle,
    // Outcomes awaiting the owner's learning-review (decisive, non-estimate, still-pending — mirrors
    // intelligence-summary.needsReview). Strictly scoped to the resolved active account.
    outcomesReviewRes: activeAccountId ? db.from('recommendation_outcomes').select('outcome, review_status, estimate_only').eq('ad_account_id', activeAccountId).not('outcome', 'is', null).limit(50) : noRows,
    // Real daily budget target for pacing — Σ active ad-set budgets (ABO), else Σ active campaign budgets
    // (CBO). Replaces a hardcoded daily plan so pacing follows the actual synced budget.
    activeAdsetBudgetRes: activeAccountId ? db.from('adsets').select('daily_budget').eq('ad_account_id', activeAccountId).eq('effective_status', 'ACTIVE') : noRows,
    activeCampaignBudgetRes: activeAccountId ? db.from('campaigns').select('daily_budget').eq('ad_account_id', activeAccountId).eq('effective_status', 'ACTIVE') : noRows,
  })
  const headlineRows = (headlineRowsRes.data ?? []) as DashboardReportRow[]
  const outcomeRows30 = (outcomeRows30Res.data ?? []) as DashboardReportRow[]
  const curReports = headlineRows.filter((row) => row.report_date >= range.from && row.report_date <= range.to)
  const prevReports = headlineRows.filter((row) => row.report_date >= prior.from && row.report_date <= prior.to)
  const accountRows = (accountRowsRes.data ?? []) as Array<Record<string, unknown>>
  const dateOf = (r: Record<string, unknown>) => r.date_start as string
  const curAccount = accountRows.filter((r) => dateOf(r) >= range.from && dateOf(r) <= range.to)
  const prevAccount = accountRows.filter((r) => dateOf(r) >= prior.from && dateOf(r) <= prior.to)
  const accountMetrics = aggregateMetrics(curAccount)
  const accountMetricsPrev = aggregateMetrics(prevAccount)
  const accountDayKeys = [...new Set(curAccount.map(dateOf))].sort()
  const accountDaily = accountDayKeys.map((d) => aggregateMetrics(curAccount.filter((r) => dateOf(r) === d)))

  const unavailableSpendWindow = (reason: string): AccountSpendWindowSummary => ({
    status: 'unavailable', totalSpend: null, dayCount: null, blockerCodes: [reason],
  })
  const spendAsOf = new Date().toISOString()
  const readSpendWindow = async (window: { start: string; end: string }) => {
    if (!activeAccountId) return unavailableSpendWindow('active_account_unresolved')
    try {
      return await readAccountSpendWindow(db, activeAccountId, window, spendAsOf)
    } catch {
      return unavailableSpendWindow('meta_spend_window_read_failed')
    }
  }
  const [rangeSpendWindow, priorSpendWindow, trendSpendWindow] = await Promise.all([
    readSpendWindow({ start: range.from, end: range.to }),
    readSpendWindow({ start: prior.from, end: prior.to }),
    readSpendWindow({ start: thirtyDaysAgo, end: yesterday }),
  ])

  // Row cardinality does not decide read health. A successful empty result is valid zero-data; a
  // Supabase error or unresolved/ambiguous account is unavailable and must never aggregate to zero.
  const dailyReportsRead = resolveDashboardMetaReadHealth(activeAccount, 'daily_reports', headlineRowsRes.error)
  const dailyReports30Read = resolveDashboardMetaReadHealth(activeAccount, 'daily_reports', outcomeRows30Res.error)
  const metaDeliveryRead = applyMetaSpendWindowHealth(
    resolveDashboardMetaReadHealth(activeAccount, 'daily_insights', accountRowsRes.error),
    rangeSpendWindow,
  )
  const metaReadHealth = {
    dailyReports: metaDeliveryRead,
    dailyReportOutcomes: resolveDashboardMetaOutcomeReadHealth(
      dailyReportsRead,
      curReports,
      { start: range.from, end: range.to },
    ),
    trendReports: applyMetaSpendWindowHealth(
      resolveDashboardMetaReadHealth(activeAccount, 'daily_insights', trendInsightRowsRes.error),
      trendSpendWindow,
    ),
    accountInsights: metaDeliveryRead,
    campaignInsights: applyMetaSpendWindowHealth(
      resolveDashboardMetaReadHealth(activeAccount, 'daily_insights', insightRows30.error),
      rangeSpendWindow,
    ),
  }

  const sumBudget = (res: { data: { daily_budget: number | null }[] | null }) =>
    (res.data ?? []).reduce((s, r) => s + Number(r.daily_budget ?? 0), 0)
  const adsetBudget = sumBudget(activeAdsetBudgetRes)
  const campaignBudget = sumBudget(activeCampaignBudgetRes)
  const dailyBudgetTarget = adsetBudget > 0 ? adsetBudget : campaignBudget > 0 ? campaignBudget : null

  // ── Headline KPIs — period-over-period from daily_reports (selected window vs the prior window) ──
  // Never aggregate the legacy-named source columns here: rows span incompatible money contracts.
  // The live, freshness-gated ledger read below supplies both business fields.
  const headline = {
    current: aggregateDashboardReportKpisForWindow(curReports, { start: range.from, end: range.to }),
    previous: aggregateDashboardReportKpisForWindow(prevReports, { start: prior.from, end: prior.to }),
    series: {
      spend: accountInsightSpendTrend(curAccount).map((row) => row.total_spend),
      leads: metaReadHealth.dailyReportOutcomes.status === 'available'
        ? curReports.map((row) => row.total_leads as number)
        : [],
      cpl: metaReadHealth.dailyReportOutcomes.status === 'available'
        ? curReports.map((row) => {
            const spend = Number(row.total_spend ?? 0)
            const leads = row.total_leads as number
            return leads > 0 ? spend / leads : 0
          })
        : [],
    },
  }
  headline.current.spend = rangeSpendWindow.status === 'available'
    ? Number(rangeSpendWindow.totalSpend)
    : null
  headline.previous.spend = priorSpendWindow.status === 'available'
    ? Number(priorSpendWindow.totalSpend)
    : null
  headline.current.cpl = headline.current.spend !== null && headline.current.leads !== null && headline.current.leads > 0
    ? headline.current.spend / headline.current.leads
    : null
  headline.current.cpb = headline.current.spend !== null && headline.current.bookings !== null && headline.current.bookings > 0
    ? headline.current.spend / headline.current.bookings
    : null
  headline.previous.cpl = headline.previous.spend !== null && headline.previous.leads !== null && headline.previous.leads > 0
    ? headline.previous.spend / headline.previous.leads
    : null
  headline.previous.cpb = headline.previous.spend !== null && headline.previous.bookings !== null && headline.previous.bookings > 0
    ? headline.previous.spend / headline.previous.bookings
    : null

  // ── Account engagement + video — period-over-period via the shared aggregator (uses the populated
  // 001 video columns, so account-level hook/hold/retention are correct, not the null 008 columns). ──

  // Aggregate campaign insights over 30 days
  const insightMap = new Map<string, CampaignRow>()
  for (const row of insightRows30.data ?? []) {
    const id = row.meta_campaign_id as string | null
    if (!id) continue
    if (!insightMap.has(id)) {
      insightMap.set(id, { meta_campaign_id: id, campaign_name: null, status: 'ACTIVE', spend: 0, leads: 0, impressions: 0, clicks: 0, landing_page_views: 0 })
    }
    const agg = insightMap.get(id)!
    agg.spend = (agg.spend ?? 0) + Number(row.spend ?? 0)
    agg.leads = (agg.leads ?? 0) + Number(row.leads ?? 0)
    agg.impressions = (agg.impressions ?? 0) + Number(row.impressions ?? 0)
    agg.clicks = (agg.clicks ?? 0) + Number(row.clicks ?? 0)
    agg.landing_page_views = (agg.landing_page_views ?? 0) + Number(row.landing_page_views ?? 0)
  }

  // Join campaign names
  const campaignIds = [...insightMap.keys()].slice(0, 20)
  if (activeAccountId && campaignIds.length > 0) {
    const { data: campaigns } = await db.from('campaigns').select('campaign_id, campaign_name, status').eq('ad_account_id', activeAccountId).in('campaign_id', campaignIds)
    for (const c of campaigns ?? []) {
      const row = insightMap.get(c.campaign_id as string)
      if (row) { row.campaign_name = c.campaign_name as string | null; row.status = c.status as string }
    }
  }

  const topCampaigns = [...insightMap.values()].sort((a, b) => (b.spend ?? 0) - (a.spend ?? 0)).slice(0, 5)

  // Resolve entity names for flags (adsets and ads)
  const rawFlags = flagsRaw.data ?? []
  const metaAdsetIds = [...new Set(rawFlags.map((f) => f.meta_adset_id).filter(Boolean))] as string[]
  const metaAdIds = [...new Set(rawFlags.map((f) => f.meta_ad_id).filter(Boolean))] as string[]

  const adsetNameMap = new Map<string, string>()
  const adNameMap = new Map<string, string>()

  if (activeAccountId && metaAdsetIds.length > 0) {
    const { data: adsets } = await db.from('adsets').select('adset_id, adset_name').eq('ad_account_id', activeAccountId).in('adset_id', metaAdsetIds)
    for (const a of adsets ?? []) adsetNameMap.set(a.adset_id as string, a.adset_name as string ?? a.adset_id as string)
  }
  if (activeAccountId && metaAdIds.length > 0) {
    const { data: ads } = await db.from('ads').select('ad_id, ad_name').eq('ad_account_id', activeAccountId).in('ad_id', metaAdIds)
    for (const a of ads ?? []) adNameMap.set(a.ad_id as string, a.ad_name as string ?? a.ad_id as string)
  }

  const flags: FlagRow[] = rawFlags.map((source) => {
    const f = projectFlagSurface(source as Record<string, unknown>)
    return {
      flag_type: f.flag_type as string,
      entity_level: f.entity_level as string,
      meta_ad_id: f.meta_ad_id as string | null,
      meta_adset_id: f.meta_adset_id as string | null,
      ad_name: f.meta_ad_id ? (adNameMap.get(f.meta_ad_id as string) ?? null) : null,
      adset_name: f.meta_adset_id ? (adsetNameMap.get(f.meta_adset_id as string) ?? null) : null,
      reason: f.reason as string,
      recommended_action: f.recommended_action as string | null,
      cpa_in_window: f.cpa_in_window as number | null,
      audience_type: f.audience_type as string,
    }
  })

  // Top Campaigns + lead funnel now follow the SELECTED range (insightRows30 is range-driven), so the
  // label reflects the picker — `range.days` is the inclusive day count of the chosen window.
  const allPaused = topCampaigns.every((c) => c.status === 'PAUSED' || c.status === 'ARCHIVED')
  const dataWindow = allPaused ? `${range.days}d (campaigns paused)` : `${range.days}d`

  // Pacing: last 7 days of spend data
  const sevenDaysAgoStr = nyDaysAgo(7)
  const insightPacing = accountInsightSpendPacing(
    (trendInsightRowsRes.data ?? []) as Array<Record<string, unknown>>,
    sevenDaysAgoStr,
  )
  const last7Spend = insightPacing.recentSpend
  const last7Days = insightPacing.daysOfData

  const metaSpend30 = trendSpendWindow.status === 'available'
    ? Number(trendSpendWindow.totalSpend)
    : null

  // Spend for the selected range. Paid money is computed elsewhere only when the exact join and
  // authoritative spend mapping are complete.
  const rangeSpend = headline.current.spend
  const priorSpend = headline.previous.spend

  // GA4 confirmation telemetry split by named campaign. This is not ad money: the events lack
  // appointment identity and ledger lifecycle validation.
  const UNATTRIBUTED = new Set(['(not set)', '(direct)', '(referral)', '(organic)', '(none)', '(unknown)', ''])
  let ga4 = {
    available: false as boolean,
    adBookings: 0, adRevenue: 0, adRoas: null as number | null,
    totalBookings: 0, totalRevenue: 0, mer: null as number | null,
    attributedShare: null as number | null,
  }
  try {
    const gc = await getGa4ConfirmationTelemetryByCampaign(range.from, range.to)
    if (gc.available) {
      const attributed = gc.rows.filter((r) => !UNATTRIBUTED.has((r.campaign ?? '').toLowerCase()))
      // TELEMETRY. These are GA confirmation events and GA event value, not bookings and not
      // revenue. adRoas and mer would divide GA event value by spend — a money claim built on
      // telemetry — so they are null until an exact appointment-id join exists. Unavailable, not zero.
      const adBookings = attributed.reduce((s, r) => s + r.confirmationEvents, 0)
      const adRevenue = attributed.reduce((s, r) => s + r.eventValue, 0)
      ga4 = {
        available: true,
        adBookings,
        adRevenue,
        adRoas: null,
        totalBookings: gc.totals.confirmationEvents,
        totalRevenue: gc.totals.eventValue,
        mer: null,
        attributedShare: gc.attributedShare,
      }
    }
  } catch {
    // GA4 unavailable — dashboard still renders Meta data.
  }

  // Prior-window GA confirmation events / event value — for the period-over-period telemetry deltas.
  let ga4Prev = { adBookings: 0, adRevenue: 0, adRoas: null as number | null, totalBookings: 0, totalRevenue: 0, mer: null as number | null }
  try {
    const gcp = await getGa4ConfirmationTelemetryByCampaign(prior.from, prior.to)
    if (gcp.available) {
      const attributed = gcp.rows.filter((r) => !UNATTRIBUTED.has((r.campaign ?? '').toLowerCase()))
      const adBookings = attributed.reduce((s, r) => s + r.confirmationEvents, 0)
      const adRevenue = attributed.reduce((s, r) => s + r.eventValue, 0)
      ga4Prev = {
        adBookings, adRevenue,
        adRoas: null,
        totalBookings: gcp.totals.confirmationEvents, totalRevenue: gcp.totals.eventValue,
        mer: null,
      }
    }
  } catch { /* prior GA4 unavailable — deltas just won't render */ }

  // ── outcome ledger — the CANONICAL business total (bookings/revenue/MER). Read LIVE from the ledger,
  // NOT the daily_reports rollup (which can lag source-ledger state). Wrapped in an availability
  // result (CL-B): on any error the dashboard renders an explicit "Outcome ledger unavailable" state — it
  // never crashes and never silently falls back to GA4 as the business truth. MER = revenue ÷ ad spend. ──
  // Account scope is REQUIRED: the ledger table is account-agnostic, so an unfiltered read mixes them.
  const ledgerAcctId = activeAccountId

  // Named for what they count. `valueBearingBookings` are active and charged; zero-value
  // appointments are real appointments carried separately, never folded in and never called tests.
  type LedgerCard = {
    available: boolean; valueBearingBookings: number; zeroValueAppointments: number
    bookedValue: number; recordedRevenue: number | null; recordedAmountPaidLowerBound: number
    amountPaidCoverage: { withRecordedAmount: number; total: number } | null
    mer: number | null
  }
  const emptyCard = (): LedgerCard => ({
    available: false, valueBearingBookings: 0, zeroValueAppointments: 0,
    bookedValue: 0, recordedRevenue: null, recordedAmountPaidLowerBound: 0,
    amountPaidCoverage: null, mer: null,
  })
  let outcomes: LedgerCard = emptyCard()
  try {
    if (!ledgerAcctId) throw new Error('no ad account resolved')
    const cur = await getBusinessFactsForWindow(ledgerAcctId, range.from, range.to, db)
    outcomes = {
      available: true, valueBearingBookings: cur.valueBearingBookings,
      zeroValueAppointments: cur.zeroValueAppointments, bookedValue: cur.bookedValue,
      recordedRevenue: cur.recordedOutcomeValue,
      recordedAmountPaidLowerBound: cur.observedCollectedValue,
      amountPaidCoverage: cur.amountPaidCoverage,
      // BLENDED across all sources (paid + organic + phone + manual) — never a paid ROAS.
      mer: cur.recordedOutcomeValue !== null && rangeSpend !== null && rangeSpend > 0
        ? cur.recordedOutcomeValue / rangeSpend : null,
    }
  } catch { /* outcome ledger unavailable — explicit unavailable state (CL-B); never fall back to GA4 */ }

  let outcomePrev: LedgerCard = emptyCard()
  try {
    if (!ledgerAcctId) throw new Error('no ad account resolved')
    const prev = await getBusinessFactsForWindow(ledgerAcctId, prior.from, prior.to, db)
    outcomePrev = {
      available: true, valueBearingBookings: prev.valueBearingBookings,
      zeroValueAppointments: prev.zeroValueAppointments, bookedValue: prev.bookedValue,
      recordedRevenue: prev.recordedOutcomeValue,
      recordedAmountPaidLowerBound: prev.observedCollectedValue,
      amountPaidCoverage: prev.amountPaidCoverage,
      mer: prev.recordedOutcomeValue !== null && priorSpend !== null && priorSpend > 0
        ? prev.recordedOutcomeValue / priorSpend : null,
    }
  } catch { /* prior outcome-source window unavailable — deltas just won't render */ }

  let businessBookings30dForMode: number | null = null
  try {
    if (!ledgerAcctId) throw new Error('no ad account resolved')
    const thirty = await getBusinessFactsForWindow(ledgerAcctId, thirtyDaysAgo, yesterday, db)
    businessBookings30dForMode = thirty.valueBearingBookings
  } catch { businessBookings30dForMode = null }

  const metaOutcomes30dHealth = resolveDashboardMetaOutcomeReadHealth(
    dailyReports30Read,
    outcomeRows30,
    { start: thirtyDaysAgo, end: yesterday },
  )
  const metaModelledBookings30dForMode = metaOutcomes30dHealth.status === 'available'
    ? aggregateDashboardReportKpisForWindow(outcomeRows30, { start: thirtyDaysAgo, end: yesterday }).bookings
    : null

  // KpiGrid's "Real Bookings/Revenue" cards read headline.current.realBookings/realRevenue. Drive them
  // from the LIVE outcome ledger's AVAILABILITY: on a failed read, NULL the fields so KpiGrid shows its
  // pre-ledger/empty state — never the stale daily_reports rollup relabeled as live "Outcomes · all sources"
  // (which would also contradict the explicit "Outcome ledger unavailable" state shown elsewhere). Each
  // window is independent: a failed prior read nulls only the baseline, so the delta simply won't render.
  // realBookings = VALUE-BEARING bookings; realRevenue = recorded collected value checkout revenue.
  // Scheduled booked value remains separate. Zero-value appointments are
  // real appointments carried separately (outcomes.zeroValueAppointments) and never folded into either.
  headline.current.realBookings = outcomes.available ? outcomes.valueBearingBookings : null
  headline.current.realRevenue = outcomes.available ? outcomes.recordedRevenue : null
  headline.previous.realBookings = outcomePrev.available ? outcomePrev.valueBearingBookings : null
  headline.previous.realRevenue = outcomePrev.available ? outcomePrev.recordedRevenue : null

  // GA4 TRAFFIC (page views / sessions / users / engagement) — current + prior window for deltas.
  let ga4Traffic: Awaited<ReturnType<typeof getGa4Traffic>> | null = null
  let ga4TrafficPrev: Awaited<ReturnType<typeof getGa4Traffic>> | null = null
  try { ga4Traffic = await getGa4Traffic(range.from, range.to) } catch { ga4Traffic = null }
  try { ga4TrafficPrev = await getGa4Traffic(prior.from, prior.to) } catch { ga4TrafficPrev = null }

  // SESSION-CHANNEL TELEMETRY — paid vs non-paid via GA default channel groups. Classification can
  // diagnose acquisition tagging; it does not prove an ad caused a business outcome.
  // Only fetched when a non-Complete view is selected (keeps the default view as fast as before).
  let trafficBySource: Awaited<ReturnType<typeof getGa4TrafficBySource>> | null = null
  let trafficBySourcePrev: Awaited<ReturnType<typeof getGa4TrafficBySource>> | null = null
  let revenueBySource: Awaited<ReturnType<typeof getGa4ConfirmationTelemetryBySource>> | null = null
  let revenueBySourcePrev: Awaited<ReturnType<typeof getGa4ConfirmationTelemetryBySource>> | null = null
  if (source !== 'complete') {
    try { trafficBySource = await getGa4TrafficBySource(range.from, range.to) } catch { trafficBySource = null }
    try { trafficBySourcePrev = await getGa4TrafficBySource(prior.from, prior.to) } catch { trafficBySourcePrev = null }
    try { revenueBySource = await getGa4ConfirmationTelemetryBySource(range.from, range.to) } catch { revenueBySource = null }
    try { revenueBySourcePrev = await getGa4ConfirmationTelemetryBySource(prior.from, prior.to) } catch { revenueBySourcePrev = null }
  }

  // Freshness gate: warn if the last successful sync is stale or the latest attempt failed.
  const lastSuccessAt = (lastSuccessResult.data?.completed_at as string | null) ?? null
  const hoursSinceSync = lastSuccessAt ? (Date.now() - new Date(lastSuccessAt).getTime()) / 3_600_000 : null
  const latestAttempt = latestAttemptResult.data as { status?: string; error_message?: string | null } | null
  const freshness = {
    lastSuccessAt,
    hoursSinceSync,
    stale: hoursSinceSync === null || hoursSinceSync > REC_THRESHOLDS.MAX_DATA_AGE_HOURS,
    latestFailed: latestAttempt?.status === 'failed',
    latestError: latestAttempt?.error_message ?? null,
  }

  // ── Operating mode ──
  // Derived from existing signals — no extra GA4 round trip. attributed_share is left unknown here
  // (the dedicated per-campaign panel computes it), so per-campaign ROAS claims stay gated off.
  const activeAdsDelivering = allPaused ? 0 : topCampaigns.filter((c) => c.status === 'ACTIVE' && (c.spend ?? 0) > 0).length
  const mediaBuyerRecommendationsEnabled = activeAccountId
    ? await readMediaBuyerRecommendationsEnabled(db, activeAccountId)
    : false
  const mode = detectOperatingMode({
    spend30d: metaSpend30,
    // The data-mode signal must never be GA confirmation events — those carry no appointment
    // identity, so duplicates and ledger-excluded appointments could promote the account into a mode that
    // unlocks performance and budget recommendations. LEDGER value-bearing bookings drive it.
    businessBookings30d: businessBookings30dForMode,
    // The dashboard does not compute the exact join (it would be an extra GA round trip per render),
    // so paid outcomes are NOT PROVEN here. Null keeps budget/per-campaign authority closed, which is
    // the correct default: the MCP tool and the weekly report do compute it.
    exactPaidBookings30d: null,
    metaModelledBookings30d: metaModelledBookings30dForMode,
    // This render does not compute the exact join, the campaign mapping, or the spend basis, so all
    // three are NULL — which keeps budget and per-campaign authority closed. The MCP tool computes them.
    campaignMappingComplete: null,
    campaignSpendComplete: null,
    authoritativeSpendBasis: null,
    // No lagged decision window is computed here, so CUT authority stays closed. That is the honest
    // state for a surface that does not build matured evidence — the MCP tool does.
    laggedPeriod: null,
    // Display surfaces never carry cut authority, so neither decision window is supplied here.
    postPeriod: null,
    // This dashboard view does not read a pinned cohort pair and never grants money authority.
    interactionCohorts: null,
    structuralContinuity: null,
    // EFFECTIVE targets, read at evaluation time so a Performance-Targets override actually applies.
    targetCpa: getTargetRange('cpa').healthy,
    maxCpa: getTargetRange('cpa').watch,
    // Dashboard rendering does not load durable target-policy approval provenance.
    targetPolicyStatus: 'not_evaluated',
    // FAIL CLOSED: this render does not resolve the campaign objective, so booking-CPA rules must not apply here. 'bookings' would have
    // silently authorised them. The MCP tool resolves the real objective from synced campaign rows.
    objective: 'unknown',
    attributedShare: ga4.available ? ga4.attributedShare : null,
    daysSinceLastDelivery: activeAdsDelivering === 0 ? 30 : 0,
    activeAdsDelivering,
    anyAdsetExitedLearning: activeAccountId ? await anyActiveAdsetExitedLearning(activeAccountId) : false, // real Meta learning_stage (SUCCESS ⇒ exited); false on unknown
    writeModeEnabled: process.env.WRITE_MODE_ENABLED === 'true',
    mediaBuyerRecommendationsEnabled,
  })

  // Active account (resolved once) + its account-scoped reads: standing recommendations, the setup
  // ledger, and recorded decisions. All degrade gracefully to empty when their migrations aren't applied.
  const acctId = activeAccountId

  let recommendationRead: OpenRecommendationsReadResult = unavailableOpenRecommendationsRead(
    'account_unresolved',
    'The ad account could not be resolved, so the current recommendation feed is unavailable.',
  )
  let openRecs = recommendationRead.recommendations
  let ledgerRows: LedgerRow[] = []
  let openRecsAwaitingDecision = 0
  if (acctId) {
    const scoped = await awaitAll({
      recommendationRead: readOpenRecommendations(acctId, 10),
      ledger: getLedgerForAccount(acctId),
      decisions: getDecisionsForAccount(acctId),
    })
    recommendationRead = scoped.recommendationRead
    openRecs = recommendationRead.recommendations
    ledgerRows = scoped.ledger
    // "Awaiting a decision" = open recs with no recorded decision for their (entity, type).
    openRecsAwaitingDecision = openRecs.filter(
      (rec) => !scoped.decisions.has(decisionMapKey(entityKeyFor(rec.target_entity_id), rec.recommendation_type))
    ).length
  }
  const ledgerConflicts = unresolvedConflicts(ledgerRows).length
  const decisionsRecorded = ledgerRows.length

  // UTM coverage (server-only audit of what synced; no new GA4 call). Null on any failure → honest 'unknown'.
  let utmCoverage: UtmCoverageResult | null = null
  try { utmCoverage = acctId ? await computeUtmCoverage(acctId) : null } catch { utmCoverage = null }

  // Top recommended next checks — mode-aware, kept short so the dashboard stays usable.
  const nextChecks: string[] = []
  if (freshness.stale || freshness.latestFailed) nextChecks.push('Re-run the sync — data is stale or the last attempt failed.')
  if (mode.dataMode === 'pre_launch') {
    nextChecks.push('Register current business/page context and approve a versioned CampaignPlan before launch; objective, optimization event, audience, destination, CTA, budget, and attribution remain blocked until then.')
    nextChecks.push('Validate the approved CampaignPlan measurement contract end to end before spending: selected-event delivery and deduplication, outcome identity, immutable Meta IDs, and readable campaign telemetry.')
    nextChecks.push('Treat the current Meta setup as observed configuration only; it does not prove objective, event, destination, audience, or offer fit.')
  } else {
    if (!ga4.available) nextChecks.push('Restore GA4 confirmation-event telemetry; outcome business totals remain authoritative and unaffected.')
    nextChecks.push(`Require complete exact ${outcomeNoun({ plural: false })} identity, campaign mapping, and authoritative spend before trusting per-campaign ROAS.`)
    nextChecks.push('Review active flags and the learnings page before any budget change.')
  }

  // Trust in the displayed PAID figure. The channel split is complete (GA4 classifies every session),
  // but the underlying quantity is a CONFIRMATION-EVENT count with no appointment identity, so the
  // source is telemetry rather than a business fact — reflected in the label below.
  const paidRev = revenueBySource?.paid
  const paidRevenueTrust: TrustScore | null = paidRev
    ? computeTrust({
        spend: rangeSpend ?? undefined,
        bookings: paidRev.confirmationEvents,
        windowDays: rangeLengthDays(range.from, range.to),
        dataAgeHours: freshness.hoursSinceSync,
        sourceOfTruth: 'ga4_confirmation_telemetry',
        revenueClaim: true,
        attributionCoverage: 1,
        dataSourcesCount: 2,
      })
    : null

  // Complete-view trust in the business-total reading — now the outcome ledger (canonical), the same
  // source the Complete-view cards display. Attribution coverage is N/A for a directly-measured total
  // (the trust model treats outcome_actual that way). Feeds the TrustStrip ROAS-trust card in the
  // Complete view; the Paid view uses paidRevenueTrust.
  const completeViewTrust: TrustScore | null = outcomes.available
    ? computeTrust({
        spend: rangeSpend ?? undefined,
        bookings: outcomes.valueBearingBookings,
        windowDays: rangeLengthDays(range.from, range.to),
        dataAgeHours: freshness.hoursSinceSync,
        sourceOfTruth: 'outcome_business_total',
        revenueClaim: true,
        dataSourcesCount: 2,
      })
    : null

  // Outcomes awaiting the owner's learning-review + approved learnings (from the account-agnostic fetch).
  // Mirrors intelligence-summary.needsReview exactly: decisive, non-estimate, still-pending.
  const outcomeRows = (outcomesReviewRes.data ?? []) as { outcome: string | null; review_status: string | null; estimate_only: boolean | null }[]
  const outcomesAwaitingReview = outcomeRows.filter(
    (o) => (o.review_status ?? 'pending') === 'pending' && !o.estimate_only && (o.outcome === 'worked' || o.outcome === 'failed')
  ).length
  const approvedLearnings = outcomeRows.filter((o) => o.review_status === 'approved').length

  // "Why Maxx is quiet" — the honest empty-state explanation for the recommendations block.
  const quiet = explainQuiet({
    dataMode: mode.dataMode,
    spend30d: metaSpend30 ?? undefined,
    stale: freshness.stale,
    attributionCoverage: ga4.available ? ga4.attributedShare : null,
    openCount: openRecs.length,
  })

  // Legacy/stale/diagnostic task rows remain database history; they do not populate the live inbox,
  // dashboard preview or counts. Only current-policy owner-review/execution tasks are current work.
  const currentActionableTasks = projectCurrentActionableTasks(
    (tasks.data ?? []) as Array<Record<string, unknown>>,
  )
  const currentUrgentTasks = currentActionableTasks.filter(
    (task) => task.priority === 'urgent' || task.priority === 'high',
  )

  return {
    activeAccountId,
    source,
    trafficBySource,
    trafficBySourcePrev,
    revenueBySource,
    revenueBySourcePrev,
    paidRevenueTrust,
    completeViewTrust,
    utmCoverage,
    quiet,
    freshness,
    mode,
    metaReadHealth,
    recommendationRead,
    openRecs,
    openRecsAwaitingDecision,
    ledgerConflicts,
    decisionsRecorded,
    outcomesAwaitingReview,
    approvedLearnings,
    nextChecks,
    headline,
    cmpLabel,
    trend: accountInsightSpendTrend(curAccount) as TrendRow[], // range-driven account-insight spend chart
    topCampaigns,
    alerts: (alerts.data ?? []).map((row) => projectDiagnosticAlert(row as Record<string, unknown>)) as unknown as AlertRow[],
    tasks: currentActionableTasks.slice(0, 3) as unknown as TaskRow[],
    flags,
    allPaused,
    dataWindow,
    pacing: { recentSpend: last7Spend, daysOfData: last7Days, dailyBudgetTarget },
    pendingChanges: changeResult.count ?? 0,
    openTasksCount: currentActionableTasks.length,
    openTasksUrgent: currentUrgentTasks.length,
    daypartCount: daypartResult.count ?? 0,
    ga4,
    ga4Prev,
    outcomes,
    outcomePrev,
    accountMetrics,
    accountMetricsPrev,
    accountDaily,
    ga4Traffic,
    ga4TrafficPrev,
  }
}
