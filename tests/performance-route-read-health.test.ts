import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

type Row = Record<string, unknown>

const state = vi.hoisted(() => ({
  rows: {
    campaigns: [] as Row[],
    adsets: [] as Row[],
    daily_insights: [] as Row[],
  },
  errors: {
    campaignsPrimary: null as { message: string } | null,
    adsetsPrimary: null as { message: string } | null,
    campaignLookup: null as { message: string } | null,
    campaignNames: null as { message: string } | null,
    dailyInsights: null as { message: string } | null,
  },
  reads: [] as Array<{ table: string; columns: string }>,
}))

vi.mock('@/lib/accounts/active-account', () => ({
  resolveOnlyActiveAccount: vi.fn(async () => ({
    ok: true,
    account: { id: 'account-a', accountName: 'Studio A' },
  })),
  activeAccountErrorCode: vi.fn(),
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: async () => ({ data: { user: { id: 'owner', email: 'owner@example.com', email_confirmed_at: '2026-01-01T00:00:00Z' } } }) },
  })),
}))

vi.mock('@/lib/supabase/admin', () => ({
  getAdminClient: () => ({
    from: (table: keyof typeof state.rows) => {
      let rows = [...state.rows[table]]
      let columns = ''
      const error = () => {
        if (table === 'daily_insights') return state.errors.dailyInsights
        if (table === 'campaigns' && columns.includes('campaign_id')) return state.errors.campaignsPrimary
        if (table === 'adsets') return state.errors.adsetsPrimary
        if (table === 'campaigns' && columns === 'id') return state.errors.campaignLookup
        if (table === 'campaigns' && columns === 'id, campaign_name') return state.errors.campaignNames
        return null
      }
      const response = () => ({ data: rows, error: error() })
      const builder = {
        select: (value: string) => {
          columns = value
          state.reads.push({ table, columns })
          return builder
        },
        eq: (column: string, value: unknown) => {
          rows = rows.filter((row) => row[column] === value)
          return builder
        },
        in: (column: string, values: unknown[]) => {
          rows = rows.filter((row) => values.includes(row[column]))
          return builder
        },
        gte: () => builder,
        lte: () => builder,
        order: () => builder,
        maybeSingle: async () => ({ data: rows[0] ?? null, error: error() }),
        then: (
          resolve: (value: ReturnType<typeof response>) => unknown,
          reject?: (reason: unknown) => unknown,
        ) => Promise.resolve(response()).then(resolve, reject),
      }
      return builder
    },
  }),
}))

