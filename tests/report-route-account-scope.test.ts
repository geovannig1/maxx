import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

type Row = Record<string, unknown>

const state = vi.hoisted(() => ({
  resolution: {
    ok: true as const,
    account: { id: 'account-a', accountId: 'act_A', accountName: 'Studio A' },
  } as
    | { ok: true; account: { id: string; accountId: string; accountName: string | null } }
    | { ok: false; reason: 'not_found' | 'ambiguous' | 'unavailable' },
  rows: {} as Record<string, Row[]>,
  eqCalls: [] as Array<{ table: string; column: string; value: unknown }>,
  fromCalls: [] as string[],
  lineageCalls: [] as Array<{ accountId: string; generationId: string | null }>,
  resolveActive: vi.fn(),
  generate: vi.fn(async () => undefined),
}))

function query(table: string) {
  let rows = [...(state.rows[table] ?? [])]
  const response = () => ({ data: rows, error: null })
  const builder = {
    select: () => builder,
    eq: (column: string, value: unknown) => {
      state.eqCalls.push({ table, column, value })
      rows = rows.filter((row) => row[column] === value)
      return builder
    },
    order: () => builder,
    maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
    then: (
      resolve: (value: ReturnType<typeof response>) => unknown,
      reject?: (reason: unknown) => unknown,
    ) => Promise.resolve(response()).then(resolve, reject),
  }
  return builder
}

const db = {
  from: (table: string) => {
    state.fromCalls.push(table)
    return query(table)
  },
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: async () => ({ data: { user: { id: 'owner', email: 'owner@example.com', email_confirmed_at: '2026-01-01T00:00:00Z' } } }) },
  })),
}))

vi.mock('@/lib/supabase/admin', () => ({
  getAdminClient: vi.fn(() => db),
}))

vi.mock('@/lib/accounts/active-account', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/accounts/active-account')>()
  return {
    ...actual,
    resolveOnlyActiveAccount: state.resolveActive,
  }
})

vi.mock('@/lib/flags/generations', () => ({
  latestRecGenerationForDate: vi.fn(async () => 'generation-a'),
  getRecLineageStatus: vi.fn(async (
    _db: unknown,
    accountId: string,
    generationId: string | null,
  ) => {
    state.lineageCalls.push({ accountId, generationId })
    return {
      state: 'current',
      committedAt: '2026-05-20T12:00:00.000Z',
      parentFlagGeneration: 'flag-a',
    }
  }),
  lineageNotice: vi.fn(() => null),
}))

vi.mock('@/lib/report/generator', () => ({
  generateDailyReport: state.generate,
}))

vi.mock('@/lib/authority/diagnostic-surface', () => ({
  projectStoredReport: (report: Row) => report,
  projectCurrentActionableTasks: (tasks: Row[]) => tasks,
}))

const reportRequest = (queryString = '') => new NextRequest(
  `http://localhost/api/report/2026-05-20${queryString}`,
)

const reportParams = { params: Promise.resolve({ date: '2026-05-20' }) }

