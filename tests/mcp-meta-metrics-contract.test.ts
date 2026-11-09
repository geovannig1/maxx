import { beforeEach, describe, expect, it, vi } from 'vitest'

type Row = Record<string, unknown>

const state = vi.hoisted(() => ({
  resolution: { ok: true, account: { id: 'account-a', accountId: 'act_1', accountName: 'Studio A' } } as
    | { ok: true; account: { id: string; accountId: string; accountName: string | null } }
    | { ok: false; reason: 'not_found' | 'ambiguous' | 'unavailable' },
  rows: {
    ad_accounts: [] as Row[],
    daily_insights: [] as Row[],
    campaigns: [] as Row[],
    alerts: [] as Row[],
  },
  calls: [] as Array<{ table: string; op: string; column: string; value: unknown }>,
}))

vi.mock('@/lib/accounts/active-account', () => ({
  resolveOnlyActiveAccount: vi.fn(async () => state.resolution),
  activeAccountErrorCode: (reason: string) => `ACTIVE_ACCOUNT_${reason.toUpperCase()}`,
}))

vi.mock('@/mcp/lib/rate-limit', () => ({ checkRateLimit: vi.fn() }))

vi.mock('@/mcp/lib/supabase', () => ({
  getSupabaseClient: () => ({
    from: (table: keyof typeof state.rows) => {
      let rows = [...state.rows[table]]
      const response = () => ({ data: rows, error: null })
      const builder = {
        select() { return builder },
        eq(column: string, value: unknown) {
          state.calls.push({ table, op: 'eq', column, value })
          rows = rows.filter((row) => row[column] === value)
          return builder
        },
        gte(column: string, value: unknown) {
          state.calls.push({ table, op: 'gte', column, value })
          rows = rows.filter((row) => String(row[column] ?? '') >= String(value))
          return builder
        },
        lte(column: string, value: unknown) {
          state.calls.push({ table, op: 'lte', column, value })
          rows = rows.filter((row) => String(row[column] ?? '') <= String(value))
          return builder
        },
        in(column: string, values: unknown[]) {
          state.calls.push({ table, op: 'in', column, value: values })
          rows = rows.filter((row) => values.includes(row[column]))
          return builder
        },
        order() { return builder },
        limit(value: number) {
          rows = rows.slice(0, value)
          return builder
        },
        maybeSingle() {
          return Promise.resolve({ data: rows[0] ?? null, error: null })
        },
        then(
          resolve: (value: ReturnType<typeof response>) => unknown,
          reject?: (reason: unknown) => unknown,
        ) {
          return Promise.resolve(response()).then(resolve, reject)
        },
      }
      return builder
    },
  }),
}))

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-08-21T16:00:00.000Z'))
  vi.clearAllMocks()
  state.calls = []
  state.resolution = { ok: true, account: { id: 'account-a', accountId: 'act_1', accountName: 'Studio A' } }
  state.rows.ad_accounts = [{
    id: 'account-a',
    account_id: 'act_1',
    account_name: 'Studio A',
    currency: 'USD',
    timezone_name: 'America/New_York',
    is_active: true,
    last_synced_at: '2026-08-21T06:00:00.000Z',
  }]
  state.rows.campaigns = [{
    id: 'campaign-db-1',
    ad_account_id: 'account-a',
    campaign_id: '2381',
    campaign_name: 'Bookings Campaign',
    status: 'ACTIVE',
    effective_status: 'ACTIVE',
    objective: 'OUTCOME_LEADS',
    daily_budget: 9000,
    lifetime_budget: null,
  }]
  state.rows.alerts = []
  state.rows.daily_insights = [
    {
      ad_account_id: 'account-a', entity_level: 'account', date_start: '2026-08-19', date_stop: '2026-08-19',
      spend: 10, leads: 0, bookings: 1, impressions: 1_000, reach: 100, clicks: 20,
      unique_clicks: 9, link_clicks: 7, landing_page_views: 6, frequency: 1.1, appointment_value: 100,
    },
    {
      ad_account_id: 'account-a', entity_level: 'account', date_start: '2026-08-20', date_stop: '2026-08-20',
      spend: 20, leads: 0, bookings: 2, impressions: 2_000, reach: 150, clicks: 30,
      unique_clicks: 12, link_clicks: 8, landing_page_views: 7, frequency: 1.2, appointment_value: 200,
    },
    {
      ad_account_id: 'account-a', entity_level: 'campaign', campaign_id: 'campaign-db-1',
      date_start: '2026-08-19', date_stop: '2026-08-19',
      spend: 10, leads: 0, bookings: 1, impressions: 1_000, reach: 100, clicks: 20,
      unique_clicks: 9, link_clicks: 7, landing_page_views: 6, frequency: 1.1, appointment_value: 100,
    },
    {
      ad_account_id: 'account-a', entity_level: 'campaign', campaign_id: 'campaign-db-1',
      date_start: '2026-08-20', date_stop: '2026-08-20',
      spend: 20, leads: 0, bookings: 2, impressions: 2_000, reach: 150, clicks: 30,
      unique_clicks: 12, link_clicks: 8, landing_page_views: 7, frequency: 1.2, appointment_value: 200,
    },
  ]
})

