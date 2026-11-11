import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { WeeklyExecutiveDeliveryRequest } from '@/lib/report/weekly-executive-delivery'
import {
  WEEKLY_REPORT_ID,
  WEEK_END,
  WEEK_START,
  weeklyExecutiveEvidenceFixture,
} from './fixtures/weekly-executive'
import { buildWeeklyExecutiveDigest } from '@/lib/report/weekly-executive'

const AD_ACCOUNT_DB_ID = '00000000-0000-4000-8000-0000000000ad'
const EVIDENCE_GENERATION_ID = '00000000-0000-4000-8000-000000001099'
const DAILY_REPORT_ID = '00000000-0000-4000-8000-000000001098'
const COMMITTED_WEEKLY_DIGEST = buildWeeklyExecutiveDigest(weeklyExecutiveEvidenceFixture, {
  weeklyReportId: WEEKLY_REPORT_ID,
  weekStart: WEEK_START,
  weekEnd: WEEK_END,
})

const state = vi.hoisted(() => ({
  weekday: 1,
  reconciliationComplete: true,
  committedReport: null as { id: string; reportDate: string } | null,
  outcomeArrival: null as { sources: Array<{ source_id: string; kind: string; label: string }> } | null,
  generatedArrivals: [] as unknown[],
  generated: [] as Array<{
    accountId: string
    start: string
    end: string
    dailyReportId: string
  }>,
  filters: [] as Array<{ table: string; column: string; value: unknown }>,
  events: [] as string[],
  rendered: [] as Array<{ dashboardUrl: string; reportId: string }>,
  delivered: [] as WeeklyExecutiveDeliveryRequest[],
}))

function queryChain(table: string) {
  const chain: Record<string, unknown> = {}
  chain.select = () => chain
  chain.eq = (column: string, value: unknown) => {
    state.filters.push({ table, column, value })
    return chain
  }
  for (const method of ['not', 'order', 'limit', 'gte', 'lte']) chain[method] = () => chain
  const single = async () => {
    if (table === 'ad_accounts') return { data: { id: AD_ACCOUNT_DB_ID, platform: 'meta' }, error: null }
    if (table === 'weekly_reports') {
      return {
        data: {
          id: WEEKLY_REPORT_ID,
          week_start: WEEK_START,
          week_end: WEEK_END,
          executive_evidence_generation_id: EVIDENCE_GENERATION_ID,
          report_json: { weeklyDigest: COMMITTED_WEEKLY_DIGEST },
        },
        error: null,
      }
    }
    return { data: null, error: null }
  }
  chain.single = single
  chain.maybeSingle = single
  chain.then = (resolve: (value: { data: never[]; error: null }) => unknown) =>
    Promise.resolve(resolve({ data: [], error: null }))
  return chain
}

type Original = () => Promise<Record<string, unknown>>

