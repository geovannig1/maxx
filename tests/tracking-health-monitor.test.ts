import { beforeEach, describe, expect, it, vi } from 'vitest'

type Row = Record<string, unknown>

const state = vi.hoisted(() => ({
  metaResponse: null as unknown,
  rows: {
    ad_accounts: [{ pixel_id: 'pixel-from-db' }] as Row[],
    daily_insights: [] as Row[],
    app_settings: [] as Row[],
    alerts: [] as Row[],
  },
  writes: {
    appSettings: [] as Row[],
    alerts: [] as Row[],
  },
}))

vi.mock('@/lib/platforms/meta/client', () => ({
  fetchMetaGraph: vi.fn(async () => {
    if (state.metaResponse instanceof Error) throw state.metaResponse
    return state.metaResponse
  }),
}))

vi.mock('@/lib/supabase/admin', () => ({
  getAdminClient: () => ({
    from: (table: keyof typeof state.rows) => {
      let rows = [...state.rows[table]]
      const builder = {
        select: () => builder,
        eq: (column: string, value: unknown) => {
          rows = rows.filter((row) => row[column] === value)
          return builder
        },
        gte: () => builder,
        lt: () => builder,
        maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
        upsert: async (value: Row) => {
          if (table === 'app_settings') state.writes.appSettings.push(value)
          return { data: null, error: null }
        },
        insert: async (values: Row[]) => {
          if (table === 'alerts') state.writes.alerts.push(...values)
          return { data: null, error: null }
        },
        then: (
          resolve: (value: { data: Row[]; error: null }) => unknown,
          reject?: (reason: unknown) => unknown,
        ) => Promise.resolve({ data: rows, error: null }).then(resolve, reject),
      }
      return builder
    },
  }),
}))

describe('checkTrackingHealth — Meta pixel read failures fail closed', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.stubEnv('META_ACCESS_TOKEN', 'meta-token')
    vi.stubEnv('META_PIXEL_ID', 'pixel-1')
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    state.rows.daily_insights = [
      { ad_account_id: 'account-1', entity_level: 'campaign', bookings: 4, spend: 250 },
    ]
    state.writes.appSettings = []
    state.writes.alerts = []
  })

  it('does not become healthy when the Meta API throws, even with warehouse bookings', async () => {
    state.metaResponse = new Error('Meta transport failed')
    const { checkTrackingHealth } = await import('@/lib/tracking/health-monitor')

    const result = await checkTrackingHealth('account-1')

    expect(result.status).not.toBe('healthy')
    expect(result.status).toBe('unverified')
    expect(result.is_firing).toBe(false)
    expect(result.browser_pixel_status).toBe('unavailable')
    expect(result.dataset_capi_status).toBe('unverified')
    expect(result.appointment_confirmed_last_7d).toBe(4)
    expect(result.delivery_last_7d).toBe(250)
    expect(result.issues.join(' ')).toMatch(/Meta Pixel browser health is unavailable/i)
    expect(result.issues.join(' ')).not.toMatch(/CAPI|dataset/i)
    expect(state.writes.alerts).toHaveLength(0)
  })

  it('does not become healthy when Meta returns pixelJson.error', async () => {
    state.metaResponse = {
      json: async () => ({
        error: { message: 'Unsupported get request', code: 100 },
      }),
    }
    const { checkTrackingHealth } = await import('@/lib/tracking/health-monitor')

    const result = await checkTrackingHealth('account-1')

    expect(result.status).toBe('unverified')
    expect(result.is_firing).toBe(false)
    expect(result.browser_pixel_status).toBe('unavailable')
    expect(result.dataset_capi_status).toBe('unverified')
    expect(result.issues.join(' ')).toMatch(/Meta Pixel browser health is unavailable/i)
    expect(result.issues.join(' ')).toMatch(/Unsupported get request/)
  })

  it.each([
    ['no response object', null],
    ['response without json()', {}],
    ['non-object JSON body', { json: async () => null }],
  ])('does not become healthy on malformed Meta response: %s', async (_name, metaResponse) => {
    state.metaResponse = metaResponse
    const { checkTrackingHealth } = await import('@/lib/tracking/health-monitor')

    const result = await checkTrackingHealth('account-1')

    expect(result.status).toBe('unverified')
    expect(result.is_firing).toBe(false)
    expect(result.browser_pixel_status).toBe('unavailable')
    expect(result.dataset_capi_status).toBe('unverified')
    expect(result.issues.join(' ')).toMatch(/Meta Pixel browser health is unavailable/i)
  })
})
