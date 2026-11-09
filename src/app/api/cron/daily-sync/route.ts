import { runDailySync, type DailySyncResult } from '@/lib/sync/orchestrator'
import { updateSyncLog } from '@/lib/sync/log-sync'
import { reportOutcomesReady } from '@/lib/outcomes/report-gate'
import { createStepErrorRecorder } from '@/lib/cron/step-errors'
import { getAdminClient } from '@/lib/supabase/admin'
import { runVisionAnalysisForPending } from '@/lib/creative/vision-analyzer'
import { isAiEnabled } from '@/lib/ai'
import { getAdPlatform, requireCapability } from '@/lib/platforms/registry'
import { runTestMonitor } from '@/lib/tests/monitor'
import { runSignalsFetcher } from '@/lib/signals/fetcher'
import { checkTrackingHealth } from '@/lib/tracking/health-monitor'
import { analyzeUnprocessedAds } from '@/lib/competitors/analyze-ad'
import { detectTrajectoryAlerts, detectWrongOptimizationEvent } from '@/lib/alerts/detector'
import { insertAlertsDeduped } from '@/lib/alerts/insert'
import { snapshotCompetitorAds, detectFormatTrends } from '@/lib/competitors/trend-detector'
import { runFeedbackLoop, processFeedbackForCompletedTests } from '@/lib/feedback/loop'
import { runHealthScoresForAccount } from '@/lib/creative/health-score'
import { CHAMPION_WATCH_STATUS } from '@/lib/economics/champion-watch'
import { runDriftCheck } from '@/lib/diagnostics/drift-check'
import { evaluateRecommendationOutcomes } from '@/lib/learning/outcomes'
import { evaluateLedgerOutcomes } from '@/lib/learning/ledger-outcomes'
import { recomputeLearnedPatterns } from '@/lib/learning/patterns'
import { nyToday, nyWeekday, nyDaysAgo } from '@/lib/utils/date-utils'
import { generateWeeklyReport } from '@/lib/report/weekly'
import { readWeeklyExecutiveDigest } from '@/lib/report/weekly-executive'
import { deliverWeeklyExecutiveSafely } from '@/lib/report/weekly-executive-delivery'
import { runMonitoringChecks } from '@/lib/monitoring/run'
import { emitAlert } from '@/lib/monitoring/alerts'
import { budgetExceeded, withTimeout } from '@/lib/cron/time-budget'
import { checkCronAuthorization } from '@/lib/auth/cron-secret'
import { isDailyDigestV3, readDailyDigestSnapshot } from '@/lib/report/daily-digest'
import { deliverDailyDigestSafely } from '@/lib/report/daily-digest-delivery'

export const runtime = 'nodejs'
export const maxDuration = 300

/**
 * Gmail clips a message around 102KB, and the delivery layer's 100_000-byte cap counts the raw
 * string — not the MIME headers and quoted-printable expansion wrapped around it. The runtime
 * budget therefore sits below the transport cap so the rendered part keeps real headroom.
 */
const DIGEST_HTML_MAX_BYTES = 90_000

/**
 * Step 18 runs last, but "last" is not "unbounded" — a past failure was a single unbounded
 * step consuming the 300s function budget and silently killing everything ordered after it. The
 * render is CPU-only, so this deadline is generous; exceeding it means something is wrong, and the
 * digest goes out text-only rather than holding the cron open.
 */
const DIGEST_RENDER_TIMEOUT_MS = 10_000

const DAILY_EXECUTIVE_EMAIL_FLAG = 'MAXX_DAILY_EXECUTIVE_EMAIL_ENABLED'
const WEEKLY_EXECUTIVE_EMAIL_FLAG = 'MAXX_WEEKLY_EXECUTIVE_EMAIL_ENABLED'

function emailDeliveryEnabled(flag: typeof DAILY_EXECUTIVE_EMAIL_FLAG | typeof WEEKLY_EXECUTIVE_EMAIL_FLAG): boolean {
  return process.env[flag] === 'true'
}

function shadowDeliveryTelemetry(featureFlag: string) {
  return {
    status: 'skipped' as const,
    reason: 'delivery_disabled_shadow_mode',
    mode: 'shadow' as const,
    feature_flag: featureFlag,
  }
}

/**
 * Vercel injects both of these into every deployment WITHOUT a scheme, so reading them adds no
 * owner configuration and no new env var. Neither present (local, dev, or a non-Vercel host) means
 * there is no URL to link, and the template then omits the CTA block entirely.
 */
