import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { weeklyExecutiveEvidenceFixture } from './fixtures/weekly-executive'

const state = vi.hoisted(() => ({
  tables: [] as string[],
  dailyInsightsError: true,
  weeklyUpserts: 0,
  weeklyCommits: 0,
}))
const getPerCampaignRoas = vi.hoisted(() => vi.fn())
const BOUND_DAILY_REPORT_ID = '00000000-0000-4000-8000-000000001098'

type QueryResult = {
  data: Record<string, unknown> | Record<string, unknown>[] | null
  error: { message: string } | null
}

function resultFor(table: string, single = false): QueryResult {
  if (table === 'daily_insights' && state.dailyInsightsError) {
    return { data: null, error: { message: 'daily insights offline' } }
  }
  if (table === 'daily_reports') {
    return {
      data: single ? {
        id: BOUND_DAILY_REPORT_ID,
        executive_evidence_generation_id: 'evidence-generation-1',
      } : [],
      error: null,
    }
  }
  if (table === 'weekly_reports') return { data: null, error: null }
  return { data: [], error: null }
}

function queryFor(table: string) {
  const query: Record<string, unknown> & PromiseLike<QueryResult> = {
    select: vi.fn(() => query),
    eq: vi.fn(() => query),
    gte: vi.fn(() => query),
    lte: vi.fn(() => query),
    order: vi.fn(() => query),
    limit: vi.fn(() => query),
    in: vi.fn(() => query),
    upsert: vi.fn(() => {
      if (table === 'weekly_reports') state.weeklyUpserts += 1
      return query
    }),
    maybeSingle: vi.fn(async () => resultFor(table, true)),
    then: (resolve, reject) => Promise.resolve(resultFor(table)).then(resolve, reject),
  }
  return query
}

// The client report page repeats the owner check itself (it renders with the service-role client).
// Supply an owner session so this test keeps measuring read-failure safety, not auth.
process.env.OWNER_EMAIL ||= 'owner@example.test'
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { email: process.env.OWNER_EMAIL, email_confirmed_at: '2026-01-01T00:00:00Z' } } }) } }),
}))
vi.mock('@/lib/supabase/admin', () => ({
  getAdminClient: () => ({
    from: (table: string) => {
      state.tables.push(table)
      return queryFor(table)
    },
    rpc: async (name: string, args: Record<string, unknown>) => {
      if (name !== 'commit_weekly_executive_report') throw new Error(`unexpected RPC ${name}`)
      state.weeklyCommits += 1
      return { data: String((args.p_payload as Record<string, unknown>).id), error: null }
    },
  }),
}))

vi.mock('@/lib/accounts/active-account', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/accounts/active-account')>()
  return {
    ...actual,
    resolveOnlyActiveAccount: vi.fn(async () => ({
      ok: true,
      account: { id: 'account-1', accountName: 'Example Studio' },
    })),
  }
})

vi.mock('@/lib/ga4/client', () => ({
  isMetaPaidChannel: vi.fn(() => true),
  getGa4ConfirmationTelemetryByCampaign: vi.fn(async () => ({
    available: true,
    rows: [],
    totals: { confirmationEvents: 0, eventValue: 0 },
  })),
  getGa4ConfirmationTelemetryBySource: vi.fn(async () => ({
    available: true,
    paid: { confirmationEvents: 2, eventValue: 200 },
    organic: { confirmationEvents: 3, eventValue: 300 },
    metaPaid: { confirmationEvents: 2, eventValue: 200 },
  })),
  getGa4TrafficBySource: vi.fn(async () => ({ available: false })),
}))

