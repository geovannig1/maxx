import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

type Row = Record<string, unknown>

const state = vi.hoisted(() => ({
  accountError: null as { message: string } | null,
  tables: new Map<string, Row[]>(),
  reads: [] as Array<{ table: string; filters: Array<[string, unknown]> }>,
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({
    auth: {
      getUser: async () => ({ data: { user: { id: 'owner', email: 'owner@example.com', email_confirmed_at: '2026-01-01T00:00:00Z' } } }),
    },
  })),
}))

vi.mock('@/lib/supabase/admin', () => ({
  getAdminClient: () => ({
    from: (table: string) => {
      let rows = [...(state.tables.get(table) ?? [])]
      let maximum = Number.POSITIVE_INFINITY
      let rangeStart = 0
      let rangeEnd = Number.POSITIVE_INFINITY
      const filters: Array<[string, unknown]> = []
      state.reads.push({ table, filters })

      const response = () => {
        const filteredCount = rows.length
        const data = rows.slice(rangeStart, Math.min(rangeEnd + 1, maximum))
        return {
          data,
          error: table === 'ad_accounts' ? state.accountError : null,
          count: filteredCount,
        }
      }

      const builder = {
        select: () => builder,
        eq: (column: string, value: unknown) => {
          filters.push([column, value])
          rows = rows.filter((row) => row[column] === value)
          return builder
        },
        in: (column: string, values: unknown[]) => {
          rows = rows.filter((row) => values.includes(row[column]))
          return builder
        },
        gte: (column: string, value: unknown) => {
          rows = rows.filter((row) => String(row[column]) >= String(value))
          return builder
        },
        lte: (column: string, value: unknown) => {
          rows = rows.filter((row) => String(row[column]) <= String(value))
          return builder
        },
        order: () => builder,
        limit: (value: number) => {
          maximum = value
          return builder
        },
        range: (start: number, end: number) => {
          rangeStart = start
          rangeEnd = end
          return builder
        },
        maybeSingle: async () => {
          const result = response()
          return { data: result.data[0] ?? null, error: result.error }
        },
        then: (
          resolve: (value: ReturnType<typeof response>) => unknown,
          reject?: (reason: unknown) => unknown,
        ) => Promise.resolve(response()).then(resolve, reject),
      }
      return builder
    },
  }),
}))

function setAccounts(accounts: Row[], error: { message: string } | null = null): void {
  state.tables.set('ad_accounts', accounts)
  state.accountError = error
}

async function callRoutes(): Promise<Response[]> {
  const [{ GET: getAdsets }, { GET: getCampaigns }, { GET: getFlags }, { GET: getAlerts }] = await Promise.all([
    import('@/app/api/adsets/route'),
    import('@/app/api/campaigns/route'),
    import('@/app/api/flags/route'),
    import('@/app/api/alerts/route'),
  ])

  return Promise.all([
    getAdsets(new NextRequest('http://localhost/api/adsets')),
    getCampaigns(new NextRequest('http://localhost/api/campaigns')),
    getFlags(new Request('http://localhost/api/flags')),
    getAlerts(new NextRequest('http://localhost/api/alerts')),
  ])
}