function digestDashboardUrl(): string {
  const host = process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim()
    || process.env.VERCEL_URL?.trim()
    || ''
  return host ? `https://${host}` : ''
}

/** PAID_TOUCH_RETENTION_DAYS as a whole number of days, at least 30; default 180. */
function paidTouchRetentionDays(): number {
  const days = Number(process.env.PAID_TOUCH_RETENTION_DAYS?.trim())
  return Number.isSafeInteger(days) && days >= 30 ? days : 180
}

function isMonday(): boolean {
  return nyWeekday() === 1
}

async function getAdAccountDbId(metaAccountId: string): Promise<string | null> {
  const db = getAdminClient()
  const { data } = await db
    .from('ad_accounts')
    .select('id')
    .eq('account_id', metaAccountId)
    .maybeSingle()
  return (data as { id: string } | null)?.id ?? null
}

async function deliverCommittedWeeklyExecutive(input: {
  adAccountDbId: string
  weeklyId: string
  weekStart: string
  weekEnd: string
}) {
  // Bind delivery to the exact report returned by THIS invocation and to that row's immutable
  // evidence. Never scan historical unsent reports or reconstruct a missing evidence generation.
  const db = getAdminClient()
  const weeklyRead = await db
    .from('weekly_reports')
    .select('id, week_start, week_end, executive_evidence_generation_id, report_json')
    .eq('id', input.weeklyId)
    .eq('ad_account_id', input.adAccountDbId)
    .maybeSingle()
  if (weeklyRead.error) throw new Error(`weekly report read failed: ${weeklyRead.error.message}`)
  const weeklyRow = weeklyRead.data as {
    id: string
    week_start: string
    week_end: string
    executive_evidence_generation_id: string | null
    report_json: Record<string, unknown> | null
  } | null
  if (!weeklyRow?.executive_evidence_generation_id
    || weeklyRow.week_start !== input.weekStart || weeklyRow.week_end !== input.weekEnd) {
    return { status: 'skipped' as const, reason: 'committed_evidence_binding_unavailable' }
  }

  // The email is the exact committed digest, not a re-render from evidence under whatever code is
  // deployed when a delayed delivery runs. The DB binding trigger already guarantees that current
  // weekly rows reference an immutable evidence generation for this account/week.
  const digest = readWeeklyExecutiveDigest(weeklyRow.report_json?.weeklyDigest)
  if (!digest || digest.weekly_report_id !== weeklyRow.id
    || digest.week_start !== weeklyRow.week_start || digest.week_end !== weeklyRow.week_end) {
    return { status: 'skipped' as const, reason: 'committed_weekly_digest_unavailable' }
  }
  let html: string | undefined
  try {
    const { renderWeeklyExecutiveHtml } = await import('@/lib/report/weekly-executive-email')
    html = await withTimeout(
      renderWeeklyExecutiveHtml(digest, digestDashboardUrl()),
      DIGEST_RENDER_TIMEOUT_MS,
      'weekly executive html render',
    )
  } catch (renderError) {
    console.error('[DailySync] weekly executive html render failed - sending text-only:',
      renderError instanceof Error ? renderError.message : String(renderError))
  }
  return deliverWeeklyExecutiveSafely({
    reportId: weeklyRow.id,
    weekStart: weeklyRow.week_start,
    weekEnd: weeklyRow.week_end,
    subject: digest.subject,
    text: digest.text,
    ...(html === undefined ? {} : { html }),
  })
}

