import { describe, expect, it, vi } from 'vitest'

import { refreshExecutivePlacementEvidence } from '@/lib/sync/executive-placement-evidence'

describe('refreshExecutivePlacementEvidence', () => {
  it('fetches both placement dimensions for every completed day and commits one exact window', async () => {
    const fetch = vi.fn(async (input: { since: string; breakdowns: string[] }) => [{
      meta_entity_id: 'adset-1', entity_level: 'adset' as const,
      breakdown_type: input.breakdowns[0] as 'publisher_platform' | 'platform_position',
      breakdown_value: 'instagram', spend: 10, impressions: 100, clicks: 5, leads: 1,
      bookings: 0, ctr: 5, cpa: 10,
    }])
    const commit = vi.fn(async () => 14)

    const result = await refreshExecutivePlacementEvidence({
      adAccountDbId: '00000000-0000-4000-8000-000000000111',
      metaAccountId: '100000000000777',
      lastCompleteDate: '2026-08-15',
    }, { fetch, commit, now: () => '2026-08-16T14:00:00.000Z' })

    expect(fetch).toHaveBeenCalledTimes(14)
    expect(fetch.mock.calls[0]?.[0]).toMatchObject({
      since: '2026-08-09', until: '2026-08-09', breakdowns: ['publisher_platform'],
    })
    expect(fetch.mock.calls.at(-1)?.[0]).toMatchObject({
      since: '2026-08-15', until: '2026-08-15', breakdowns: ['platform_position'],
    })
    expect(commit).toHaveBeenCalledWith(expect.objectContaining({
      windowStart: '2026-08-09', windowEnd: '2026-08-15', completedAt: '2026-08-16T14:00:00.000Z',
      rows: expect.arrayContaining([expect.objectContaining({ date_start: '2026-08-09' })]),
    }))
    expect(result).toEqual({ windowStart: '2026-08-09', windowEnd: '2026-08-15', rowCount: 14 })
  })

  it('does not commit a partial window when any source dimension fails', async () => {
    const fetch = vi.fn(async (input: { since: string; breakdowns: string[] }) => {
      if (input.since === '2026-08-12' && input.breakdowns[0] === 'platform_position') {
        throw new Error('Meta dimension unavailable')
      }
      return []
    })
    const commit = vi.fn(async () => 0)

    await expect(refreshExecutivePlacementEvidence({
      adAccountDbId: '00000000-0000-4000-8000-000000000111',
      metaAccountId: '100000000000777',
      lastCompleteDate: '2026-08-15',
    }, { fetch, commit, now: () => '2026-08-16T14:00:00.000Z' }))
      .rejects.toThrow(/Meta dimension unavailable/)
    expect(commit).not.toHaveBeenCalled()
  })
})