vi.mock('@/lib/auth/cron-secret', async (o: Original) => ({
  ...(await o()), checkCronAuthorization: () => 'authorized',
}))
vi.mock('@/lib/supabase/admin', async (o: Original) => ({
  ...(await o()), getAdminClient: () => ({ from: (table: string) => queryChain(table) }),
}))
vi.mock('@/lib/sync/orchestrator', async (o: Original) => ({
  ...(await o()),
  runDailySync: async () => ({
    logId: 'log-1', success: true, outcomeReconcile: { available: true },
    committedReport: state.committedReport,
    outcomeArrival: state.outcomeArrival,
  }),
}))
vi.mock('@/lib/outcomes/reconciliation', async (o: Original) => ({
  ...(await o()), reconciliationCoversWindow: () => state.reconciliationComplete,
}))
vi.mock('@/lib/cron/time-budget', async (o: Original) => ({
  ...(await o()), budgetExceeded: () => true,
}))
vi.mock('@/lib/utils/date-utils', async (o: Original) => ({
  ...(await o()),
  nyToday: () => '2026-08-10',
  nyWeekday: () => state.weekday,
  nyDaysAgo: (days: number) => days === 7 ? WEEK_START : WEEK_END,
}))
vi.mock('@/lib/monitoring/alerts', async (o: Original) => ({
  ...(await o()), emitAlert: () => undefined,
}))
vi.mock('@/lib/monitoring/run', async (o: Original) => ({
  ...(await o()), runMonitoringChecks: async () => {
    state.events.push('monitoring')
    return {}
  },
}))
vi.mock('@/lib/creative/vision-analyzer', async (o: Original) => ({
  ...(await o()), runVisionAnalysisForPending: async () => 0,
}))
vi.mock('@/lib/platforms/meta/fetch-breakdowns', async (o: Original) => ({
  ...(await o()), fetchBreakdowns: async () => [], upsertBreakdowns: async () => 0,
}))
vi.mock('@/lib/platforms/meta/fetch-daypart', async (o: Original) => ({
  ...(await o()), fetchDaypartInsights: async () => [], upsertDaypartInsights: async () => 0,
}))
vi.mock('@/lib/tests/monitor', async (o: Original) => ({
  ...(await o()), runTestMonitor: async () => ({}),
}))
vi.mock('@/lib/signals/fetcher', async (o: Original) => ({
  ...(await o()), runSignalsFetcher: async () => ({}),
}))
vi.mock('@/lib/tracking/health-monitor', async (o: Original) => ({
  ...(await o()), checkTrackingHealth: async () => ({ status: 'ok', issues: [] }),
}))
vi.mock('@/lib/platforms/meta/ad-library-fetcher', async (o: Original) => ({
  ...(await o()), fetchCompetitorAds: async () => 0,
}))
vi.mock('@/lib/competitors/analyze-ad', async (o: Original) => ({
  ...(await o()), analyzeUnprocessedAds: async () => 0,
}))
vi.mock('@/lib/competitors/trend-detector', async (o: Original) => ({
  ...(await o()), snapshotCompetitorAds: async () => 0, detectFormatTrends: async () => [],
}))
vi.mock('@/lib/alerts/detector', async (o: Original) => ({
  ...(await o()), detectTrajectoryAlerts: async () => 0, detectWrongOptimizationEvent: async () => 0,
}))
vi.mock('@/lib/alerts/insert', async (o: Original) => ({
  ...(await o()), insertAlertsDeduped: async () => 0,
}))
vi.mock('@/lib/feedback/loop', async (o: Original) => ({
  ...(await o()), runFeedbackLoop: async () => 0, processFeedbackForCompletedTests: async () => 0,
}))
vi.mock('@/lib/creative/health-score', async (o: Original) => ({
  ...(await o()), runHealthScoresForAccount: async () => 0,
}))
vi.mock('@/lib/diagnostics/drift-check', async (o: Original) => ({
  ...(await o()), runDriftCheck: async () => ({ available: false, reason: 'stubbed' }),
}))
vi.mock('@/lib/learning/outcomes', async (o: Original) => ({
  ...(await o()), evaluateRecommendationOutcomes: async () => ({}),
}))
vi.mock('@/lib/learning/ledger-outcomes', async (o: Original) => ({
  ...(await o()), evaluateLedgerOutcomes: async () => ({}),
}))
vi.mock('@/lib/learning/patterns', async (o: Original) => ({
  ...(await o()), recomputeLearnedPatterns: async () => ({}),
}))
vi.mock('@/lib/report/weekly', async (o: Original) => ({
  ...(await o()),
  generateWeeklyReport: async (
    accountId: string,
    start: string,
    end: string,
    dailyReportId: string,
    options?: { outcomeArrival?: unknown },
  ) => {
    state.generated.push({ accountId, start, end, dailyReportId })
    state.generatedArrivals.push(options?.outcomeArrival ?? null)
    return WEEKLY_REPORT_ID
  },
}))
vi.mock('@/lib/report/weekly-executive-email', async (o: Original) => ({
  ...(await o()),
  renderWeeklyExecutiveHtml: async (digest: { weekly_report_id: string }, dashboardUrl: string) => {
    state.rendered.push({ dashboardUrl, reportId: digest.weekly_report_id })
    return '<!DOCTYPE html><html><body>Diagnostic only.</body></html>'
  },
}))
vi.mock('@/lib/report/weekly-executive-delivery', async (o: Original) => ({
  ...(await o()),
  deliverWeeklyExecutiveSafely: async (request: WeeklyExecutiveDeliveryRequest) => {
    state.events.push('weekly_delivery')
    state.delivered.push(request)
    return { status: 'sent', provider: 'gmail_smtp', provider_message_id: '<sender-fixture@gmail.com>' }
  },
}))

async function runCron(): Promise<Record<string, unknown>> {
  const { GET } = await import('@/app/api/cron/daily-sync/route')
  const response = await GET(new Request('http://localhost/api/cron/daily-sync', {
    headers: { authorization: 'Bearer secret' },
  }))
  return (await response.json() as { steps: Record<string, unknown> }).steps
}

