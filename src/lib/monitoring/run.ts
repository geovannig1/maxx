import 'server-only'
import { getAdminClient } from '@/lib/supabase/admin'
import { isAiEnabled } from '@/lib/ai'
import { getGa4ConfirmationTelemetryBySource } from '@/lib/ga4/client'
import { resolveAdAccountId } from '@/lib/outcomes/ledger-account'
import { readConversionBacklog } from './conversion-backlog'
import { getConfirmationFacts } from '@/lib/outcomes/confirmation-facts'
import { computeUtmCoverage } from '@/lib/tracking/utm-coverage'
import { nyDaysAgo } from '@/lib/utils/date-utils'
import { emitAlert } from './alerts'
import {
  detectStaleData,
  detectMetaGa4Mismatch,
  detectGaTagHealth,
  detectMetaDeliveryHealth,
  detectBookingRevenueMismatch,
  detectDuplicateData,
  detectReportFailure,
  detectReportNarrativeFailure,
  detectUtmCoverage,
  detectCapiDeliveryBacklog,
  detectWriteModeTripwire,
  type MonitoringFinding,
} from './detectors'

// Monitoring runner. Gathers cheap signals and emits alerts via the detectors.
// Wired as a non-fatal cron step. Every block is isolated so one failing check never aborts the rest.

export interface MonitoringRunResult {
  checks: number
  alerts: number
  findings: Array<{ area: string; severity: string; message: string }>
}