describe('primary owner performance routes are account-scoped', () => {
  beforeEach(() => {
    // the owner gate fails closed without OWNER_EMAIL, in development too.
    vi.stubEnv('OWNER_EMAIL', 'owner@example.com')
    state.accountError = null
    state.tables = new Map()
    state.reads = []
  })

  it('excludes another account from campaign, ad-set, flag, alert, relationship, and insight reads', async () => {
    setAccounts([
      { id: 'inactive-first', account_id: 'act_100000000000061', account_name: 'Inactive', is_active: false },
      { id: 'active-account', account_id: 'act_100000000000062', account_name: 'Active', is_active: true },
    ])
    state.tables.set('campaigns', [
      {
        id: 'campaign-db-other', ad_account_id: 'other-account', campaign_id: 'shared-meta-id',
        campaign_name: 'Other campaign', status: 'ACTIVE', created_at: '2026-07-01',
      },
      {
        id: 'campaign-db-active', ad_account_id: 'active-account', campaign_id: 'shared-meta-id',
        campaign_name: 'Active campaign', status: 'ACTIVE', created_at: '2026-07-01',
      },
    ])
    state.tables.set('adsets', [
      {
        id: 'adset-db-active', ad_account_id: 'active-account', adset_id: 'adset-active',
        adset_name: 'Active ad set', campaign_id: 'campaign-db-active', status: 'ACTIVE', created_at: '2026-07-01',
      },
      {
        id: 'adset-db-other', ad_account_id: 'other-account', adset_id: 'adset-other',
        adset_name: 'Other ad set', campaign_id: 'campaign-db-other', status: 'ACTIVE', created_at: '2026-07-01',
      },
    ])
    state.tables.set('flags', [
      { id: 'flag-active', ad_account_id: 'active-account', is_active: true, flag_type: 'watchlist' },
      { id: 'flag-other', ad_account_id: 'other-account', is_active: true, flag_type: 'winner' },
    ])
    state.tables.set('alerts', [
      { id: 'alert-active', ad_account_id: 'active-account', alert_type: 'pacing', message: 'Active observation' },
      { id: 'alert-other', ad_account_id: 'other-account', alert_type: 'pacing', message: 'Other observation' },
    ])
    state.tables.set('daily_insights', [
      {
        id: 'insight-active', ad_account_id: 'active-account', entity_level: 'campaign',
        campaign_id: 'campaign-db-active', spend: 10, date_start: '2026-07-15', date_stop: '2026-07-15',
      },
      {
        id: 'insight-other', ad_account_id: 'other-account', entity_level: 'campaign',
        campaign_id: 'campaign-db-active', spend: 999, date_start: '2026-07-15', date_stop: '2026-07-15',
      },
      {
        id: 'adset-insight-active', ad_account_id: 'active-account', entity_level: 'adset',
        adset_id: 'adset-db-active', spend: 20, date_start: '2026-07-15', date_stop: '2026-07-15',
      },
      {
        id: 'adset-insight-other', ad_account_id: 'other-account', entity_level: 'adset',
        adset_id: 'adset-db-active', spend: 888, date_start: '2026-07-15', date_stop: '2026-07-15',
      },
    ])

    const [{ GET: getAdsets }, { GET: getCampaigns }, { GET: getFlags }, { GET: getAlerts }] = await Promise.all([
      import('@/app/api/adsets/route'),
      import('@/app/api/campaigns/route'),
      import('@/app/api/flags/route'),
      import('@/app/api/alerts/route'),
    ])
    const [adsetsResponse, campaignsResponse, flagsResponse, alertsResponse] = await Promise.all([
      getAdsets(new NextRequest('http://localhost/api/adsets?from=2026-07-01&to=2026-07-30&campaign=shared-meta-id')),
      getCampaigns(new NextRequest('http://localhost/api/campaigns?from=2026-07-01&to=2026-07-30')),
      getFlags(new Request('http://localhost/api/flags')),
      getAlerts(new NextRequest('http://localhost/api/alerts')),
    ])

    const adsets = await adsetsResponse.json() as {
      adsets: Array<{ adset_id: string; campaign_name: string; metrics: { spend: number } }>
    }
    const campaigns = await campaignsResponse.json() as { campaigns: Array<{ campaign_id: string; metrics: { spend: number } }> }
    const flags = await flagsResponse.json() as { flags: Array<{ id: string }> }
    const alerts = await alertsResponse.json() as { alerts: Array<{ id: string }> }

    expect(adsets.adsets).toEqual([expect.objectContaining({
      adset_id: 'adset-active',
      campaign_name: 'Active campaign',
      metrics: expect.objectContaining({ spend: 20 }),
    })])
    expect(campaigns.campaigns).toEqual([expect.objectContaining({
      campaign_id: 'shared-meta-id',
      metrics: expect.objectContaining({ spend: 10 }),
    })])
    expect(flags.flags.map((row) => row.id)).toEqual(['flag-active'])
    expect(alerts.alerts.map((row) => row.id)).toEqual(['alert-active'])

    for (const read of state.reads.filter(({ table }) => table !== 'ad_accounts')) {
      expect(read.filters, `${read.table} must be account-scoped`).toContainEqual(['ad_account_id', 'active-account'])
    }
  })

  it.each([
    {
      name: 'no active account',
      accounts: [] as Row[],
      error: null,
      status: 404,
      code: 'ACTIVE_ACCOUNT_NOT_FOUND',
    },
    {
      name: 'ambiguous active accounts',
      accounts: [
        { id: 'active-1', account_id: 'act_100000000000063', is_active: true },
        { id: 'active-2', account_id: 'act_100000000000064', is_active: true },
      ],
      error: null,
      status: 409,
      code: 'ACTIVE_ACCOUNT_AMBIGUOUS',
    },
    {
      name: 'account resolution failure',
      accounts: [{ id: 'active-1', is_active: true }],
      error: { message: 'database unavailable' },
      status: 503,
      code: 'ACTIVE_ACCOUNT_UNAVAILABLE',
    },
  ])('fails all four routes closed for $name', async ({ accounts, error, status, code }) => {
    setAccounts(accounts, error)

    const responses = await callRoutes()
    for (const response of responses) {
      expect(response.status).toBe(status)
      expect(await response.json()).toMatchObject({ code })
    }

    expect(state.reads.filter(({ table }) => table !== 'ad_accounts')).toEqual([])
  })

  it('distinguishes a healthy empty account from unresolved ownership', async () => {
    setAccounts([{
      id: 'active-account',
      account_id: 'act_100000000000062',
      account_name: 'Active',
      is_active: true,
    }])

    const responses = await callRoutes()
    expect(responses.map((response) => response.status)).toEqual([200, 200, 200, 200])
    expect(await responses[0].json()).toEqual({ adsets: [], total: 0 })
    expect(await responses[1].json()).toEqual({ campaigns: [], total: 0 })
    expect(await responses[2].json()).toMatchObject({ flags: [], total: 0 })
    expect(await responses[3].json()).toEqual({ alerts: [], total: 0 })
  })
})