describe('daily-sync weekly executive delivery', () => {
  beforeEach(() => {
    state.weekday = 1
    state.reconciliationComplete = true
    state.committedReport = { id: DAILY_REPORT_ID, reportDate: WEEK_END }
    state.outcomeArrival = null
    state.generatedArrivals = []
    state.generated = []
    state.filters = []
    state.events = []
    state.rendered = []
    state.delivered = []
    vi.stubEnv('META_AD_ACCOUNT_ID', 'act_123')
    vi.stubEnv('VERCEL_PROJECT_PRODUCTION_URL', 'maxx.example.com')
    vi.stubEnv('MAXX_WEEKLY_EXECUTIVE_EMAIL_ENABLED', 'true')
  })

  afterEach(() => vi.unstubAllEnvs())

  it('delivers only the report committed by this Monday run from its exact evidence generation', async () => {
    const steps = await runCron()

    expect(state.generated).toEqual([{
      accountId: AD_ACCOUNT_DB_ID,
      start: WEEK_START,
      end: WEEK_END,
      dailyReportId: DAILY_REPORT_ID,
    }])
    expect(state.filters).toEqual(expect.arrayContaining([
      { table: 'weekly_reports', column: 'id', value: WEEKLY_REPORT_ID },
    ]))
    expect(state.filters.filter((item) => item.table === 'executive_evidence_generations')).toEqual([])
    expect(state.delivered).toEqual([expect.objectContaining({
      reportId: WEEKLY_REPORT_ID,
      weekStart: WEEK_START,
      weekEnd: WEEK_END,
      subject: `Maxx weekly executive read — ${WEEK_START}–${WEEK_END}`,
      text: expect.stringContaining('Diagnostic only'),
      html: expect.stringContaining('Diagnostic only'),
    })])
    expect(state.rendered).toEqual([{
      dashboardUrl: 'https://maxx.example.com', reportId: WEEKLY_REPORT_ID,
    }])
    expect(steps.weekly_executive_delivery).toMatchObject({ status: 'sent' })
    expect(state.events).toEqual(['monitoring', 'weekly_delivery'])
  })

  it('never scans or sends historical weekly reports on a non-Monday run', async () => {
    state.weekday = 2

    const steps = await runCron()

    expect(state.generated).toEqual([])
    expect(state.filters.filter((item) => item.table === 'weekly_reports')).toEqual([])
    expect(state.delivered).toEqual([])
    expect(steps.weekly_executive_delivery).toMatchObject({
      status: 'skipped', reason: 'runs_on_mondays_only',
    })
  })

  it('records an explicit delivery skip when Monday evidence cannot commit a weekly report', async () => {
    state.reconciliationComplete = false

    const steps = await runCron()

    expect(state.generated).toEqual([])
    expect(state.delivered).toEqual([])
    expect(steps.weekly_executive_delivery).toMatchObject({
      status: 'skipped', reason: expect.any(String),
    })
  })

  it('commits the Monday report for push-only outcome sources without a reconciliation, passing how outcomes arrived', async () => {
    state.reconciliationComplete = false
    state.outcomeArrival = { sources: [{ source_id: 'src-webhook', kind: 'webhook', label: 'As received' }] }

    const steps = await runCron()

    expect(state.generated).toEqual([expect.objectContaining({ dailyReportId: DAILY_REPORT_ID })])
    expect(state.generatedArrivals).toEqual([state.outcomeArrival])
    expect(steps.weekly_report).toMatchObject({ id: WEEKLY_REPORT_ID })
  })

  it('passes no arrival label when a reconciled source gated the Monday report (control)', async () => {
    const steps = await runCron()

    expect(state.generatedArrivals).toEqual([null])
    expect(steps.weekly_report).toMatchObject({ id: WEEKLY_REPORT_ID })
  })

  it('commits the Monday report but stays in explicit shadow mode by default', async () => {
    vi.stubEnv('MAXX_WEEKLY_EXECUTIVE_EMAIL_ENABLED', '')

    const steps = await runCron()

    expect(state.generated).toEqual([expect.objectContaining({
      dailyReportId: DAILY_REPORT_ID,
    })])
    expect(state.filters.filter((item) => item.table === 'weekly_reports')).toEqual([])
    expect(state.rendered).toEqual([])
    expect(state.delivered).toEqual([])
    expect(steps.weekly_executive_delivery).toEqual({
      status: 'skipped',
      reason: 'delivery_disabled_shadow_mode',
      mode: 'shadow',
      feature_flag: 'MAXX_WEEKLY_EXECUTIVE_EMAIL_ENABLED',
    })
  })

  it('never substitutes a historical daily report when this run did not commit Sunday', async () => {
    state.committedReport = {
      id: '00000000-0000-4000-8000-000000001097',
      reportDate: '2026-08-08',
    }

    const steps = await runCron()

    expect(state.generated).toEqual([])
    expect(state.filters.filter((item) => item.table === 'weekly_reports')).toEqual([])
    expect(state.delivered).toEqual([])
    expect(steps.weekly_report).toEqual({
      skipped: 'current Sunday evidence report was not committed by this run',
    })
  })
})
