import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const state = vi.hoisted(() => ({
  generation: null as { id: string } | null,
  generationError: null as { message: string } | null,
  generateDailyReport: vi.fn(async () => ({ committed: true, reason: 'committed' })),
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: async () => ({ data: { user: { id: 'owner', email: 'owner@example.com', email_confirmed_at: '2026-01-01T00:00:00Z' } } }) },
  })),
}))

vi.mock('@/lib/report/generator', () => ({
  generateDailyReport: state.generateDailyReport,
}))

// Active-account ambiguity and account-scoped report reads are covered by
// report-route-account-scope.test.ts. This suite isolates recommendation-pin read health.
vi.mock('@/lib/accounts/active-account', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/accounts/active-account')>()
  return {
    ...actual,
    resolveOnlyActiveAccount: vi.fn(async () => ({
      ok: true,
      account: { id: 'account-a', accountId: 'act_test', accountName: null },
    })),
  }
})

vi.mock('@/lib/supabase/admin', () => ({
  getAdminClient: () => ({
    from: (table: string) => {
      const response = () => {
        if (table === 'ad_accounts') return { data: { id: 'account-a' }, error: null, count: null }
        if (table === 'daily_reports') return { data: null, error: null, count: null }
        if (table === 'daily_insights') return { data: null, error: null, count: 1 }
        if (table === 'decision_generations') {
          return { data: state.generation, error: state.generationError, count: null }
        }
        throw new Error(`Unexpected table: ${table}`)
      }
      const builder = {
        select: () => builder,
        eq: () => builder,
        is: () => builder,
        order: () => builder,
        limit: () => builder,
        maybeSingle: async () => response(),
        then: (
          resolve: (value: ReturnType<typeof response>) => unknown,
          reject?: (reason: unknown) => unknown,
        ) => Promise.resolve(response()).then(resolve, reject),
      }
      return builder
    },
  }),
}))

describe('latest recommendation generation read health', () => {
  beforeEach(() => {
    // the owner gate fails closed without OWNER_EMAIL, in development too.
    vi.stubEnv('OWNER_EMAIL', 'owner@example.com')
    state.generation = null
    state.generationError = null
    state.generateDailyReport.mockClear()
  })

  it('throws on a decision_generations read error instead of returning a null snapshot pin', async () => {
    state.generationError = { message: 'permission denied' }
    const { getAdminClient } = await import('@/lib/supabase/admin')
    const { latestRecGenerationForDate } = await import('@/lib/flags/generations')

    await expect(latestRecGenerationForDate(
      getAdminClient(),
      'account-a',
      '2026-05-20',
    )).rejects.toMatchObject({ code: 'RECOMMENDATION_GENERATION_READ_UNAVAILABLE' })
  })

  it('keeps a healthy zero-row generation read as the legitimate null snapshot path', async () => {
    const { getAdminClient } = await import('@/lib/supabase/admin')
    const { latestRecGenerationForDate } = await import('@/lib/flags/generations')

    await expect(latestRecGenerationForDate(
      getAdminClient(),
      'account-a',
      '2026-05-20',
    )).resolves.toBeNull()
  })
})

describe('report generation route recommendation-pin health', () => {
  beforeEach(() => {
    state.generation = null
    state.generationError = null
    state.generateDailyReport.mockClear()
  })

  const request = () => new NextRequest(
    'http://localhost/api/report/2026-05-20?account_id=act_test',
  )
  const context = { params: Promise.resolve({ date: '2026-05-20' }) }

  it('never starts out-of-band report generation from warehouse rows', async () => {
    const { GET } = await import('@/app/api/report/[date]/route')

    const response = await GET(request(), context)

    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({
      code: 'REPORT_GENERATION_REQUIRES_SYNC',
    })
    expect(state.generateDailyReport).not.toHaveBeenCalled()
  })

  it('does not make a healthy null recommendation pin an authority to generate', async () => {
    const { GET } = await import('@/app/api/report/[date]/route')

    const response = await GET(request(), context)

    expect(response.status).toBe(409)
    expect(state.generateDailyReport).not.toHaveBeenCalled()
  })
})
