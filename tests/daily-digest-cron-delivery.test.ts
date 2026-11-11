import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { DailyDigestDeliveryRequest } from '@/lib/report/daily-digest-delivery'
import { maximalDigestFixture } from './fixtures/daily-digest-v2'

/**
 * Step 18 exercised through the REAL route handler. The render seam is the only thing under test,
 * so every other step is stubbed away — but the digest reader, the v2 predicate and (unless a test
 * says otherwise) the real HTML renderer are NOT stubbed: whether a snapshot is v2, and what its
 * HTML contains, are exactly the facts these tests exist to check.
 */

const REPORT_ID = '00000000-0000-4000-8000-000000000941'
const AD_ACCOUNT_DB_ID = '00000000-0000-4000-8000-0000000000ad'
const REPORT_DATE = maximalDigestFixture.report_date

const v1Snapshot = {
  contract_version: 1,
  report_date: REPORT_DATE,
  generated_from: 'committed_report_facts',
  action_authority_tier: 'diagnostic_only',
  prescriptions: [],
  change_reporting_threshold_pct: 20,
  subject: `Maxx daily digest — ${REPORT_DATE}`,
  markdown: '# Daily digest\n\nNothing broke.',
}

const state = vi.hoisted(() => ({
  reportJson: null as Record<string, unknown> | null,
  metaOutcomeComplete: true,
  outcomeDependentCalls: [] as string[],
  monitoringOptions: [] as Array<Record<string, unknown>>,
  driftOptions: [] as Array<Record<string, unknown>>,
  renderThrows: false,
  /** Never settles, so the render deadline is the only thing that can end the step. */
  renderHangs: false,
  /** Forces the rendered string, so the seam's size/emptiness guards can be driven directly. */
  renderOverride: null as string | null,
  renderCalls: [] as Array<{ dashboardUrl: string }>,
  delivered: [] as DailyDigestDeliveryRequest[],
  syncLogUpdates: [] as Array<{ logId: string; update: Record<string, unknown> }>,
  /** Forces the delivery seam to fail so the partial-downgrade path is exercised. */
  deliverThrows: false,
}))

function queryChain(table: string) {
  const chain: Record<string, unknown> = {}
  for (const method of ['select', 'eq', 'not', 'order', 'limit', 'gte', 'lte']) {
    chain[method] = () => chain
  }
  chain.maybeSingle = async () => (table === 'ad_accounts'
    ? { data: { id: AD_ACCOUNT_DB_ID, platform: 'meta' }, error: null }
    : { data: { id: REPORT_ID, report_json: state.reportJson }, error: null })
  chain.then = (resolve: (value: { data: Array<Record<string, unknown>>; error: null }) => unknown) =>
    Promise.resolve(resolve({
      data: table === 'adsets' ? [{ adset_id: '100000000000000003' }] : [],
      error: null,
    }))
  return chain
}

/** Every stub is PARTIAL: these modules are imported transitively too, and replacing one wholesale
 *  would strip exports some unrelated module depends on at import time. */
type Original = () => Promise<Record<string, unknown>>

vi.mock('@/lib/auth/cron-secret', async (o: Original) => ({
  ...(await o()),
  checkCronAuthorization: () => 'authorized',
}))
vi.mock('@/lib/supabase/admin', async (o: Original) => ({
  ...(await o()),
  getAdminClient: () => ({ from: (table: string) => queryChain(table) }),
}))
vi.mock('@/lib/sync/log-sync', async (o: Original) => ({
  ...(await o()),
  updateSyncLog: async (logId: string, update: Record<string, unknown>) => {
    state.syncLogUpdates.push({ logId, update })
  },
}))

vi.mock('@/lib/sync/orchestrator', async (o: Original) => ({
  ...(await o()),
  runDailySync: async () => ({
    logId: 'log-1',
    success: true,
    committedReport: { id: REPORT_ID, reportDate: REPORT_DATE },
    metaOutcomeMetricsComplete: state.metaOutcomeComplete,
    metaOutcomeBlockerCodes: state.metaOutcomeComplete ? [] : ['meta_outcome_ad_source_unavailable'],
  }),
}))