async function deliverCommittedDailyExecutive(input: {
  adAccountDbId: string
  report: NonNullable<DailySyncResult['committedReport']>
}) {
  const db = getAdminClient()
  const reportRead = await db
    .from('daily_reports')
    .select('id, report_json')
    .eq('ad_account_id', input.adAccountDbId)
    .eq('id', input.report.id)
    .eq('report_date', input.report.reportDate)
    .maybeSingle()
  if (reportRead.error) throw new Error(`daily report read failed: ${reportRead.error.message}`)
  const reportRow = reportRead.data as { id: string; report_json: Record<string, unknown> | null } | null
  const digest = readDailyDigestSnapshot(reportRow?.report_json?.dailyDigest)
  if (!reportRow || !digest || !isDailyDigestV3(digest)
    || digest.report_date !== input.report.reportDate) {
    return {
      status: 'skipped' as const,
      reason: digest && !isDailyDigestV3(digest)
        ? 'legacy_digest_not_deliverable'
        : 'no_committed_v3_digest',
    }
  }

  let digestHtml: string | undefined
  try {
    const { renderDailyDigestHtml } = await import('@/lib/report/daily-digest-email')
    const rendered = await withTimeout(
      renderDailyDigestHtml(digest, digestDashboardUrl()),
      DIGEST_RENDER_TIMEOUT_MS,
      'daily digest html render',
    )
    const bytes = Buffer.byteLength(rendered, 'utf8')
    if (rendered.length === 0 || bytes > DIGEST_HTML_MAX_BYTES) {
      console.error(`[DailySync] digest html unusable (${bytes} bytes) - sending text-only`)
    } else {
      digestHtml = rendered
    }
  } catch (error) {
    console.error('[DailySync] digest html render failed - sending text-only:',
      error instanceof Error ? error.message : String(error))
  }
  return deliverDailyDigestSafely({
    reportId: reportRow.id,
    reportDate: digest.report_date,
    subject: digest.subject,
    markdown: digest.markdown,
    ...(digestHtml === undefined ? {} : { html: digestHtml }),
  })
}