describe('MCP Meta metrics contract', () => {
  it('account summary does not expose summed daily reach as selected-period reach', async () => {
    const { getAccountSummary } = await import('@/mcp/tools/account-summary')
    const result = await getAccountSummary({ start_date: '2026-08-19', end_date: '2026-08-20' }) as Record<string, unknown>
    const summary = result.summary as Record<string, unknown>

    expect(summary.total_reach).toBeNull()
    expect(summary.peak_daily_reach).toBe(150)
    expect(summary.frequency).toBeNull()
    expect(summary.unique_clicks).toBe(21)
    expect(JSON.stringify(summary)).not.toMatch(/\broas\b/i)
    expect(JSON.stringify(result._provenance)).toMatch(/total_reach.*deprecated/i)
  })

  it('account summary clamps today to the last closed New York day and exposes requested/effective range metadata', async () => {
    const { getAccountSummary } = await import('@/mcp/tools/account-summary')
    const result = await getAccountSummary({ start_date: '2026-08-21', end_date: '2026-08-21' }) as Record<string, unknown>

    expect(result.period).toMatchObject({
      start: '2026-08-20',
      end: '2026-08-20',
      requested_start_date: '2026-08-21',
      requested_end_date: '2026-08-21',
      effective_start_date: '2026-08-20',
      effective_end_date: '2026-08-20',
      clamped_to_closed_day: true,
      last_closed_date: '2026-08-20',
    })
  })

  it('campaign performance uses peak daily reach, null multi-day frequency, and summed unique clicks', async () => {
    const { getCampaignPerformance } = await import('@/mcp/tools/campaign-performance')
    const result = await getCampaignPerformance({ start_date: '2026-08-19', end_date: '2026-08-20' }) as Record<string, unknown>
    const campaign = (result.campaigns as Array<Record<string, unknown>>)[0]!

    expect(campaign.reach).toBeNull()
    expect(campaign.peak_daily_reach).toBe(150)
    expect(campaign.avg_frequency).toBeNull()
    expect(campaign.frequency).toBeNull()
    expect(campaign.unique_clicks).toBe(21)
    expect(JSON.stringify(campaign)).not.toMatch(/\broas\b/i)
    expect(JSON.stringify(result._provenance)).toMatch(/frequency.*single-day/i)
  })

  it('campaign performance preserves exact frequency for a single closed day', async () => {
    const { getCampaignPerformance } = await import('@/mcp/tools/campaign-performance')
    const result = await getCampaignPerformance({ start_date: '2026-08-20', end_date: '2026-08-20' }) as Record<string, unknown>
    const campaign = (result.campaigns as Array<Record<string, unknown>>)[0]!

    expect(campaign.reach).toBeNull()
    expect(campaign.peak_daily_reach).toBe(150)
    expect(campaign.avg_frequency).toBe(1.2)
    expect(campaign.frequency).toBe(1.2)
  })
})
