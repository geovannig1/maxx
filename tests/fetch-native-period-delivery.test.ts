import { describe, expect, it, vi } from 'vitest'

const mocked = vi.hoisted(() => ({ metaGetPaginated: vi.fn() }))

vi.mock('@/lib/platforms/meta/client', () => ({ metaGetPaginated: mocked.metaGetPaginated }))

describe('fetchNativePeriodDelivery', () => {
  it('requests one all-days account window without time_increment', async () => {
    mocked.metaGetPaginated.mockResolvedValueOnce([])
    const { fetchNativePeriodDelivery } = await import('@/lib/platforms/meta/fetch-insights')

    await fetchNativePeriodDelivery({ accountId: 'act_123', since: '2026-08-01', until: '2026-08-20' })

    expect(mocked.metaGetPaginated).toHaveBeenCalledWith('/act_123/insights', {
      fields: 'reach,frequency',
      level: 'account',
      action_attribution_windows: expect.any(String),
      time_range: JSON.stringify({ since: '2026-08-01', until: '2026-08-20' }),
      limit: '2',
    })
    expect(mocked.metaGetPaginated.mock.calls[0][1]).not.toHaveProperty('time_increment')
  })
})