export async function GET(req: Request) {
  const cronAuthorization = checkCronAuthorization(req.headers.get('authorization'))
  if (cronAuthorization === 'misconfigured') {
    return Response.json(
      { error: 'Cron authentication is not configured.', code: 'CRON_SECRET_NOT_CONFIGURED' },
      { status: 503 },
    )
  }
  if (cronAuthorization === 'unauthorized') {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const accountId = process.env.META_AD_ACCOUNT_ID
  if (!accountId) {
    // Misconfigured cron — the daily job cannot run at all. Page on it.
    emitAlert({ area: 'cron', severity: 'critical', message: 'Cron aborted: META_AD_ACCOUNT_ID is not configured — no sync will run.', dedupeKey: 'no_account_id' })
    return Response.json({ error: 'META_AD_ACCOUNT_ID not configured' }, { status: 500 })
  }

  // Step outcomes after the core sync were previously in-memory only: `steps` is returned in the
  // HTTP body, which Vercel's cron discards, and api_sync_logs has no per-step column. When the
  // 2026-08-17 Monday run hit the 300s ceiling AFTER the core sync wrote status='success', the
  // weekly report and daily digest simply never happened and left no trace anywhere — and Vercel
  // runtime logs are billing-capped, so the reason is unrecoverable. Every step outcome is now
  // mirrored into api_sync_logs.error_details, so a hard kill still leaves the last completed step
  // durable and the next step is the culprit.
  const completedSteps: string[] = []
  const rawSteps: Record<string, unknown> = {}
  // A failed step's error text goes to the server log and the owner-only sync log (step_errors), never
  // into the HTTP body: the response carries only the stable STEP_FAILED code.
  const { stepErrors, stepFailed } = createStepErrorRecorder('daily-sync')
  const steps = new Proxy(rawSteps, {
    set(target, key, value) {
      if (typeof key === 'string' && !(key in target)) completedSteps.push(key)
      target[key as string] = value
      return true
    },
  }) as Record<string, unknown>
  let syncLogId: string | null = null

  /** Mirror step state into api_sync_logs. Never throws: observability must not break the run. */
  const flushSteps = async (): Promise<void> => {
    if (!syncLogId) return
    try {
      await updateSyncLog(syncLogId, {
        errorDetails: {
          last_completed_step: completedSteps[completedSteps.length - 1] ?? null,
          completed_steps: [...completedSteps],
          steps: rawSteps,
          step_errors: stepErrors,
        },
      })
    } catch {
      // Swallow: a failed telemetry write must never take down the cron.
    }
  }

  let committedReport: DailySyncResult['committedReport']
  let committedWeeklyReport: { id: string; weekStart: string; weekEnd: string } | null = null
  let coreOutcomeReconcile: DailySyncResult['outcomeReconcile']
  let coreOutcomeArrival: DailySyncResult['outcomeArrival'] = null
  let coreMetaOutcomeMetricsComplete = false
  let coreMetaOutcomeBlockerCodes = ['current_sync_outcome_status_unavailable']

  // The LLM-heavy enrichment steps (vision, signals, competitor sync/analysis) could burn the
  // whole 300s function budget and starve the CRITICAL brain steps ordered after them (champion watch,
  // drift, learning, recommendations, weekly report, monitoring). Optional enrichment is now gated on a
  // time budget so the critical tail always runs; the LLM calls inside those steps are independently
  // timeout-bounded (signals/analyze-ad). `optional()` skips a step (recording why) when time is short.
  const startedAtMs = Date.now()
  const optional = (key: string, run: () => Promise<void>): Promise<void> => {
    if (budgetExceeded(startedAtMs, Date.now())) {
      steps[key] = { skipped: 'time-budget — reserved for critical steps' }
      return flushSteps()
    }
    return run().then(flushSteps)
  }

  // Step 1: Core daily sync (campaigns, adsets, ads, insights, alerts, flags, report)
  try {
    const result = await runDailySync({ adAccountId: accountId, triggeredBy: 'cron' })
    coreMetaOutcomeMetricsComplete = result.metaOutcomeMetricsComplete === true
    coreMetaOutcomeBlockerCodes = Array.isArray(result.metaOutcomeBlockerCodes)
      ? [...result.metaOutcomeBlockerCodes]
      : ['current_sync_outcome_status_unavailable']
    syncLogId = result.logId ?? null
    steps.daily_sync = {
      success: result.success,
      logId: result.logId,
      meta_outcomes: coreMetaOutcomeMetricsComplete
        ? { status: 'available' }
        : { status: 'unavailable', blocker_codes: coreMetaOutcomeBlockerCodes },
    }
    committedReport = result.committedReport
    coreOutcomeArrival = result.outcomeArrival ?? null
    const recon = result.outcomeReconcile
    coreOutcomeReconcile = recon
    if (recon) {
      steps.outcome_reconcile = recon.available
        ? {
            completed_at: recon.completedAt,
            fetched: recon.fetched,
            upserted: recon.upserted,
            webhook_misses: recon.webhookMisses,
            ...(recon.truncated ? { truncated: true } : {}),
            capi: recon.capi?.ran
              ? { sent: recon.capi.sent, skipped: recon.capi.skipped, errors: recon.capi.errors, marked_missed: recon.capi.markedMissed }
              : { mode: recon.capi?.mode ?? 'off' },
          }
        : { skipped: recon.reason }
    }
  } catch (error) {
    steps.daily_sync = { success: false, ...stepFailed('daily_sync', error) }
    // Core sync failure is fatal — return early
    return Response.json({ error: 'Daily sync failed.', code: 'DAILY_SYNC_FAILED', steps }, { status: 500 })
  }

  // Resolve the DB UUID for subsequent steps
  const adAccountDbId = await getAdAccountDbId(accountId)
  if (!adAccountDbId) {
    return Response.json({ error: 'Could not resolve ad account DB ID', steps }, { status: 500 })
  }

  const today = nyToday()

  // Step 2: Commit the Monday weekly projection from Sunday's exact evidence before optional jobs.
  if (isMonday()) {
    try {
      const weekStart = nyDaysAgo(7)
      const weekEnd = nyDaysAgo(1)
      if (!committedReport || committedReport.reportDate !== weekEnd) {
        steps.weekly_report = { skipped: 'current Sunday evidence report was not committed by this run' }
        steps.weekly_executive_delivery = { status: 'skipped', reason: 'weekly_report_not_committed' }
      } else if (!reportOutcomesReady({
        lifecycleRun: true,
        arrival: coreOutcomeArrival,
        reconcile: coreOutcomeReconcile,
        startDate: weekStart,
        endDate: weekEnd,
      })) {
        steps.weekly_report = { skipped: 'current outcome source window unavailable or incomplete' }
        steps.weekly_executive_delivery = { status: 'skipped', reason: 'weekly_report_not_committed' }
      } else {
        const weeklyId = await generateWeeklyReport(adAccountDbId, weekStart, weekEnd, committedReport.id, {
          outcomeArrival: coreOutcomeArrival,
        })
        steps.weekly_report = { id: weeklyId, week: `${weekStart}…${weekEnd}` }
        committedWeeklyReport = { id: weeklyId, weekStart, weekEnd }
      }
    } catch (error) {
      steps.weekly_report = stepFailed('weekly_report', error)
      steps.weekly_executive_delivery = {
        status: 'failed', reason: stepFailed('weekly_executive_delivery', error).error,
      }
    }
  } else {
    steps.weekly_report = { skipped: 'runs on Mondays only' }
    steps.weekly_executive_delivery = { status: 'skipped', reason: 'runs_on_mondays_only' }
  }
  await flushSteps()

  // Housekeeping: the paid-touch rate limiter keeps one row per client; prune windows older than a day.
  try {
    const pruned = await getAdminClient().rpc('prune_api_rate_limit_windows')
    steps.rate_limit_prune = pruned.error ? stepFailed('rate_limit_prune', pruned.error) : { removed: pruned.data }
  } catch (error) {
    steps.rate_limit_prune = stepFailed('rate_limit_prune', error)
  }

  // Housekeeping: paid-touch capture rows that never became evidence (rejected attempts, unlinked
  // touches and expired tokens) are removed after PAID_TOUCH_RETENTION_DAYS (default 180).
  try {
    const pruned = await getAdminClient().rpc('prune_unlinked_paid_touch_rows', { p_retention_days: paidTouchRetentionDays() })
    steps.paid_touch_prune = pruned.error ? stepFailed('paid_touch_prune', pruned.error) : { removed: pruned.data }
  } catch (error) {
    steps.paid_touch_prune = stepFailed('paid_touch_prune', error)
  }

  // Monitoring runs before provider calls so email latency cannot starve the safety checks.
  try {
    steps.monitoring = await runMonitoringChecks(adAccountDbId, {
      metaOutcomeMetricsComplete: coreMetaOutcomeMetricsComplete,
    })
  } catch (error) {
    steps.monitoring = stepFailed('monitoring', error)
  }

  if (committedWeeklyReport) {
    if (!emailDeliveryEnabled(WEEKLY_EXECUTIVE_EMAIL_FLAG)) {
      steps.weekly_executive_delivery = shadowDeliveryTelemetry(WEEKLY_EXECUTIVE_EMAIL_FLAG)
    } else {
      try {
        steps.weekly_executive_delivery = await deliverCommittedWeeklyExecutive({
          adAccountDbId,
          weeklyId: committedWeeklyReport.id,
          weekStart: committedWeeklyReport.weekStart,
          weekEnd: committedWeeklyReport.weekEnd,
        })
      } catch (error) {
        steps.weekly_executive_delivery = {
          status: 'failed', reason: stepFailed('weekly_executive_delivery', error).error,
        }
      }
    }
  }

  // Send only the exact deterministic V3 snapshot committed by this run. No historical scan and no
  // fallback to V1/V2 or free-form prose. Delivery remains fail-soft and idempotent.
  if (!committedReport) {
    steps.daily_digest = { status: 'skipped', reason: 'report_not_committed' }
  } else if (!emailDeliveryEnabled(DAILY_EXECUTIVE_EMAIL_FLAG)) {
    steps.daily_digest = shadowDeliveryTelemetry(DAILY_EXECUTIVE_EMAIL_FLAG)
  } else {
    try {
      steps.daily_digest = await deliverCommittedDailyExecutive({ adAccountDbId, report: committedReport })
    } catch (error) {
      steps.daily_digest = {
        status: 'failed', reason: stepFailed('daily_digest', error).error,
      }
    }
  }

  await flushSteps()

  // Optional enrichment starts only after the committed daily/weekly email attempt.
  // Step 3: Creative vision analysis (up to 20 creatives per run, non-fatal) — budget-gated (F1)
  await optional('vision_analysis', async () => {
    if (!isAiEnabled()) {
      steps.vision_analysis = { skipped: 'AI is off' }
      return
    }
    try {
      const count = await runVisionAnalysisForPending(adAccountDbId)
      steps.vision_analysis = { processed: count }
    } catch (err) {
      steps.vision_analysis = stepFailed('vision_analysis', err)
    }
  })

  // Step 3: Optional non-placement segment enrichment. Publisher/platform placement evidence is
  // refreshed atomically inside runDailySync before the report; this later job must not mutate that
  // committed source window without advancing its source head.
  if (!coreMetaOutcomeMetricsComplete) {
    steps.breakdowns = {
      skipped: 'current Meta outcome metrics unavailable',
      blocker_codes: coreMetaOutcomeBlockerCodes,
    }
  } else try {
    const db = getAdminClient()
    const { data: adsets } = await db
      .from('adsets')
      .select('adset_id')
      .eq('ad_account_id', adAccountDbId)
      .limit(50)

    if (adsets && adsets.length > 0) {
      // Breakdowns describe the same completed day as core insights — yesterday (NY-time), never the
      // partial current day, which under-reports and mis-dates insight_breakdowns.date_start.
      const breakdownDate = nyDaysAgo(1)
      let totalUpserted = 0
      // Supplemental segment coverage for the Segments page. These dimensions are not inputs to the
      // committed executive placement evidence contract.
      for (const breakdown of ['age', 'gender', 'device_platform', 'region'] as const) {
        const rows = await requireCapability(getAdPlatform('meta'), 'breakdowns').fetch({
          accountId,
          level: 'adset',
          since: breakdownDate,
          until: breakdownDate,
          breakdowns: [breakdown],
        })
        totalUpserted += await requireCapability(getAdPlatform('meta'), 'breakdowns').upsert(adAccountDbId, breakdownDate, rows)
      }
      steps.breakdowns = { upserted: totalUpserted }
    } else {
      steps.breakdowns = { skipped: 'no active adsets' }
    }
  } catch (err) {
    steps.breakdowns = stepFailed('breakdowns', err)
  }

  // Step 4: Test monitor (non-fatal)
  try {
    const result = await runTestMonitor(adAccountDbId, today)
    steps.test_monitor = result
  } catch (err) {
    steps.test_monitor = stepFailed('test_monitor', err)
  }

  // Step 5: Expert signals — Monday only (non-fatal)
  if (isMonday()) {
    try {
      const result = await runSignalsFetcher(adAccountDbId)
      steps.signals = result
    } catch (err) {
      steps.signals = stepFailed('signals', err)
    }
  } else {
    steps.signals = { skipped: 'runs on Mondays only' }
  }

  // Step 6: CAPI / tracking health check (non-fatal)
  try {
    const result = await checkTrackingHealth(adAccountDbId)
    steps.tracking_health = { status: result.status, issues: result.issues }
  } catch (err) {
    steps.tracking_health = stepFailed('tracking_health', err)
  }

  // Step 7: Competitor ad library sync (non-fatal) — budget-gated (F1)
  await optional('competitor_sync', async () => {
    try {
      const db = getAdminClient()
      const { data: competitors } = await db
        .from('competitor_sources')
        .select('id, name, facebook_page_id')
        .eq('ad_account_id', adAccountDbId)
        .not('facebook_page_id', 'is', null)

      let competitorAdsTotal = 0
      for (const comp of (competitors ?? []) as Array<{ id: string; name: string; facebook_page_id: string }>) {
        try {
          const count = await requireCapability(getAdPlatform('meta'), 'adLibrary').fetchCompetitorAds(comp.id, comp.facebook_page_id)
          competitorAdsTotal += count
        } catch (e) {
          console.warn(`[Cron] Competitor sync failed for ${comp.name}:`, e instanceof Error ? e.message : e)
        }
      }
      steps.competitor_sync = { competitors_checked: (competitors ?? []).length, ads_upserted: competitorAdsTotal }
    } catch (err) {
      steps.competitor_sync = stepFailed('competitor_sync', err)
    }
  })

  // Step 8: Analyze unprocessed competitor ads via Claude (non-fatal, limit 10/run) — budget-gated (F1)
  await optional('competitor_analysis', async () => {
    if (!isAiEnabled()) {
      steps.competitor_analysis = { skipped: 'AI is off' }
      return
    }
    try {
      const count = await analyzeUnprocessedAds(adAccountDbId, 10)
      steps.competitor_analysis = { analyzed: count }
    } catch (err) {
      steps.competitor_analysis = stepFailed('competitor_analysis', err)
    }
  })

  // Step 8b: Compute creative health scores (non-fatal)
  if (!coreMetaOutcomeMetricsComplete) {
    steps.health_scores = {
      skipped: 'current Meta outcome metrics unavailable',
      blocker_codes: coreMetaOutcomeBlockerCodes,
    }
  } else try {
    const scored = await runHealthScoresForAccount(adAccountDbId)
    steps.health_scores = { scored }
  } catch (err) {
    steps.health_scores = stepFailed('health_scores', err)
  }

  // Step 8c: legacy compatibility marker. Historical Meta records cannot create current alerts,
  // priors, policy or actions, so champion watch is deliberately inert.
  steps.champion_watch = CHAMPION_WATCH_STATUS

  // Step 8d: Drift guardrail — re-fetch LIVE Meta spend for the trailing complete week and diff
  // against BOTH stored layers (daily_insights + daily_reports). Runs AFTER the core sync so it validates
  // the just-synced state; drift ⇒ one deduped warning alert. Non-fatal, read-only.
  try {
    const drift = await runDriftCheck(adAccountDbId, {
      raiseAlert: true,
      includeBookings: coreMetaOutcomeMetricsComplete,
    })
    steps.drift_check = drift.available
      ? { verdict: drift.verdict, drifted_days: drift.layers.map((l) => `${l.layer}:${l.drifted_days}`).join(' ') }
      : { error: drift.reason }
  } catch (err) {
    steps.drift_check = stepFailed('drift_check', err)
  }

  // Step 9: Snapshot competitor ads for time-series tracking (non-fatal)
  try {
    const snapshotCount = await snapshotCompetitorAds(adAccountDbId)
    steps.competitor_snapshots = { snapshots: snapshotCount }
  } catch (err) {
    steps.competitor_snapshots = stepFailed('competitor_snapshots', err)
  }

  // Step 10: Detect competitor format trends + create info alerts (non-fatal)
  try {
    const trends = await detectFormatTrends(adAccountDbId)
    const emergingTrends = trends.filter((t) => t.is_emerging)

    if (emergingTrends.length > 0 && adAccountDbId) {
      const db = getAdminClient()
      const alertsToInsert = emergingTrends.map((t) => ({
        ad_account_id: adAccountDbId,
        alert_date: today,
        entity_level: 'campaign' as const,
        campaign_id: null,
        adset_id: null,
        ad_id: null,
        meta_campaign_id: null,
        meta_adset_id: null,
        meta_ad_id: null,
        alert_type: 'creative_fatigue',
        severity: 'info',
        title: `Competitor format observation: ${t.format} — ${t.new_in_last_14d} new ads in 14 days`,
        message: `${t.competitor_count} tracked competitor(s) used this observed format. This is market context, not proof of performance or a creative direction.`,
        metric_name: 'format_trend',
        metric_value: t.new_in_last_14d,
        threshold_value: null,
        baseline_value: null,
        is_resolved: false,
        why_it_matters: 'Descriptive competitor context can inform a separately governed CampaignPlan, but cannot establish account fit or action authority.',
        recommended_actions: [],
        amount_at_risk: null,
        action_label: null,
        action_url: null,
      }))
      await insertAlertsDeduped(db, alertsToInsert) // deduped: a cron retry won't duplicate trend alerts
    }
    steps.competitor_trends = { formats_detected: trends.length, emerging: emergingTrends.length }
  } catch (err) {
    steps.competitor_trends = stepFailed('competitor_trends', err)
  }

  // Step 11: Predictive CPA trajectory alerts (non-fatal)
  if (!coreMetaOutcomeMetricsComplete) {
    steps.trajectory_alerts = {
      skipped: 'current Meta outcome metrics unavailable',
      blocker_codes: coreMetaOutcomeBlockerCodes,
    }
  } else if (adAccountDbId) {
    try {
      const trajectoryAlertCount = await detectTrajectoryAlerts(adAccountDbId, today)
      steps.trajectory_alerts = { created: trajectoryAlertCount }
    } catch (err) {
      steps.trajectory_alerts = stepFailed('trajectory_alerts', err)
    }
  }

  // Step 11b: Wrong-optimization-event detector (N7a) — rookie-mistake guard (non-fatal)
  if (adAccountDbId) {
    try {
      const wrongOptCount = await detectWrongOptimizationEvent(adAccountDbId, today)
      steps.wrong_optimization_alerts = { created: wrongOptCount }
    } catch (err) {
      steps.wrong_optimization_alerts = stepFailed('wrong_optimization_alerts', err)
    }
  }

  // Step 12: Feedback loop — generate briefs for new winners (non-fatal)
  if (adAccountDbId) {
    try {
      const feedbackCount = await runFeedbackLoop(adAccountDbId)
      steps.feedback_loop = { approvals_created: feedbackCount }
    } catch (err) {
      steps.feedback_loop = stepFailed('feedback_loop', err)
    }
  }

  // Step 13: Process completed/killed tests for feedback (non-fatal)
  if (adAccountDbId) {
    try {
      const testFeedbackCount = await processFeedbackForCompletedTests(adAccountDbId)
      steps.test_feedback = { approvals_created: testFeedbackCount }
    } catch (err) {
      steps.test_feedback = stepFailed('test_feedback', err)
    }
  }

  // Step 13c: Daypart insights (hour × day-of-week) — populates daypart_insights + feeds time-of-day learning (non-fatal)
  if (!coreMetaOutcomeMetricsComplete) {
    steps.daypart = {
      skipped: 'current Meta outcome metrics unavailable',
      blocker_codes: coreMetaOutcomeBlockerCodes,
    }
  } else if (adAccountDbId) {
    try {
      const dpSince = nyDaysAgo(30)
      const dpUntil = nyDaysAgo(1)
      const dpRows = await requireCapability(getAdPlatform('meta'), 'daypart').fetch({ accountId, since: dpSince, until: dpUntil })
      const dpUpserted = await requireCapability(getAdPlatform('meta'), 'daypart').upsert(adAccountDbId, dpSince, dpUntil, dpRows)
      steps.daypart = { fetched: dpRows.length, upserted: dpUpserted }
    } catch (err) {
      steps.daypart = stepFailed('daypart', err)
    }
  }

  // Step 14: Learning — score whether past recommendations (flags) actually worked (non-fatal)
  if (!coreMetaOutcomeMetricsComplete) {
    steps.recommendation_outcomes = {
      skipped: 'current Meta outcome metrics unavailable',
      blocker_codes: coreMetaOutcomeBlockerCodes,
    }
  } else if (adAccountDbId) {
    try {
      steps.recommendation_outcomes = await evaluateRecommendationOutcomes(adAccountDbId, today)
    } catch (err) {
      steps.recommendation_outcomes = stepFailed('recommendation_outcomes', err)
    }
  }

  // Step 14b: Learning — score SETUP-LEDGER decisions whose follow-up date arrived, onto the same
  // pending-review board (owner-gated; nothing becomes trusted learning without approval). Non-fatal.
  if (!coreMetaOutcomeMetricsComplete) {
    steps.ledger_outcomes = {
      skipped: 'current Meta outcome metrics unavailable',
      blocker_codes: coreMetaOutcomeBlockerCodes,
    }
  } else if (adAccountDbId) {
    try {
      steps.ledger_outcomes = await evaluateLedgerOutcomes(adAccountDbId, today)
    } catch (err) {
      steps.ledger_outcomes = stepFailed('ledger_outcomes', err)
    }
  }

  // Step 15: Learning — recompute "what works" patterns across targeting/settings/spend/time (non-fatal)
  if (!coreMetaOutcomeMetricsComplete) {
    steps.learned_patterns = {
      skipped: 'current Meta outcome metrics unavailable',
      blocker_codes: coreMetaOutcomeBlockerCodes,
    }
  } else if (adAccountDbId) {
    try {
      steps.learned_patterns = await recomputeLearnedPatterns(adAccountDbId, today)
    } catch (err) {
      steps.learned_patterns = stepFailed('learned_patterns', err)
    }
  }

  // Recommendation generation and current report publication run inside runDailySync before every
  // optional enrichment above. No later step mutates or reinterprets the committed evidence snapshot.

  // Terminal reconciliation. runDailySync already wrote its own status before any of the steps
  // above ran, so a failed weekly report or digest delivery could previously coexist with a green
  // `success` row — which is exactly how the 2026-08-17 miss stayed invisible. A failure in either
  // committed-evidence delivery now downgrades the run to `partial`.
  const deliveryFailures = (['weekly_report', 'weekly_executive_delivery', 'daily_digest'] as const)
    .filter((key) => {
      const step = rawSteps[key] as { status?: string; error?: unknown } | undefined
      return step ? step.status === 'failed' || step.error !== undefined : false
    })
  if (syncLogId) {
    try {
      await updateSyncLog(syncLogId, {
        ...(deliveryFailures.length
          ? {
              status: 'partial' as const,
              errorMessage: `Committed-evidence delivery failed: ${deliveryFailures.join(', ')}`,
            }
          : {}),
        errorDetails: {
          last_completed_step: completedSteps[completedSteps.length - 1] ?? null,
          completed_steps: [...completedSteps],
          steps: rawSteps,
          step_errors: stepErrors,
          cron_completed: true,
        },
      })
    } catch {
      // Swallow: telemetry must not fail the cron.
    }
  }

  return Response.json({ success: true, steps })
}