describe('campaign and ad-set API read health', () => {
  beforeEach(() => {
    // the owner gate fails closed without OWNER_EMAIL, in development too.
    vi.stubEnv('OWNER_EMAIL', 'owner@example.com')
    state.rows.campaigns = [{
      id: 'campaign-db-a',
      ad_account_id: 'account-a',
      campaign_id: 'meta-campaign-a',
      campaign_name: 'Campaign A',
      status: 'ACTIVE',
      created_at: '2026-07-01',
    }]
    state.rows.adsets = [{
      id: 'adset-db-a',
      ad_account_id: 'account-a',
      campaign_id: 'campaign-db-a',
      adset_id: 'meta-adset-a',
      adset_name: 'Ad set A',
      status: 'ACTIVE',
      created_at: '2026-07-01',
    }]
    state.rows.daily_insights = []
    state.errors.campaignsPrimary = null
    state.errors.adsetsPrimary = null
    state.errors.campaignLookup = null
    state.errors.campaignNames = null
    state.errors.dailyInsights = null
    state.reads = []
  })

  it('does not expose raw database messages when primary campaign/ad-set reads fail', async () => {
    state.errors.campaignsPrimary = { message: 'relation campaigns internal detail' }
    state.errors.adsetsPrimary = { message: 'relation adsets internal detail' }
    const [{ GET: getCampaigns }, { GET: getAdsets }] = await Promise.all([
      import('@/app/api/campaigns/route'),
      import('@/app/api/adsets/route'),
    ])

    const [campaignResponse, adsetResponse] = await Promise.all([
      getCampaigns(new NextRequest('http://localhost/api/campaigns?from=2026-07-01&to=2026-07-07')),
      getAdsets(new NextRequest('http://localhost/api/adsets?from=2026-07-01&to=2026-07-07')),
    ])
    const campaignBody = await campaignResponse.json() as Record<string, unknown>
    const adsetBody = await adsetResponse.json() as Record<string, unknown>

    expect(campaignResponse.status).toBe(503)
    expect(adsetResponse.status).toBe(503)
    expect(campaignBody).toMatchObject({
      code: 'CAMPAIGNS_READ_UNAVAILABLE',
      error: 'Campaign performance is unavailable because the scoped campaign read failed.',
    })
    expect(adsetBody).toMatchObject({
      code: 'ADSETS_READ_UNAVAILABLE',
      error: 'Ad-set performance is unavailable because the scoped ad-set read failed.',
    })
    expect(JSON.stringify({ campaignBody, adsetBody })).not.toContain('internal detail')
  })

  it('returns service-unavailable when campaign insights cannot be read, never zero metrics', async () => {
    state.errors.dailyInsights = { message: 'daily_insights offline' }
    const { GET } = await import('@/app/api/campaigns/route')

    const response = await GET(new NextRequest(
      'http://localhost/api/campaigns?from=2026-07-01&to=2026-07-07',
    ))
    const body = await response.json() as Record<string, unknown>

    expect(response.status).toBe(503)
    expect(body).toMatchObject({ code: 'CAMPAIGN_INSIGHTS_READ_UNAVAILABLE' })
    expect(body).not.toHaveProperty('campaigns')
  })

  it('returns service-unavailable when ad-set insights cannot be read, never zero metrics', async () => {
    state.errors.dailyInsights = { message: 'daily_insights offline' }
    const { GET } = await import('@/app/api/adsets/route')

    const response = await GET(new NextRequest(
      'http://localhost/api/adsets?from=2026-07-01&to=2026-07-07',
    ))
    const body = await response.json() as Record<string, unknown>

    expect(response.status).toBe(503)
    expect(body).toMatchObject({ code: 'ADSET_INSIGHTS_READ_UNAVAILABLE' })
    expect(body).not.toHaveProperty('adsets')
  })

  it('keeps campaign and ad-set entities without insight rows unmeasured', async () => {
    const [{ GET: getCampaigns }, { GET: getAdsets }] = await Promise.all([
      import('@/app/api/campaigns/route'),
      import('@/app/api/adsets/route'),
    ])

    const [campaignResponse, adsetResponse] = await Promise.all([
      getCampaigns(new NextRequest('http://localhost/api/campaigns?from=2026-07-01&to=2026-07-07')),
      getAdsets(new NextRequest('http://localhost/api/adsets?from=2026-07-01&to=2026-07-07')),
    ])
    const campaigns = await campaignResponse.json() as { campaigns: Array<{ metrics: unknown }> }
    const adsets = await adsetResponse.json() as { adsets: Array<{ metrics: unknown }> }

    expect(campaigns.campaigns[0].metrics).toBeNull()
    expect(adsets.adsets[0].metrics).toBeNull()
  })

  it('preserves measured zero metrics when campaign and ad-set insight rows exist', async () => {
    state.rows.daily_insights = [
      {
        ad_account_id: 'account-a',
        entity_level: 'campaign',
        campaign_id: 'campaign-db-a',
        date_start: '2026-07-01',
        date_stop: '2026-07-01',
        spend: 0,
        impressions: 0,
        clicks: 0,
        leads: 0,
        bookings: 0,
      },
      {
        ad_account_id: 'account-a',
        entity_level: 'adset',
        adset_id: 'adset-db-a',
        date_start: '2026-07-01',
        date_stop: '2026-07-01',
        spend: 0,
        impressions: 0,
        clicks: 0,
        leads: 0,
        bookings: 0,
      },
    ]
    const [{ GET: getCampaigns }, { GET: getAdsets }] = await Promise.all([
      import('@/app/api/campaigns/route'),
      import('@/app/api/adsets/route'),
    ])

    const [campaignResponse, adsetResponse] = await Promise.all([
      getCampaigns(new NextRequest('http://localhost/api/campaigns?from=2026-07-01&to=2026-07-07')),
      getAdsets(new NextRequest('http://localhost/api/adsets?from=2026-07-01&to=2026-07-07')),
    ])
    const campaigns = await campaignResponse.json() as { campaigns: Array<{ metrics: Record<string, unknown> | null }> }
    const adsets = await adsetResponse.json() as { adsets: Array<{ metrics: Record<string, unknown> | null }> }

    expect(campaigns.campaigns[0].metrics).toMatchObject({ spend: 0, impressions: 0, bookings: 0 })
    expect(adsets.adsets[0].metrics).toMatchObject({ spend: 0, impressions: 0, bookings: 0 })
  })

  it('does not expose Meta AppointmentConfirmed value or derived ROAS through performance APIs', async () => {
    state.rows.daily_insights = [
      {
        ad_account_id: 'account-a',
        entity_level: 'campaign',
        campaign_id: 'campaign-db-a',
        date_start: '2026-07-01',
        date_stop: '2026-07-01',
        spend: 100,
        impressions: 1000,
        clicks: 10,
        leads: 0,
        bookings: 2,
        appointment_value: 500,
      },
      {
        ad_account_id: 'account-a',
        entity_level: 'adset',
        adset_id: 'adset-db-a',
        date_start: '2026-07-01',
        date_stop: '2026-07-01',
        spend: 100,
        impressions: 1000,
        clicks: 10,
        leads: 0,
        bookings: 2,
        appointment_value: 500,
      },
    ]
    const [{ GET: getCampaigns }, { GET: getAdsets }] = await Promise.all([
      import('@/app/api/campaigns/route'),
      import('@/app/api/adsets/route'),
    ])

    const [campaignResponse, adsetResponse] = await Promise.all([
      getCampaigns(new NextRequest('http://localhost/api/campaigns?from=2026-07-01&to=2026-07-07')),
      getAdsets(new NextRequest('http://localhost/api/adsets?from=2026-07-01&to=2026-07-07')),
    ])
    const campaigns = await campaignResponse.json() as { campaigns: Array<{ metrics: Record<string, unknown> | null }> }
    const adsets = await adsetResponse.json() as { adsets: Array<{ metrics: Record<string, unknown> | null }> }

    expect(campaigns.campaigns[0].metrics).toMatchObject({ appointment_value: null, roas: null })
    expect(adsets.adsets[0].metrics).toMatchObject({ appointment_value: null, roas: null })
  })

  it('does not turn a failed drill-down parent lookup into an empty ad-set result', async () => {
    state.errors.campaignLookup = { message: 'campaign parent offline' }
    const { GET } = await import('@/app/api/adsets/route')

    const response = await GET(new NextRequest(
      'http://localhost/api/adsets?campaign=meta-campaign-a',
    ))
    const body = await response.json() as Record<string, unknown>

    expect(response.status).toBe(503)
    expect(body).toMatchObject({ code: 'CAMPAIGN_READ_UNAVAILABLE' })
    expect(body).not.toHaveProperty('adsets')
  })

  it('does not render missing campaign names when the ad-set parent read fails', async () => {
    state.errors.campaignNames = { message: 'campaign parents offline' }
    const { GET } = await import('@/app/api/adsets/route')

    const response = await GET(new NextRequest('http://localhost/api/adsets'))
    const body = await response.json() as Record<string, unknown>

    expect(response.status).toBe(503)
    expect(body).toMatchObject({ code: 'CAMPAIGN_READ_UNAVAILABLE' })
    expect(body).not.toHaveProperty('adsets')
  })
})
