import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

type Row = Record<string, unknown>

const state = vi.hoisted(() => ({
  resolution: { ok: true, account: { id: 'account-a', accountName: 'Studio A' } } as
    | { ok: true; account: { id: string; accountName: string | null } }
    | { ok: false; reason: 'not_found' | 'ambiguous' | 'unavailable' },
  rows: {
    ads: [] as Row[],
    adsets: [] as Row[],
    creatives: [] as Row[],
    daily_insights: [] as Row[],
  },
  calls: [] as Array<{ table: string; op: 'eq' | 'in'; column: string; value: unknown }>,
}))

vi.mock('@/lib/accounts/active-account', () => ({
  resolveOnlyActiveAccount: vi.fn(async () => state.resolution),
  activeAccountErrorCode: (reason: string) => `ACTIVE_ACCOUNT_${reason.toUpperCase()}`,
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
      const response = () => ({ data: rows, error: null })
      const builder = {
        select: () => builder,
        order: () => builder,
        eq: (column: string, value: unknown) => {
          state.calls.push({ table, op: 'eq', column, value })
          rows = rows.filter((row) => row[column] === value)
          return builder
        },
        in: (column: string, values: unknown[]) => {
          state.calls.push({ table, op: 'in', column, value: values })
          rows = rows.filter((row) => values.includes(row[column]))
          return builder
        },
        gte: () => builder,
        lte: () => builder,
        maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
        then: (resolve: (value: ReturnType<typeof response>) => unknown, reject?: (reason: unknown) => unknown) =>
          Promise.resolve(response()).then(resolve, reject),
      }
      return builder
    },
  }),
}))

describe('ads API active-account and diagnostic authority', () => {
  beforeEach(() => {
    // the owner gate fails closed without OWNER_EMAIL, in development too.
    vi.stubEnv('OWNER_EMAIL', 'owner@example.com')
    state.resolution = { ok: true, account: { id: 'account-a', accountName: 'Studio A' } }
    state.calls = []
    state.rows.ads = [
      { id: 'ad-a-db', ad_account_id: 'account-a', ad_id: 'meta-ad-a', ad_name: 'A', status: 'ACTIVE', effective_status: 'ACTIVE', meta_creative_id: 'creative-a', created_at: '2026-07-01' },
      { id: 'ad-b-db', ad_account_id: 'account-b', ad_id: 'meta-ad-b', ad_name: 'B', status: 'ACTIVE', effective_status: 'ACTIVE', meta_creative_id: 'creative-b', created_at: '2026-07-01' },
    ]
    state.rows.adsets = [
      { id: 'adset-a-db', ad_account_id: 'account-a', adset_id: 'meta-adset-a' },
      { id: 'adset-b-db', ad_account_id: 'account-b', adset_id: 'meta-adset-b' },
    ]
    state.rows.creatives = [
      { ad_account_id: 'account-a', creative_id: 'creative-a', creative_name: 'Creative A', asset_type: 'VIDEO', body: 'A primary message', title: 'A headline', thumbnail_url: 'a.jpg', image_url: null },
      { ad_account_id: 'account-b', creative_id: 'creative-b', thumbnail_url: 'b.jpg', image_url: null },
    ]
    state.rows.daily_insights = [
      { ad_account_id: 'account-a', entity_level: 'ad', ad_id: 'ad-a-db', date_start: '2026-07-01', date_stop: '2026-07-07', spend: 100, bookings: 10, impressions: 5_000, clicks: 100, frequency: 1.5 },
      { ad_account_id: 'account-b', entity_level: 'ad', ad_id: 'ad-a-db', date_start: '2026-07-01', date_stop: '2026-07-07', spend: 9_999, bookings: 0, impressions: 50_000, clicks: 1, frequency: 9 },
    ]
  })

  it('excludes other-account ads, creatives, and insight rows while preserving raw metrics', async () => {
    const { GET } = await import('@/app/api/ads/route')
    const response = await GET(new NextRequest('http://localhost/api/ads?from=2026-07-01&to=2026-07-07'))
    const body = await response.json() as { ads: Array<Record<string, unknown>>; total: number }

    expect(response.status).toBe(200)
    expect(body.total).toBe(1)
    expect(body.ads[0]).toMatchObject({
      ad_id: 'meta-ad-a',
      thumbnail_url: 'a.jpg',
      creative: {
        name: 'Creative A',
        format: 'VIDEO',
        primaryText: 'A primary message',
        headline: 'A headline',
      },
      metrics: { spend: 100, bookings: 10, cpa: 10 },
      diagnostic: { authority: 'diagnostic_only', prescriptions: [] },
    })
    expect(body.ads[0]).not.toHaveProperty('verdict')
    expect(body.ads[0]).not.toHaveProperty('health_score')
    expect(body.ads[0]).not.toHaveProperty('fatigue_level')
    expect(state.calls).toEqual(expect.arrayContaining([
      { table: 'ads', op: 'eq', column: 'ad_account_id', value: 'account-a' },
      { table: 'creatives', op: 'eq', column: 'ad_account_id', value: 'account-a' },
      { table: 'daily_insights', op: 'eq', column: 'ad_account_id', value: 'account-a' },
    ]))
  })

  it('keeps an ad with no insight row unmeasured instead of synthesizing zero metrics', async () => {
    state.rows.daily_insights = []
    const { GET } = await import('@/app/api/ads/route')

    const response = await GET(new NextRequest('http://localhost/api/ads?from=2026-07-01&to=2026-07-07'))
    const body = await response.json() as { ads: Array<{ metrics: unknown }> }

    expect(response.status).toBe(200)
    expect(body.ads).toHaveLength(1)
    expect(body.ads[0].metrics).toBeNull()
  })

  it('preserves measured zero ad metrics when an insight row exists', async () => {
    state.rows.daily_insights = [
      {
        ad_account_id: 'account-a',
        entity_level: 'ad',
        ad_id: 'ad-a-db',
        date_start: '2026-07-01',
        date_stop: '2026-07-01',
        spend: 0,
        impressions: 0,
        clicks: 0,
        leads: 0,
        bookings: 0,
      },
    ]
    const { GET } = await import('@/app/api/ads/route')

    const response = await GET(new NextRequest('http://localhost/api/ads?from=2026-07-01&to=2026-07-07'))
    const body = await response.json() as { ads: Array<{ metrics: Record<string, unknown> | null }> }

    expect(response.status).toBe(200)
    expect(body.ads[0].metrics).toMatchObject({ spend: 0, impressions: 0, bookings: 0 })
  })

  it('does not resolve another account\'s ad set for drill-down', async () => {
    const { GET } = await import('@/app/api/ads/route')
    const response = await GET(new NextRequest('http://localhost/api/ads?from=2026-07-01&to=2026-07-07&adset=meta-adset-b'))

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ads: [], total: 0 })
    expect(state.calls).toContainEqual({ table: 'adsets', op: 'eq', column: 'ad_account_id', value: 'account-a' })
  })

  it('fails explicitly when active-account ownership is ambiguous', async () => {
    state.resolution = { ok: false, reason: 'ambiguous' }
    const { GET } = await import('@/app/api/ads/route')
    const response = await GET(new NextRequest('http://localhost/api/ads?from=2026-07-01&to=2026-07-07'))

    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ code: 'ACTIVE_ACCOUNT_AMBIGUOUS' })
    expect(state.calls).toEqual([])
  })
})
