import { beforeEach, describe, expect, it, vi } from 'vitest'

import { WEEK_END, WEEK_START, weeklyExecutiveEvidenceFixture } from './fixtures/weekly-executive'

const ACCOUNT_ID = '00000000-0000-4000-8000-000000001080'
const EVIDENCE_ID = '00000000-0000-4000-8000-000000001099'
const DAILY_REPORT_ID = '00000000-0000-4000-8000-000000001098'

const state = vi.hoisted(() => ({
  dailyEvidenceId: null as string | null,
  committedWeeklyId: null as string | null,
  evidenceReads: [] as Array<Record<string, unknown>>,
  commits: [] as Array<Record<string, unknown>>,
  filters: [] as Array<{ table: string; column: string; value: unknown }>,
}))

function resultFor(table: string) {
  if (table === 'daily_reports') {
    return {
      data: state.dailyEvidenceId
        ? { id: DAILY_REPORT_ID, executive_evidence_generation_id: state.dailyEvidenceId }
        : null,
      error: null,
    }
  }
  if (table === 'daily_insights') {
    return {
      data: [{
        spend: 100, leads: 10, bookings: 3, impressions: 10_000,
        reach: 8_000, clicks: 200, appointment_value: 900,
      }],
      error: null,
    }
  }
  return { data: [], error: null }
}

function query(table: string) {
  const chain: Record<string, unknown> = {}
  chain.select = () => chain
  chain.eq = (column: string, value: unknown) => {
    state.filters.push({ table, column, value })
    return chain
  }
  for (const method of ['gte', 'lte', 'limit']) chain[method] = () => chain
  chain.maybeSingle = async () => resultFor(table)
  chain.then = (
    resolve: (value: ReturnType<typeof resultFor>) => unknown,
    reject?: (reason: unknown) => unknown,
  ) => Promise.resolve(resultFor(table)).then(resolve, reject)
  return chain
}

type Original = () => Promise<Record<string, unknown>>

vi.mock('@/lib/supabase/admin', async (o: Original) => ({
  ...(await o()),
  getAdminClient: () => ({
    from: (table: string) => query(table),
    rpc: async (name: string, args: Record<string, unknown>) => {
      if (name !== 'commit_weekly_executive_report') throw new Error(`unexpected RPC ${name}`)
      state.commits.push(args)
      const payload = args.p_payload as Record<string, unknown>
      const committedId = state.committedWeeklyId ?? String(payload.id)
      state.committedWeeklyId = committedId
      return { data: committedId, error: null }
    },
  }),
}))
vi.mock('@/lib/report/executive-evidence-store', async (o: Original) => ({
  ...(await o()),
  readExecutiveEvidenceGeneration: async (_db: unknown, input: Record<string, unknown>) => {
    state.evidenceReads.push(input)
    return weeklyExecutiveEvidenceFixture
  },
}))
vi.mock('@/lib/economics/ad-spend-reader', async (o: Original) => ({
  ...(await o()),
  readAccountSpendWindow: async () => ({
    status: 'available', totalSpend: 100, blockerCodes: [],
  }),
}))
vi.mock('@/lib/ga4/client', async (o: Original) => ({
  ...(await o()),
  getGa4ConfirmationTelemetryBySource: async () => ({ available: false }),
  isMetaPaidChannel: () => false,
}))
vi.mock('@/lib/outcomes/business-facts-reader', async (o: Original) => ({
  ...(await o()), getBusinessFacts: async () => { throw new Error('unavailable in fixture') },
}))
vi.mock('@/lib/learning/brief', async (o: Original) => ({
  ...(await o()),
  buildLearningBrief: async () => null,
  buildDecisionMemoryBrief: async () => null,
}))
vi.mock('@/lib/ga4/booking-reconciliation', async (o: Original) => ({
  ...(await o()), buildGa4ReconciliationBlock: async () => { throw new Error('unavailable in fixture') },
}))
vi.mock('@/lib/economics/pragmatic-profit-evidence', async (o: Original) => ({
  ...(await o()), readMediaBuyerRecommendationsEnabled: async () => false,
}))
vi.mock('@/lib/modes/learning-status', async (o: Original) => ({
  ...(await o()), anyActiveAdsetExitedLearning: async () => false,
}))
vi.mock('@/lib/modes/operating-mode', async (o: Original) => ({
  ...(await o()),
  detectOperatingMode: () => ({
    dataMode: 'sufficient', authority: 'recommendation', label: 'Sufficient data', reason: 'fixture',
  }),
}))
vi.mock('@/lib/report/generator', async (o: Original) => ({
  ...(await o()), generateReport: async () => { throw new Error('No provider configured') },
}))
// No AI provider (the gateway replaced report/providers).
vi.mock('@/lib/ai', async (o: Original) => ({
  ...(await o()), aiStatus: () => ({ state: 'off', inferred: true }), isAiEnabled: () => false,
}))
vi.mock('@/lib/utils/date-utils', async (o: Original) => ({
  ...(await o()), nyToday: () => '2026-08-10',
}))
vi.mock('@/lib/monitoring/alerts', async (o: Original) => ({
  ...(await o()), emitAlert: () => undefined,
}))