// Every remaining step is inert: step 18 must be reached with no real IO in front of it.
vi.mock('@/lib/cron/time-budget', async (o: Original) => ({ ...(await o()), budgetExceeded: () => true }))
vi.mock('@/lib/utils/date-utils', async (o: Original) => ({
  ...(await o()),
  nyToday: () => REPORT_DATE,
  nyWeekday: () => 3,
  nyDaysAgo: () => '2026-08-11',
}))
vi.mock('@/lib/monitoring/alerts', async (o: Original) => ({ ...(await o()), emitAlert: () => undefined }))
vi.mock('@/lib/monitoring/run', async (o: Original) => ({
  ...(await o()),
  runMonitoringChecks: async (_accountId: string, options: Record<string, unknown>) => {
    state.monitoringOptions.push(options)
    return {}
  },
}))
vi.mock('@/lib/creative/vision-analyzer', async (o: Original) => ({
  ...(await o()),
  runVisionAnalysisForPending: async () => 0,
}))
vi.mock('@/lib/platforms/meta/fetch-breakdowns', async (o: Original) => ({
  ...(await o()),
  fetchBreakdowns: async () => {
    state.outcomeDependentCalls.push('breakdowns')
    return []
  },
  upsertBreakdowns: async () => 0,
}))
vi.mock('@/lib/platforms/meta/fetch-daypart', async (o: Original) => ({
  ...(await o()),
  fetchDaypartInsights: async () => {
    state.outcomeDependentCalls.push('daypart')
    return []
  },
  upsertDaypartInsights: async () => 0,
}))
vi.mock('@/lib/tests/monitor', async (o: Original) => ({ ...(await o()), runTestMonitor: async () => ({}) }))
vi.mock('@/lib/signals/fetcher', async (o: Original) => ({ ...(await o()), runSignalsFetcher: async () => ({}) }))
vi.mock('@/lib/tracking/health-monitor', async (o: Original) => ({
  ...(await o()),
  checkTrackingHealth: async () => ({ status: 'ok', issues: [] }),
}))
vi.mock('@/lib/platforms/meta/ad-library-fetcher', async (o: Original) => ({
  ...(await o()),
  fetchCompetitorAds: async () => 0,
}))
vi.mock('@/lib/competitors/analyze-ad', async (o: Original) => ({
  ...(await o()),
  analyzeUnprocessedAds: async () => 0,
}))
vi.mock('@/lib/competitors/trend-detector', async (o: Original) => ({
  ...(await o()),
  snapshotCompetitorAds: async () => 0,
  detectFormatTrends: async () => [],
}))
vi.mock('@/lib/alerts/detector', async (o: Original) => ({
  ...(await o()),
  detectTrajectoryAlerts: async () => {
    state.outcomeDependentCalls.push('trajectory')
    return 0
  },
  detectWrongOptimizationEvent: async () => 0,
}))
vi.mock('@/lib/alerts/insert', async (o: Original) => ({ ...(await o()), insertAlertsDeduped: async () => 0 }))
vi.mock('@/lib/feedback/loop', async (o: Original) => ({
  ...(await o()),
  runFeedbackLoop: async () => 0,
  processFeedbackForCompletedTests: async () => 0,
}))
vi.mock('@/lib/creative/health-score', async (o: Original) => ({
  ...(await o()),
  runHealthScoresForAccount: async () => {
    state.outcomeDependentCalls.push('health_scores')
    return 0
  },
}))
vi.mock('@/lib/diagnostics/drift-check', async (o: Original) => ({
  ...(await o()),
  runDriftCheck: async (_accountId: string, options: Record<string, unknown>) => {
    state.driftOptions.push(options)
    return { available: false, reason: 'stubbed' }
  },
}))
vi.mock('@/lib/learning/outcomes', async (o: Original) => ({
  ...(await o()),
  evaluateRecommendationOutcomes: async () => {
    state.outcomeDependentCalls.push('recommendation_outcomes')
    return {}
  },
}))
vi.mock('@/lib/learning/ledger-outcomes', async (o: Original) => ({
  ...(await o()),
  evaluateLedgerOutcomes: async () => {
    state.outcomeDependentCalls.push('ledger_outcomes')
    return {}
  },
}))
vi.mock('@/lib/learning/patterns', async (o: Original) => ({
  ...(await o()),
  recomputeLearnedPatterns: async () => {
    state.outcomeDependentCalls.push('learned_patterns')
    return {}
  },
}))
vi.mock('@/lib/report/weekly', async (o: Original) => ({
  ...(await o()),
  generateWeeklyReport: async () => 'weekly-1',
}))

