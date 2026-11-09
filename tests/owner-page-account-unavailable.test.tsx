import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Pages now call requireOwner() themselves (src/lib/auth/page-owner.ts); this test measures the
// account boundary, not auth, so the owner check is satisfied up front.
vi.mock('@/lib/auth/page-owner', () => ({ requireOwner: async () => ({ email: 'owner@example.test' }) }))
const state = vi.hoisted(() => ({
  reason: 'ambiguous' as 'not_found' | 'ambiguous' | 'unavailable',
  tableReads: [] as string[],
}))

vi.mock('@/lib/accounts/active-account', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/accounts/active-account')>()
  return {
    ...actual,
    resolveOnlyActiveAccount: vi.fn(async () => ({ ok: false, reason: state.reason })),
  }
})

vi.mock('@/lib/supabase/admin', () => ({
  getAdminClient: () => ({
    from: (table: string) => {
      state.tableReads.push(table)
      throw new Error(`Unexpected account-bearing read: ${table}`)
    },
  }),
}))

vi.mock('@/components/inbox/InboxClient', () => ({
  InboxClient: () => <div data-inbox-client>Healthy inbox</div>,
}))

vi.mock('@/components/ui/UrlDateRangeControl', () => ({
  UrlDateRangeControl: () => <div data-range-control />,
}))

vi.mock('@/lib/ga4/client', () => ({
  getGa4ConfirmationTelemetryByCampaign: vi.fn(),
}))

vi.mock('@/lib/outcomes/business-facts-reader', () => ({ getBusinessFactsForWindow: vi.fn() }))
vi.mock('@/lib/recommendations/setup-ledger', () => ({
  getLedgerForAccount: vi.fn(),
  unresolvedConflicts: vi.fn(),
}))
vi.mock('@/lib/dashboard/attention', () => ({ buildAttention: vi.fn(() => []) }))
vi.mock('@/lib/inbox/group', () => ({ INBOX_REVIEW_KEYS: [] }))
vi.mock('@/lib/authority/diagnostic-surface', () => ({
  projectStoredReport: vi.fn((row) => row),
}))
vi.mock('@/components/report/ReportNarrative', () => ({ ReportNarrative: () => null }))

describe('owner pages do not fabricate a healthy empty account', () => {
  beforeEach(() => {
    state.reason = 'ambiguous'
    state.tableReads = []
  })

  it.each([
    { reason: 'ambiguous' as const, code: 'ACTIVE_ACCOUNT_AMBIGUOUS' },
    { reason: 'unavailable' as const, code: 'ACTIVE_ACCOUNT_UNAVAILABLE' },
  ])('renders $code instead of ordinary empty-state copy', async ({ reason, code }) => {
    state.reason = reason
    const [{ default: ReportsPage }, { default: ChangeLogPage }] = await Promise.all([
      import('@/app/(dashboard)/activity/reports/page'),
      import('@/app/(dashboard)/activity/change-log/page'),
    ])

    const [reports, changeLog] = await Promise.all([
      ReportsPage({ searchParams: Promise.resolve({ range: '1m' }) }),
      ChangeLogPage(),
    ])
    const html = [reports, changeLog].map((node) => renderToStaticMarkup(node)).join('\n')

    expect(html.match(new RegExp(`data-active-account-error="${code}"`, 'g'))).toHaveLength(2)
    expect(html).not.toContain('No reports in this period')
    expect(html).not.toContain('No ad spend in this range')
    expect(html).not.toContain('No decisions yet')
    expect(state.tableReads).toEqual([])
  }, 60_000)
})
