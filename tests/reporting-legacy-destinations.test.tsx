import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Pages now call requireOwner() themselves (src/lib/auth/page-owner.ts); this test measures the
// legacy destinations, not auth, so the owner check is satisfied up front.
vi.mock('@/lib/auth/page-owner', () => ({ requireOwner: async () => ({ email: 'owner@example.test' }) }))
const state = vi.hoisted(() => ({
  tables: [] as string[],
  filters: [] as Array<[string, string, unknown]>,
  accountAvailable: true,
}))

const tableData: Record<string, Array<Record<string, unknown>>> = {
  daily_reports: [
    { report_date: '2026-08-20', total_spend: 42, total_bookings: 2, avg_cpb: 21, model_used: 'gpt-5' },
  ],
  recommendation_outcomes: [
    {
      id: 'outcome-1', flag_type: 'creative_refresh', audience_type: 'cold', meta_entity_id: 'ad-1',
      recommendation: 'Test the refreshed opening.', outcome: 'worked', outcome_note: 'Held after review.',
      review_status: 'approved', estimate_only: false, metric_name: 'causal_incremental_contribution',
      category: 'creative', confidence: 'high', active_days: 14, baseline_value: 40, observed_value: 28,
      recommended_on: '2026-08-01',
    },
  ],
  expert_insights: [],
}

function queryFor(table: string) {
  const query: Record<string, unknown> & PromiseLike<{ data: Array<Record<string, unknown>>; error: null }> = {
    select: vi.fn(() => query),
    eq: vi.fn((column: string, value: unknown) => {
      state.filters.push([table, column, value])
      return query
    }),
    gte: vi.fn((column: string, value: unknown) => {
      state.filters.push([table, `gte:${column}`, value])
      return query
    }),
    lte: vi.fn((column: string, value: unknown) => {
      state.filters.push([table, `lte:${column}`, value])
      return query
    }),
    not: vi.fn(() => query),
    order: vi.fn(() => query),
    limit: vi.fn(() => query),
    then: (resolve, reject) => Promise.resolve({ data: tableData[table] ?? [], error: null }).then(resolve, reject),
  }
  return query
}

vi.mock('@/lib/supabase/admin', () => ({
  getAdminClient: () => ({
    from: (table: string) => {
      state.tables.push(table)
      return queryFor(table)
    },
  }),
}))

vi.mock('@/lib/accounts/active-account', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/accounts/active-account')>()),
  resolveOnlyActiveAccount: vi.fn(async () => state.accountAvailable
    ? { ok: true, account: { id: 'account-1', accountId: 'act_123', accountName: 'Studio' } }
    : { ok: false, reason: 'ambiguous' }),
}))

vi.mock('@/lib/recommendations/store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/recommendations/store')>()),
  readOpenRecommendations: vi.fn(async () => ({
    health: 'healthy', recommendations: [], visibleCount: 0, quarantinedCount: 0,
    reasons: [], evidence: new Map(),
  })),
}))

vi.mock('@/lib/recommendations/knowledge', () => ({ getBenchmarkPrior: vi.fn(async () => null) }))
vi.mock('@/components/ui/UrlDateRangeControl', () => ({ UrlDateRangeControl: () => <div data-date-range-control /> }))

describe('legacy reporting destinations', () => {
  beforeEach(() => {
    state.tables = []
    state.filters = []
    state.accountAvailable = true
  })

  it('renders account-scoped daily report history for the exact requested dates', async () => {
    const { default: ReportsPage } = await import('@/app/(dashboard)/activity/reports/page')
    const node = await ReportsPage({ searchParams: Promise.resolve({ from: '2026-08-01', to: '2026-08-31' }) })
    const html = renderToStaticMarkup(node)

    expect(html).toContain('Daily report history')
    expect(html).toContain('href="/reports/2026-08-20"')
    expect(html).toContain('latest 62 stored snapshots within this selected period')
    expect(html).not.toContain('$42.00')
    expect(html).not.toContain('Meta Results')
    expect(state.filters).toEqual(expect.arrayContaining([
      ['daily_reports', 'ad_account_id', 'account-1'],
      ['daily_reports', 'gte:report_date', '2026-08-01'],
      ['daily_reports', 'lte:report_date', '2026-08-31'],
    ]))
  })

  it('renders the account-scoped owner-reviewed learning history', async () => {
    const { default: LearningsPage } = await import('@/app/(dashboard)/activity/learnings/page')
    const html = renderToStaticMarkup(await LearningsPage())

    expect(html).toContain('What Maxx Has Learned')
    expect(html).toContain('creative_refresh')
    expect(html).toContain('Latest 1 evaluated outcome across all dates')
    expect(html).toContain('Owner-reviewed historical context')
    expect(state.filters).toContainEqual(['recommendation_outcomes', 'ad_account_id', 'account-1'])
  })

  it('fails closed before reading learning rows when the active account is ambiguous', async () => {
    state.accountAvailable = false
    const { default: LearningsPage } = await import('@/app/(dashboard)/activity/learnings/page')
    const html = renderToStaticMarkup(await LearningsPage())

    expect(html).toContain('data-active-account-error="ACTIVE_ACCOUNT_AMBIGUOUS"')
    expect(html).not.toContain('No learnings yet')
    expect(state.tables).toEqual([])
  })
})