describe('report route active-account scope', () => {
  beforeEach(() => {
    // the owner gate fails closed without OWNER_EMAIL, in development too.
    vi.stubEnv('OWNER_EMAIL', 'owner@example.com')
    state.resolution = {
      ok: true,
      account: { id: 'account-a', accountId: 'act_A', accountName: 'Studio A' },
    }
    state.rows = {
      ad_accounts: [
        { id: 'account-a', account_id: 'act_A', is_active: true },
        { id: 'account-b', account_id: 'act_B', is_active: false },
      ],
      daily_reports: [
        {
          id: 'report-a',
          ad_account_id: 'account-a',
          report_date: '2026-05-20',
          recommendation_generation_id: 'generation-a',
          summary_text: 'Studio A report',
        },
        {
          id: 'report-b',
          ad_account_id: 'account-b',
          report_date: '2026-05-20',
          recommendation_generation_id: 'generation-b',
          summary_text: 'Other account report',
        },
      ],
      audit_tasks: [
        { id: 'task-a', ad_account_id: 'account-a', report_id: 'report-a', priority: 'high' },
        { id: 'task-b', ad_account_id: 'account-b', report_id: 'report-b', priority: 'urgent' },
      ],
    }
    state.eqCalls = []
    state.fromCalls = []
    state.lineageCalls = []
    state.resolveActive.mockReset()
    state.resolveActive.mockImplementation(async () => state.resolution)
    state.generate.mockClear()
    vi.stubEnv('META_AD_ACCOUNT_ID', 'act_B')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it.each([
    ['query parameter', '?account_id=act_B'],
    ['environment fallback', ''],
  ])('ignores a guessed inactive account from the %s', async (_source, queryString) => {
    const { GET } = await import('@/app/api/report/[date]/route')
    const response = await GET(reportRequest(queryString), reportParams)
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toMatchObject({
      data: { id: 'report-a', ad_account_id: 'account-a' },
      tasks: [{ id: 'task-a', ad_account_id: 'account-a' }],
      lineage: { state: 'current' },
    })
    expect(JSON.stringify(body)).not.toContain('account-b')
    expect(JSON.stringify(body)).not.toContain('Other account')
    expect(state.fromCalls).not.toContain('ad_accounts')
    expect(state.eqCalls).toEqual(expect.arrayContaining([
      { table: 'daily_reports', column: 'ad_account_id', value: 'account-a' },
      { table: 'audit_tasks', column: 'ad_account_id', value: 'account-a' },
      { table: 'audit_tasks', column: 'report_id', value: 'report-a' },
    ]))
    expect(state.eqCalls).not.toContainEqual(expect.objectContaining({ value: 'account-b' }))
    expect(state.lineageCalls).toEqual([
      { accountId: 'account-a', generationId: 'generation-a' },
    ])
  })

  it('fails closed on a second active account before any report, task, or lineage read', async () => {
    state.resolution = { ok: false, reason: 'ambiguous' }
    state.rows.ad_accounts[1] = { id: 'account-b', account_id: 'act_B', is_active: true }

    const { GET } = await import('@/app/api/report/[date]/route')
    const response = await GET(reportRequest('?account_id=act_B'), reportParams)

    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ code: 'ACTIVE_ACCOUNT_AMBIGUOUS' })
    expect(state.fromCalls).toEqual([])
    expect(state.eqCalls).toEqual([])
    expect(state.lineageCalls).toEqual([])
  })

  it.each([
    ['not_found', 404, 'ACTIVE_ACCOUNT_NOT_FOUND'],
    ['ambiguous', 409, 'ACTIVE_ACCOUNT_AMBIGUOUS'],
    ['unavailable', 503, 'ACTIVE_ACCOUNT_UNAVAILABLE'],
  ] as const)('maps %s account resolution without reading report data', async (reason, status, code) => {
    state.resolution = { ok: false, reason }

    const { GET } = await import('@/app/api/report/[date]/route')
    const response = await GET(reportRequest('?account_id=act_B'), reportParams)

    expect(response.status).toBe(status)
    expect(await response.json()).toMatchObject({ code })
    expect(state.fromCalls).toEqual([])
    expect(state.lineageCalls).toEqual([])
  })

  it.each([
    ['not-a-date', 'Invalid date format. Expected YYYY-MM-DD'],
    ['2999-01-01', 'Cannot request reports for future dates'],
  ])('preserves date validation for %s', async (date, error) => {
    const { GET } = await import('@/app/api/report/[date]/route')
    const response = await GET(reportRequest('?account_id=act_B'), {
      params: Promise.resolve({ date }),
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error })
    expect(state.resolveActive).not.toHaveBeenCalled()
    expect(state.fromCalls).toEqual([])
  })
})