vi.mock('@/lib/outcomes/business-facts-reader', () => ({
  getBusinessFacts: vi.fn(async () => { throw new Error('outcome ledger offline') }),
  getBusinessFactsForWindow: vi.fn(async () => { throw new Error('outcome ledger offline') }),
}))
vi.mock('@/lib/report/executive-evidence-store', () => ({
  readExecutiveEvidenceGeneration: vi.fn(async () => weeklyExecutiveEvidenceFixture),
}))
vi.mock('@/lib/analytics/campaign-roas', () => ({
  getPerCampaignRoas,
}))
vi.mock('@/components/ui/UrlDateRangeControl', () => ({ UrlDateRangeControl: () => null }))
vi.mock('@/components/report/ReportNarrative', () => ({ ReportNarrative: () => null }))
vi.mock('@/lib/authority/diagnostic-surface', () => ({
  projectStoredReport: vi.fn((row) => row),
  projectGeneratedReportNarrative: vi.fn((text) => text),
}))

describe('report database read failures fail closed', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    state.tables = []
    state.dailyInsightsError = true
    state.weeklyUpserts = 0
    state.weeklyCommits = 0
    getPerCampaignRoas.mockRejectedValue(new Error('campaign reads offline'))
  })

  it('publishes the weekly report only from bound evidence without a parallel daily_insights read', async () => {
    const { generateWeeklyReport } = await import('@/lib/report/weekly')

    await expect(generateWeeklyReport(
      'account-1',
      '2026-08-03',
      '2026-08-09',
      BOUND_DAILY_REPORT_ID,
    ))
      .resolves.toMatch(/^[0-9a-f-]{36}$/i)
    expect(state.tables).not.toContain('daily_insights')
    expect(state.weeklyUpserts).toBe(0)
    expect(state.weeklyCommits).toBe(1)
  })

  it('keeps stored daily report history reachable through the legacy destination', async () => {
    const { default: ReportsPage } = await import('@/app/(dashboard)/activity/reports/page')
    const node = await ReportsPage({ searchParams: Promise.resolve({ range: '1m' }) })
    expect(renderToStaticMarkup(node)).toContain('No reports in this period')
    expect(state.tables).toContain('daily_reports')
  })

  it('renders client delivery and Acuity totals as unavailable, never $0 or 100%', async () => {
    const { default: ClientReportPage } = await import('@/app/report/client/page')
    const node = await ClientReportPage({ searchParams: Promise.resolve({ range: '1m' }) })
    const html = renderToStaticMarkup(node)

    expect(html).toMatch(/Ad spend<\/div><div[^>]*>unavailable/i)
    expect(html).toMatch(/Total business[^<]*UNAVAILABLE/i)
    expect(html).not.toMatch(/Total business[\s\S]{0,500}>\$0</i)
    expect(html).not.toMatch(/Total business[\s\S]{0,700}>100%</i)
  })

  it('keeps the campaign panel visible and labels a read failure unavailable', async () => {
    const { CampaignRoasPanel } = await import('@/components/dashboard/CampaignRoasPanel')
    const node = await CampaignRoasPanel()
    const html = renderToStaticMarkup(node)

    expect(html).toMatch(/Campaign performance unavailable/i)
    expect(html).not.toMatch(/No campaign spend in this window/i)
  })

  it('reserves the no-spend message for a successful authoritative zero-spend read', async () => {
    getPerCampaignRoas.mockResolvedValue({
      ga4Available: false,
      rows: [],
      campaign_spend_complete: true,
      campaign_spend_reason: null,
      spend_basis: 'account_level_insights',
      campaign_mapping_complete: true,
      campaign_mapping_reason: null,
      attribution_scope: 'unavailable',
      attribution_scope_reason: 'no appointments',
      unattributed: { ga4_confirmation_events: 0, ga4_event_value: 0 },
      account: { meta_spend: 0, ga4_confirmation_events: 0, ga4_event_value: 0, mer: null },
      attributed_share: null,
      paid: {
        ga4_confirmation_events: 0,
        ga4_event_value: 0,
        exact_value_bearing_bookings: null,
        exact_booked_value: null,
        exact_checkout_revenue: null,
        roas: null,
      },
      meta_view_through_share: null,
    })
    const { CampaignRoasPanel } = await import('@/components/dashboard/CampaignRoasPanel')
    const node = await CampaignRoasPanel()
    const html = renderToStaticMarkup(node)

    expect(html).toMatch(/No campaign spend in this window/i)
    expect(html).not.toMatch(/Campaign performance unavailable/i)
  })
})