export async function runMonitoringChecks(
  adAccountDbId: string,
  options: { metaOutcomeMetricsComplete?: boolean } = {},
): Promise<MonitoringRunResult> {
  const db = getAdminClient()
  const findings: MonitoringFinding[] = []

  // Write-mode tripwire — always check, even before any data query.
  push(findings, detectWriteModeTripwire(process.env.WRITE_MODE_ENABLED === 'true'))

  // Stale data — last successful sync age.
  try {
    const { data } = await db
      .from('api_sync_logs')
      .select('completed_at')
      .eq('status', 'success')
      .order('completed_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    const lastSuccessAt = (data?.completed_at as string | null) ?? null
    const hoursSinceSync = lastSuccessAt ? (Date.now() - new Date(lastSuccessAt).getTime()) / 3_600_000 : null
    push(findings, detectStaleData(hoursSinceSync))
  } catch (e) {
    push(findings, { area: 'supabase', severity: 'warning', message: `Could not read sync logs: ${msg(e)}` })
  }

  const weekStart = nyDaysAgo(7)
  const weekEnd = nyDaysAgo(1)

  // Meta-vs-GA4 reconciliation + booking-revenue sanity + GA4 availability.
  try {
    let metaBookings = 0
    let metaSpend = 0
    const { data: acct } = await db
      .from('daily_insights')
      .select('bookings, spend')
      .eq('ad_account_id', adAccountDbId)
      .eq('entity_level', 'account')
      .gte('date_start', weekStart)
      .lte('date_start', weekEnd)
    for (const r of acct ?? []) {
      metaBookings += Number(r.bookings ?? 0)
      metaSpend += Number(r.spend ?? 0)
    }

    // Compare Meta's modelled conversion count with GA's Meta-scoped confirmation-event telemetry.
    // This is a plane-conflict detector, not a booking or revenue reconciliation.
    const ga = await getGa4ConfirmationTelemetryBySource(weekStart, weekEnd).catch((e) => {
      // A thrown GA4 error is distinct from a normal "unavailable" — surface the actual cause.
      emitAlert({ area: 'ga4', severity: 'warning', message: `GA4 fetch threw: ${e instanceof Error ? e.message : String(e)}` })
      return { available: false, paid: { confirmationEvents: 0, eventValue: 0 }, organic: { confirmationEvents: 0, eventValue: 0 }, metaPaid: { confirmationEvents: 0, eventValue: 0 }, byChannel: [], zeroValueEvents: 0 }
    })
    // Compare Meta's modelled bookings against GA's META-scoped paid CONFIRMATION EVENTS. This is a
    // plane-conflict monitor between two non-canonical planes, not a business check: neither side is
    // the ledger. Both counts are telemetry, so a mismatch is a signal to investigate, never a
    // statement about how many bookings occurred.
    // Independent tracking-health evidence so a zero/zero window is not diagnosed as an outage on
    // the say-so of the two planes that would themselves be broken.
    // A review fixed two errors here. (1) POPULATION: this read all-source `confirmedAppointments`,
    // so one organic, phone or staff-created appointment "contradicted" Meta's paid subset. Only
    // WEBSITE-ORIGIN appointments can speak to the GA browser tag, and only recorded CAPI sends can
    // speak to Meta delivery. (2) WINDOW: the ledger was read to TODAY while both planes end at
    // weekEnd (yesterday), so today's bookings were compared against a window that excluded them.
    // Every read below uses weekStart..weekEnd, the same dates as Meta and GA.
    // Tracking health must not be judged from the BUSINESS reader. That reader excludes
    // CANCELED appointments — whose confirmation tag fired when they were created — so real telemetry
    // looked missing, and it offered no way to see that a window's origins were never established.
    // getConfirmationFacts is a separate TRACKING contract over confirmation-creation ET dates,
    // canceled included, with the three origin classes reported separately and never merged.
    let conf: Awaited<ReturnType<typeof getConfirmationFacts>> = null
    try {
      const acct = await resolveAdAccountId()
      if (acct) conf = await getConfirmationFacts(acct, weekStart, weekEnd)
    } catch { /* stays null — the findings say the evidence was NOT READ, never that it was zero */ }

    if (options.metaOutcomeMetricsComplete !== false) {
      push(findings, detectMetaGa4Mismatch({
        metaBookings, ga4Available: ga.available, ga4ConfirmationEvents: ga.metaPaid.confirmationEvents,
        websiteOriginAppointments: conf?.websiteConfirmations ?? null, metaSpend,
      }))
    }
    push(findings, detectGaTagHealth({
      ga4Available: ga.available,
      ga4ConfirmationEvents: ga.paid.confirmationEvents + ga.organic.confirmationEvents,
      websiteOriginAppointments: conf?.websiteConfirmations ?? null,
      originUnknownConfirmations: conf?.originUnknownConfirmations ?? null,
      window: { start: weekStart, end: weekEnd },
    }))
    for (const f of detectMetaDeliveryHealth({
      metaSpend,
      capiDeliveredAppointments: conf?.websiteWithAcceptedCapi ?? null,
      capiEligibleAppointments: conf?.websiteConfirmations ?? null,
      originUnknownConfirmations: conf?.originUnknownConfirmations ?? null,
      window: { start: weekStart, end: weekEnd },
    })) push(findings, f)
    if (ga.available) push(findings, detectBookingRevenueMismatch(ga.metaPaid.confirmationEvents, ga.metaPaid.eventValue))

    // Ledger G. Record the result this fetch returned, so the console can STATE the plane's health
    // rather than inferring it from env config — "a key is configured" is not "the plane answered".
    //
    // Written in BOTH branches on purpose: the `.catch` above degrades a thrown fetch to
    // `available: false`, and that is a real observed answer worth recording. The only path that
    // writes nothing is an exception before this line, which correctly leaves the plane
    // UNESTABLISHED — the cockpit then omits the GA4 row entirely rather than showing a stale one.
    //
    // `checked_at` is stamped only here, immediately after the fetch resolved, so it can never decay
    // into a "last attempted" timestamp — the failure that makes `ad_accounts.last_synced_at` useless
    // for judging data age.
    const { error: ga4HealthError } = await db.from('app_settings').upsert(
      {
        ad_account_id: adAccountDbId,
        key: 'ga4_telemetry_health',
        value: JSON.stringify({
          checked_at: new Date().toISOString(),
          available: ga.available,
          window_start_date: weekStart,
          window_end_date: weekEnd,
          confirmation_events: ga.paid.confirmationEvents + ga.organic.confirmationEvents,
        }),
        setting_type: 'json',
        label: 'GA4 Telemetry Health',
        description: 'Latest GA4 confirmation-telemetry availability snapshot, stamped by the monitoring run',
      },
      { onConflict: 'ad_account_id,key' },
    )
    if (ga4HealthError) {
      push(findings, { area: 'ga4', severity: 'warning', message: `ga4-telemetry-health: ${ga4HealthError.message}` })
    }
  } catch (e) {
    push(findings, { area: 'ga4', severity: 'warning', message: `Meta/GA4 reconciliation failed: ${msg(e)}` })
  }

  // Daily report persisted for the just-synced day? + did the LLM narrative actually generate?
  try {
    const { data: report } = await db
      .from('daily_reports')
      .select('id, model_used')
      .eq('ad_account_id', adAccountDbId)
      .eq('report_date', weekEnd)
      .maybeSingle()
    push(findings, detectReportFailure(!!report))
    // A row can persist metrics-only when the LLM fails — catch that narrative failure too.
    const providerConfigured = isAiEnabled()
    if (report) push(findings, detectReportNarrativeFailure((report.model_used as string | null) ?? null, providerConfigured))
  } catch (e) {
    push(findings, { area: 'report', severity: 'warning', message: `Could not verify report persistence: ${msg(e)}` })
  }

  // UTM coverage — untracked active ads block per-campaign GA4 ROAS (attribution instrumentation).
  try {
    const cov = await computeUtmCoverage(adAccountDbId)
    push(findings, detectUtmCoverage({ adsTotal: cov.adsTotal, adsCorrect: cov.adsCorrect }))
  } catch (e) {
    push(findings, { area: 'utm_coverage', severity: 'info', message: `UTM coverage check skipped: ${msg(e)}` })
  }

  // CAPI delivery backlog — the one path that loses conversions silently if the reconcile cron stops.
  try {
    // This account's enabled outcome sources only (src/lib/outcomes/aggregation.ts).
    const backlog = await readConversionBacklog(db, adAccountDbId)
    push(findings, detectCapiDeliveryBacklog({
      oldestUnsentHours: backlog.oldestUnsentHours,
      missedWindow: backlog.missedWindow,
    }))
  } catch (e) {
    push(findings, { area: 'cron', severity: 'warning', message: `CAPI delivery backlog check skipped: ${msg(e)}` })
  }

  // Duplicate-data regression guard — bounded JS distinct over recent campaign rows.
  try {
    const { data } = await db
      .from('daily_insights')
      .select('date_start, meta_campaign_id')
      .eq('ad_account_id', adAccountDbId)
      .eq('entity_level', 'campaign')
      .gte('date_start', nyDaysAgo(2))
      .limit(2000)
    const rows = data ?? []
    const keys = new Set(rows.map((r) => `${r.date_start}|${r.meta_campaign_id}`))
    push(findings, detectDuplicateData(rows.length, keys.size))
  } catch (e) {
    push(findings, { area: 'duplicate_data', severity: 'info', message: `Duplicate check skipped: ${msg(e)}` })
  }

  let alerts = 0
  for (const f of findings) {
    const r = emitAlert({ area: f.area, severity: f.severity, message: f.message, dedupeKey: f.dedupeKey })
    if (r.emitted) alerts++
  }

  return {
    checks: findings.length,
    alerts,
    findings: findings.map((f) => ({ area: f.area, severity: f.severity, message: f.message })),
  }
}

function push(arr: MonitoringFinding[], f: MonitoringFinding | null): void {
  if (f) arr.push(f)
}
function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
