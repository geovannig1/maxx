import { describe, expect, it } from 'vitest'
import {
  buildCreativeOwnerDiagnostics,
  readCreativeOwnerDiagnostics,
} from '@/lib/diagnostics/owner-surface'

describe('buildCreativeOwnerDiagnostics', () => {
  it('projects existing aggregate metrics and descriptive signals for ads that delivered', () => {
    const result = buildCreativeOwnerDiagnostics(
      [
        { id: 'ad-db-1', ad_id: 'meta-ad-1', ad_name: 'Video A', status: 'ACTIVE', effective_status: 'ACTIVE' },
        { id: 'ad-db-2', ad_id: 'meta-ad-2', ad_name: 'No delivery', status: 'ACTIVE', effective_status: 'ACTIVE' },
      ],
      [{
        ad_id: 'ad-db-1',
        spend: 40,
        leads: 2,
        bookings: 1,
        impressions: 1_000,
        reach: 800,
        clicks: 20,
        frequency: 1.25,
        video_plays: 100,
        video_p25_watched: 50,
        video_p50_watched: 30,
        video_p75_watched: 20,
        video_p100_watched: 10,
        video_thru_plays: 25,
        early_view_source: 'video_play_actions',
      }],
      30,
    )

    expect(result).toMatchObject({
      observations: [{
        ad_id: 'meta-ad-1',
        ad_name: 'Video A',
        status: 'ACTIVE',
        metrics: {
          spend: 40,
          ctr: 2,
          frequency: 1.25,
          retention_p25_rate: 50,
          retention_denominator: 'video_starts',
        },
        diagnostic: {
          authority: 'diagnostic_only',
          state: 'evidence_available',
          prescriptions: [],
        },
      }],
    })
  })

  it('reads creative evidence through the supplied account and report-window boundaries', async () => {
    const calls: Array<[string, ...unknown[]]> = []
    const resultFor = (table: string) => {
      const result = table === 'ads'
        ? {
            data: [{
              id: 'ad-db-1',
              ad_id: 'meta-ad-1',
              ad_name: 'Video A',
              status: 'ACTIVE',
              effective_status: 'ACTIVE',
              delivery_sub_status: null,
              delivery_sub_status_read_available: true,
              delivery_sub_status_synced_at: '2026-08-01T20:00:00.000Z',
            }],
            error: null,
          }
        : { data: [{ ad_id: 'ad-db-1', spend: 40, impressions: 1_000, clicks: 20, frequency: 1.25 }], error: null }
      const builder: Record<string, unknown> = {}
      for (const method of ['select', 'eq', 'gte', 'lte']) {
        builder[method] = (...args: unknown[]) => {
          calls.push([method, ...args])
          return builder
        }
      }
      builder.then = (resolve: (value: typeof result) => unknown) => Promise.resolve(result).then(resolve)
      return builder
    }
    const db = {
      from: (table: string) => {
        calls.push(['from', table])
        return resultFor(table)
      },
    }

    const result = await readCreativeOwnerDiagnostics(
      { adAccountDbId: 'account-1', window: { from: '2026-07-01', to: '2026-07-30' } },
      db as never,
    )

    expect(result.total).toBe(1)
    expect(calls.filter((call) => call[0] === 'eq' && call[1] === 'ad_account_id')).toEqual([
      ['eq', 'ad_account_id', 'account-1'],
      ['eq', 'ad_account_id', 'account-1'],
    ])
    expect(calls).toContainEqual(['gte', 'date_start', '2026-07-01'])
    expect(calls).toContainEqual(['lte', 'date_stop', '2026-07-30'])
    expect(calls.find((call) => call[0] === 'select')?.[1]).toEqual(
      expect.stringContaining('delivery_sub_status'),
    )
    expect(result.observations[0]?.delivery_sub_status).toEqual({
      read_available: true,
      payload: null,
      synced_at: '2026-08-01T20:00:00.000Z',
    })
  })

  it('keeps each delivered ad attached to its own delivery sub-status state', () => {
    const base = {
      ad_name: 'Video',
      status: 'ACTIVE',
      effective_status: 'ACTIVE',
    }
    const ads = [
      {
        ...base,
        id: 'ad-db-1',
        ad_id: 'meta-ad-1',
        delivery_sub_status: { status: 'warning', substatuses: ['creative_fatigue'] },
        delivery_sub_status_read_available: true,
        delivery_sub_status_synced_at: '2026-08-01T20:00:00.000Z',
      },
      {
        ...base,
        id: 'ad-db-2',
        ad_id: 'meta-ad-2',
        delivery_sub_status: null,
        delivery_sub_status_read_available: true,
        delivery_sub_status_synced_at: '2026-08-01T20:01:00.000Z',
      },
      {
        ...base,
        id: 'ad-db-3',
        ad_id: 'meta-ad-3',
        delivery_sub_status: null,
        delivery_sub_status_read_available: false,
        delivery_sub_status_synced_at: null,
      },
    ]
    const insights = ads.map((ad) => ({
      ad_id: ad.id,
      spend: 10,
      impressions: 100,
      clicks: 1,
    }))

    const result = buildCreativeOwnerDiagnostics(ads, insights, 30)

    expect(result.observations.map((observation) => ({
      ad_id: observation.ad_id,
      delivery_sub_status: observation.delivery_sub_status,
    }))).toEqual([
      {
        ad_id: 'meta-ad-1',
        delivery_sub_status: {
          read_available: true,
          payload: { status: 'warning', substatuses: ['creative_fatigue'] },
          synced_at: '2026-08-01T20:00:00.000Z',
        },
      },
      {
        ad_id: 'meta-ad-2',
        delivery_sub_status: {
          read_available: true,
          payload: null,
          synced_at: '2026-08-01T20:01:00.000Z',
        },
      },
      {
        ad_id: 'meta-ad-3',
        delivery_sub_status: { read_available: false, payload: null, synced_at: null },
      },
    ])
  })
})