vi.mock('@/lib/report/daily-digest-email', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/report/daily-digest-email')>()
  return {
    ...actual,
    renderDailyDigestHtml: async (
      digest: Parameters<typeof actual.renderDailyDigestHtml>[0],
      dashboardUrl: string,
    ) => {
      state.renderCalls.push({ dashboardUrl })
      if (state.renderThrows) throw new Error('render exploded')
      if (state.renderHangs) return new Promise<string>(() => {})
      if (state.renderOverride !== null) return state.renderOverride
      return actual.renderDailyDigestHtml(digest, dashboardUrl)
    },
  }
})

vi.mock('@/lib/report/daily-digest-delivery', async (o: Original) => ({
  ...(await o()),
  deliverDailyDigestSafely: async (request: DailyDigestDeliveryRequest) => {
    state.delivered.push(request)
    if (state.deliverThrows) throw new Error('smtp unavailable')
    return { status: 'sent', provider: 'gmail_smtp', provider_message_id: '<sender-fixture@gmail.com>' }
  },
}))

async function runCron(): Promise<Record<string, unknown>> {
  const { GET } = await import('@/app/api/cron/daily-sync/route')
  const response = await GET(new Request('http://localhost/api/cron/daily-sync', {
    headers: { authorization: 'Bearer secret' },
  }))
  const body = await response.json() as { steps: Record<string, unknown> }
  return body.steps
}