describe('generateWeeklyReport evidence-bound publication', () => {
  beforeEach(() => {
    state.dailyEvidenceId = EVIDENCE_ID
    state.committedWeeklyId = null
    state.evidenceReads = []
    state.commits = []
    state.filters = []
  })

  it('fails closed before evidence reads or publication when Sunday has no committed binding', async () => {
    state.dailyEvidenceId = null
    const { generateWeeklyReport } = await import('@/lib/report/weekly')

    await expect(generateWeeklyReport(ACCOUNT_ID, WEEK_START, WEEK_END, DAILY_REPORT_ID))
      .rejects.toThrow(/daily evidence binding unavailable/i)
    expect(state.evidenceReads).toEqual([])
    expect(state.commits).toEqual([])
  })

  it('lets the atomic commit select the stable identity without trusting a pre-read row', async () => {
    const { generateWeeklyReport } = await import('@/lib/report/weekly')

    const firstId = await generateWeeklyReport(ACCOUNT_ID, WEEK_START, WEEK_END, DAILY_REPORT_ID)
    const secondId = await generateWeeklyReport(ACCOUNT_ID, WEEK_START, WEEK_END, DAILY_REPORT_ID)

    expect(secondId).toBe(firstId)
    expect(state.commits).toHaveLength(2)
    const proposedIds = state.commits.map((call) => (call.p_payload as Record<string, unknown>).id)
    expect(proposedIds[0]).toBe(firstId)
    expect(proposedIds[1]).not.toBe(firstId)
  })

  it('persists a weekly digest whose identity exactly matches its row and completed week', async () => {
    const { generateWeeklyReport } = await import('@/lib/report/weekly')
    const reportId = await generateWeeklyReport(ACCOUNT_ID, WEEK_START, WEEK_END, DAILY_REPORT_ID)
    const payload = state.commits[0].p_payload as Record<string, unknown>
    const reportJson = payload.report_json as {
      weeklyDigest: { weekly_report_id: string; week_start: string; week_end: string }
    }

    expect(payload.id).toBe(reportId)
    expect(reportJson.weeklyDigest).toMatchObject({
      weekly_report_id: reportId, week_start: WEEK_START, week_end: WEEK_END,
    })
  })

  it('persists and reads the exact Sunday executive-evidence generation', async () => {
    const { generateWeeklyReport } = await import('@/lib/report/weekly')
    await generateWeeklyReport(ACCOUNT_ID, WEEK_START, WEEK_END, DAILY_REPORT_ID)

    const payload = state.commits[0].p_payload as Record<string, unknown>
    expect(payload.executive_evidence_generation_id).toBe(EVIDENCE_ID)
    expect(state.evidenceReads).toEqual([
      { id: EVIDENCE_ID, accountId: ACCOUNT_ID, reportDate: WEEK_END },
    ])
    expect(state.filters).toEqual(expect.arrayContaining([
      { table: 'daily_reports', column: 'id', value: DAILY_REPORT_ID },
      { table: 'daily_reports', column: 'ad_account_id', value: ACCOUNT_ID },
      { table: 'daily_reports', column: 'report_date', value: WEEK_END },
    ]))
  })

  it('records how push-only outcomes arrived, with no completeness wording, and nothing otherwise', async () => {
    const { generateWeeklyReport } = await import('@/lib/report/weekly')
    const arrival = { sources: [{ source_id: 'src-csv', kind: 'csv', label: 'As imported' }] }
    await generateWeeklyReport(ACCOUNT_ID, WEEK_START, WEEK_END, DAILY_REPORT_ID)
    await generateWeeklyReport(ACCOUNT_ID, WEEK_START, WEEK_END, DAILY_REPORT_ID, { outcomeArrival: arrival })

    const [plain, pushOnly] = state.commits.map((call) => call.p_payload as {
      full_report_md: string
      report_json: Record<string, unknown>
    })
    expect(plain.report_json).not.toHaveProperty('outcome_arrival')
    expect(pushOnly.report_json.outcome_arrival).toEqual(arrival)
    // the money basis differs only in the explicit source completeness it now states.
    expect(pushOnly.report_json.money_basis).toEqual({ ...(plain.report_json.money_basis as Record<string, unknown>), source_completeness: 'as_received' })
    expect((plain.report_json.money_basis as Record<string, unknown>).source_completeness).toBe('reconciled')
    expect(pushOnly.full_report_md).toContain('As imported')
    expect(plain.full_report_md).not.toContain('As imported')
    expect(pushOnly.full_report_md.slice(plain.full_report_md.length)).not.toMatch(/reconcil|complete/i)
  })

  it('returns the row identity selected by the atomic commit when another invocation won the race', async () => {
    state.committedWeeklyId = '00000000-0000-4000-8000-000000001081'
    const { generateWeeklyReport } = await import('@/lib/report/weekly')

    await expect(generateWeeklyReport(ACCOUNT_ID, WEEK_START, WEEK_END, DAILY_REPORT_ID))
      .resolves.toBe(state.committedWeeklyId)
    expect((state.commits[0].p_payload as Record<string, unknown>).id)
      .not.toBe(state.committedWeeklyId)
  })
})
