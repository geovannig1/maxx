import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockState = vi.hoisted(() => ({
  fetchNativePeriodDelivery: vi.fn(),
}))

vi.mock('@/lib/platforms/meta/fetch-insights', () => ({
  fetchNativePeriodDelivery: mockState.fetchNativePeriodDelivery,
}))

type Row = Record<string, unknown>

function fakeDb(rows: Record<'daily_insights' | 'api_sync_logs' | 'ad_accounts', Row[]>) {
  return {
    from(table: keyof typeof rows) {
      let selected = [...rows[table]]
      const builder = {
        select: () => builder,
        eq: (column: string, value: unknown) => {
          selected = selected.filter((row) => row[column] === value)
          return builder
        },
        gte: (column: string, value: unknown) => {
          selected = selected.filter((row) => String(row[column]) >= String(value))
          return builder
        },
        lte: (column: string, value: unknown) => {
          selected = selected.filter((row) => String(row[column]) <= String(value))
          return builder
        },
        order: () => builder,
        limit: () => builder,
        maybeSingle: async () => ({ data: selected[0] ?? null, error: null }),
        then: (resolve: (value: { data: Row[]; error: null }) => unknown) =>
          Promise.resolve({ data: selected, error: null }).then(resolve),
      }
      return builder
    },
  }
}

const dbAccountId = '00000000-0000-4000-8000-000000000001'
const range = { start: '2026-08-01', end: '2026-08-02', basis: 'closed_account_days' as const, timezone: 'America/New_York' as const }

function completeRows(): Record<'daily_insights' | 'api_sync_logs' | 'ad_accounts', Row[]> {
  return {
    daily_insights: [
      { ad_account_id: dbAccountId, entity_level: 'account', date_start: '2026-08-01', date_stop: '2026-08-01', spend: 10, impressions: 100, link_clicks: 5, bookings: 0, actions: [], action_values: [] },
      { ad_account_id: dbAccountId, entity_level: 'account', date_start: '2026-08-02', date_stop: '2026-08-02', spend: 20, impressions: 200, link_clicks: 10, bookings: 0, actions: [], action_values: [] },
      { ad_account_id: dbAccountId, entity_level: 'campaign', meta_campaign_id: 'campaign-1', date_start: '2026-08-01', date_stop: '2026-08-01', spend: 10, impressions: 100, link_clicks: 5, bookings: 0, actions: [], action_values: [] },
      { ad_account_id: dbAccountId, entity_level: 'campaign', meta_campaign_id: 'campaign-1', date_start: '2026-08-02', date_stop: '2026-08-02', spend: 20, impressions: 200, link_clicks: 10, bookings: 0, actions: [], action_values: [] },
    ],
    // The account's platform (ad_accounts.platform) serves the native period read.
    ad_accounts: [{ id: dbAccountId, platform: 'meta' }],
    api_sync_logs: [{
      ad_account_id: dbAccountId,
      status: 'success',
      date_range_start: '2026-08-01',
      date_range_end: '2026-08-02',
      completed_at: '2026-08-21T12:00:00.000Z',
    }],
  }
}

describe('native selected-period Meta delivery evidence', () => {
  beforeEach(() => {
    mockState.fetchNativePeriodDelivery.mockReset()
  })

  it('uses exactly one native all-days account response for the selected window', async () => {
    mockState.fetchNativePeriodDelivery.mockResolvedValueOnce([{
      date_start: '2026-08-01', date_stop: '2026-08-02', reach: '240', frequency: '1.25',
    }])
    const { readMetaDelivery } = await import('@/lib/cockpit/source-readers')

    const delivery = await readMetaDelivery(fakeDb(completeRows()) as never, dbAccountId, '123', range)

    expect(mockState.fetchNativePeriodDelivery).toHaveBeenCalledWith({
      accountId: '123', since: '2026-08-01', until: '2026-08-02',
    })
    expect(delivery.frequencyAvailable).toBe(true)
    expect(delivery.nativeFrequency).toBe(1.25)
    expect(delivery.nativeReach).toBe(240)
  })

  it('withholds native frequency when Meta returns a row for a different period', async () => {
    mockState.fetchNativePeriodDelivery.mockResolvedValueOnce([{
      date_start: '2026-08-01', date_stop: '2026-08-01', reach: '100', frequency: '1',
    }])
    const { readMetaDelivery } = await import('@/lib/cockpit/source-readers')

    const delivery = await readMetaDelivery(fakeDb(completeRows()) as never, dbAccountId, '123', range)

    expect(delivery.frequencyAvailable).toBe(false)
    expect(delivery.nativeFrequency).toBeNull()
    expect(delivery.blockerCodes).toContain('meta_native_period_all_days_window_mismatch')
  })

  it('withholds native frequency when the direct Meta query fails', async () => {
    mockState.fetchNativePeriodDelivery.mockRejectedValueOnce(new Error('offline'))
    const { readMetaDelivery } = await import('@/lib/cockpit/source-readers')

    const delivery = await readMetaDelivery(fakeDb(completeRows()) as never, dbAccountId, '123', range)

    expect(delivery.frequencyAvailable).toBe(false)
    expect(delivery.nativeFrequency).toBeNull()
    expect(delivery.blockerCodes).toContain('meta_native_period_all_days_query_failed')
  })

  it('does not use a direct period response when the selected window lacks a successful generation', async () => {
    const rows = completeRows()
    rows.api_sync_logs[0] = {
      ...rows.api_sync_logs[0],
      status: 'partial',
      completed_at: '2026-08-21T12:01:00.000Z',
    }
    const { readMetaDelivery } = await import('@/lib/cockpit/source-readers')

    const delivery = await readMetaDelivery(fakeDb(rows) as never, dbAccountId, '123', range)

    expect(mockState.fetchNativePeriodDelivery).not.toHaveBeenCalled()
    expect(delivery.frequencyAvailable).toBe(false)
    expect(delivery.nativeFrequency).toBeNull()
    expect(delivery.blockerCodes).toContain('meta_native_period_all_days_freshness_unavailable')
  })

  it('uses a direct period response when a partial generation durably completed the delivery plane', async () => {
    const rows = completeRows()
    rows.api_sync_logs[0] = {
      ...rows.api_sync_logs[0],
      status: 'partial',
      insights_fetched: 8,
      decision_gate: { gates: { insightLevelsComplete: true, metaOutcomeMetricsComplete: true } },
    }
    mockState.fetchNativePeriodDelivery.mockResolvedValueOnce([{
      date_start: '2026-08-01', date_stop: '2026-08-02', reach: '240', frequency: '1.25',
    }])
    const { readMetaDelivery } = await import('@/lib/cockpit/source-readers')

    const delivery = await readMetaDelivery(fakeDb(rows) as never, dbAccountId, '123', range)

    expect(mockState.fetchNativePeriodDelivery).toHaveBeenCalledOnce()
    expect(delivery.frequencyAvailable).toBe(true)
  })
})