describe('daily-sync step 18 html rendering', () => {
  beforeEach(() => {
    state.reportJson = null
    state.metaOutcomeComplete = true
    state.outcomeDependentCalls = []
    state.monitoringOptions = []
    state.driftOptions = []
    state.renderThrows = false
    state.renderHangs = false
    state.renderOverride = null
    state.renderCalls = []
    state.delivered = []
    state.syncLogUpdates = []
    state.deliverThrows = false
    vi.stubEnv('META_AD_ACCOUNT_ID', 'act_123')
    vi.stubEnv('MAXX_DAILY_EXECUTIVE_EMAIL_ENABLED', 'true')
    // Neither Vercel URL env exists off-platform; individual tests opt in.
    vi.stubEnv('VERCEL_PROJECT_PRODUCTION_URL', '')
    vi.stubEnv('VERCEL_URL', '')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.useRealTimers()
  })


  it('renders a committed V3 snapshot and delivers it as an html part beside the text', async () => {
    state.reportJson = { dailyDigest: maximalDigestFixture }

    const steps = await runCron()

    expect(state.delivered).toHaveLength(1)
    const [request] = state.delivered
    expect(typeof request.html).toBe('string')
    expect(request.html).toContain(maximalDigestFixture.states.business.line)
    // The text part is never displaced by the html one.
    expect(request.markdown).toBe(maximalDigestFixture.markdown)
    expect(request.reportId).toBe(REPORT_ID)
    expect(steps.daily_digest).toMatchObject({ status: 'sent' })
  })

  it('commits the V3 report but stays in explicit shadow mode by default', async () => {
    state.reportJson = { dailyDigest: maximalDigestFixture }
    vi.stubEnv('MAXX_DAILY_EXECUTIVE_EMAIL_ENABLED', '')

    const steps = await runCron()

    expect(state.renderCalls).toEqual([])
    expect(state.delivered).toEqual([])
    expect(steps.daily_digest).toEqual({
      status: 'skipped',
      reason: 'delivery_disabled_shadow_mode',
      mode: 'shadow',
      feature_flag: 'MAXX_DAILY_EXECUTIVE_EMAIL_ENABLED',
    })
  })

  it('does not run downstream jobs that could learn false zero outcomes when Meta outcomes are unavailable', async () => {
    state.reportJson = { dailyDigest: maximalDigestFixture }
    state.metaOutcomeComplete = false

    const steps = await runCron()

    expect(state.outcomeDependentCalls).toEqual([])
    expect(state.monitoringOptions).toEqual([{ metaOutcomeMetricsComplete: false }])
    expect(state.driftOptions).toEqual([{ raiseAlert: true, includeBookings: false }])
    for (const key of [
      'breakdowns',
      'health_scores',
      'trajectory_alerts',
      'daypart',
      'recommendation_outcomes',
      'ledger_outcomes',
      'learned_patterns',
    ]) {
      expect(steps[key]).toMatchObject({
        skipped: 'current Meta outcome metrics unavailable',
      })
    }
  })

  it('sends TEXT-ONLY and still reports sent when the html render throws', async () => {
    state.reportJson = { dailyDigest: maximalDigestFixture }
    state.renderThrows = true

    const steps = await runCron()

    expect(state.renderCalls).toHaveLength(1)
    expect(state.delivered).toHaveLength(1)
    const [request] = state.delivered
    expect('html' in request).toBe(false)
    expect(request.markdown).toBe(maximalDigestFixture.markdown)
    // Email can neither block nor corrupt the sync: the step still reports its delivery result.
    expect(steps.daily_digest).toMatchObject({ status: 'sent' })
  })

  it('keeps a historical v1 snapshot readable but never resends it as current evidence', async () => {
    state.reportJson = { dailyDigest: v1Snapshot }

    const steps = await runCron()

    expect(state.renderCalls).toHaveLength(0)
    expect(state.delivered).toEqual([])
    expect(steps.daily_digest).toMatchObject({
      status: 'skipped',
      reason: 'legacy_digest_not_deliverable',
    })
  })

  it('degrades an oversized render to text-only instead of dropping the whole digest', async () => {
    state.reportJson = { dailyDigest: maximalDigestFixture }
    // One byte past the 90_000-byte runtime budget.
    state.renderOverride = 'a'.repeat(90_001)

    const steps = await runCron()

    expect(state.delivered).toHaveLength(1)
    // The owner still gets the email. Passing this html on would have failed validRequest and
    // returned `failed` with NO email sent and nothing claimed to retry.
    expect('html' in state.delivered[0]).toBe(false)
    expect(state.delivered[0].markdown).toBe(maximalDigestFixture.markdown)
    expect(steps.daily_digest).toMatchObject({ status: 'sent' })
  })

  it('keeps a render that lands exactly on the byte budget', async () => {
    state.reportJson = { dailyDigest: maximalDigestFixture }
    state.renderOverride = 'a'.repeat(90_000)

    await runCron()

    // Pins the boundary as `>` and not `>=`, so the budget is usable to its last byte.
    expect(state.delivered[0].html).toHaveLength(90_000)
  })

  it('degrades an empty render to text-only', async () => {
    state.reportJson = { dailyDigest: maximalDigestFixture }
    state.renderOverride = ''

    const steps = await runCron()

    expect(state.delivered).toHaveLength(1)
    expect('html' in state.delivered[0]).toBe(false)
    expect(steps.daily_digest).toMatchObject({ status: 'sent' })
  })

  it('links the CTA to Vercel-supplied hosts, preferring the production URL', async () => {
    state.reportJson = { dailyDigest: maximalDigestFixture }
    vi.stubEnv('VERCEL_PROJECT_PRODUCTION_URL', 'maxx.example.com')
    vi.stubEnv('VERCEL_URL', 'maxx-abc123.vercel.app')

    await runCron()

    // Vercel supplies these bare, so the scheme has to be added for the template to link them.
    expect(state.renderCalls[0].dashboardUrl).toBe('https://maxx.example.com')
    expect(state.delivered[0].html).toContain('href="https://maxx.example.com"')
    expect(state.delivered[0].html).toContain('Open the dashboard')
  })

  it('falls back to VERCEL_URL when no production URL is set', async () => {
    state.reportJson = { dailyDigest: maximalDigestFixture }
    vi.stubEnv('VERCEL_URL', 'maxx-abc123.vercel.app')

    await runCron()

    expect(state.renderCalls[0].dashboardUrl).toBe('https://maxx-abc123.vercel.app')
  })

  it('omits the CTA entirely when neither Vercel env is present', async () => {
    state.reportJson = { dailyDigest: maximalDigestFixture }

    await runCron()

    // The empty string is what makes the template drop the block — pinned because item 3 made the
    // rendered output depend on it.
    expect(state.renderCalls[0].dashboardUrl).toBe('')
    expect(state.delivered[0].html).not.toContain('Open the dashboard')
    expect(state.delivered[0].html).not.toMatch(/<a\s/i)
  })

  it('bounds a hung render on a deadline and sends text-only', async () => {
    // A past failure was ONE unbounded step consuming the 300s cron budget and
    // silently killing every step ordered after it. The digest render must not be able to do that.
    state.reportJson = { dailyDigest: maximalDigestFixture }
    state.renderHangs = true
    // Only setTimeout is faked: the seam's deadline is a setTimeout, while the dynamic import and
    // the mocked steps need the real event loop to make progress.
    vi.useFakeTimers({ toFake: ['setTimeout'] })

    const running = runCron()
    for (let tick = 0; tick < 200 && state.renderCalls.length === 0; tick += 1) {
      await new Promise((resolve) => { setImmediate(resolve) })
    }
    expect(state.renderCalls).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(10_001)
    const steps = await running

    expect(state.delivered).toHaveLength(1)
    expect('html' in state.delivered[0]).toBe(false)
    expect(state.delivered[0].markdown).toBe(maximalDigestFixture.markdown)
    expect(steps.daily_digest).toMatchObject({ status: 'sent' })
  })

  it('mirrors completed steps into error_details so a hard kill leaves a trail', async () => {
    state.reportJson = { weeklyDigest: null, dailyDigest: maximalDigestFixture }
    await runCron()

    // Every flush carries the running step ledger. Before this, `steps` lived only in the HTTP
    // response body, which the Vercel cron discards — a 300s kill left no trace anywhere.
    expect(state.syncLogUpdates.length).toBeGreaterThan(0)
    for (const { logId } of state.syncLogUpdates) expect(logId).toBe('log-1')

    const last = state.syncLogUpdates[state.syncLogUpdates.length - 1]
    const details = last.update.errorDetails as {
      completed_steps: string[]; last_completed_step: string | null; cron_completed?: boolean
    }
    expect(details.cron_completed).toBe(true)
    expect(details.completed_steps).toContain('daily_digest')
    expect(details.last_completed_step).not.toBeNull()
  })

  it('downgrades the run to partial when a committed-evidence delivery fails', async () => {
    state.reportJson = { weeklyDigest: null, dailyDigest: maximalDigestFixture }
    state.deliverThrows = true
    await runCron()

    const downgraded = state.syncLogUpdates.filter((u) => u.update.status === 'partial')
    expect(downgraded.length).toBe(1)
    expect(String(downgraded[0].update.errorMessage)).toContain('daily_digest')
  })
})
