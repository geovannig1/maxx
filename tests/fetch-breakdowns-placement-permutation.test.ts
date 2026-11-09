import { afterEach, describe, expect, it, vi } from 'vitest'

import type { BreakdownRow, MetaBreakdownRecord } from '@/lib/platforms/meta/fetch-breakdowns'

/** Meta's supported-permutation table never lists `platform_position` on its own — it appears only
 *  joined with `publisher_platform`. Verified live against v25.0 on 2026-08-16: requesting
 *  `breakdowns=platform_position` is rejected with the (#100) error below, and it is rejected
 *  IDENTICALLY when `actions`/`results` are dropped from `fields`, so the action fields are not the
 *  cause — Meta always evaluates an implicit `action_type` action-breakdown.
 *  Ref: https://developers.facebook.com/docs/marketing-api/insights/breakdowns/ */
function fakeMeta(records: MetaBreakdownRecord[]) {
  const calls: Array<Record<string, string>> = []
  const metaGetPaginated = vi.fn(async (_path: string, params: Record<string, string> = {}) => {
    calls.push(params)
    const requested = (params.breakdowns ?? '').split(',').filter(Boolean)
    if (requested.includes('platform_position') && !requested.includes('publisher_platform')) {
      throw new Error(
        '(#100) Current combination of data breakdown columns (action_type, platform_position) is invalid',
      )
    }
    return records
  })
  return { metaGetPaginated, calls }
}

async function loadFetchBreakdowns(records: MetaBreakdownRecord[]) {
  const { metaGetPaginated, calls } = fakeMeta(records)
  vi.doMock('@/lib/platforms/meta/client', () => ({ metaGetPaginated }))
  const mod = await import('@/lib/platforms/meta/fetch-breakdowns')
  return { fetchBreakdowns: mod.fetchBreakdowns, calls }
}

const leadAction = { action_type: 'lead', value: '2' }
const bookingAction = { action_type: 'offsite_conversion.custom.AppointmentConfirmed', value: '1' }
const bookingResult = [{
  indicator: 'conversions:offsite_conversion.fb_pixel_custom.AppointmentConfirmed',
  values: [{ value: '1', attribution_windows: ['default'] }],
}]

/** One Meta cell of the joint publisher_platform × platform_position grid. */
function cell(
  publisher: string,
  position: string,
  delivery: { spend: string; impressions: string; clicks: string; ctr?: string },
  actions?: MetaBreakdownRecord['actions'],
  results?: MetaBreakdownRecord['results'],
): MetaBreakdownRecord {
  return {
    campaign_id: 'campaign-1',
    adset_id: 'adset-1',
    publisher_platform: publisher,
    platform_position: position,
    ...delivery,
    ...(actions ? { actions } : {}),
    ...(results ? { results } : {}),
  }
}

afterEach(() => {
  vi.resetModules()
  vi.doUnmock('@/lib/platforms/meta/client')
})

describe('fetchBreakdowns — platform_position permutation', () => {
  it('does not send the permutation Meta rejects with (#100)', async () => {
    const { fetchBreakdowns, calls } = await loadFetchBreakdowns([
      cell('facebook', 'feed', { spend: '1.00', impressions: '100', clicks: '2' }, [leadAction]),
    ])

    await expect(fetchBreakdowns({
      accountId: '100000000000777',
      level: 'adset',
      since: '2026-08-14',
      until: '2026-08-14',
      breakdowns: ['platform_position'],
      strict: true,
    })).resolves.toBeInstanceOf(Array)

    expect(calls).toHaveLength(1)
    expect(calls[0]?.breakdowns).toBe('publisher_platform,platform_position')
  })

  it('collapses the joint grid onto one row per platform_position, preserving the spend partition', async () => {
    // `feed` is served on BOTH facebook and instagram. Unfolded, that is two rows carrying the same
    // (entity, breakdown_type, breakdown_value) key — which replace_executive_placement_window
    // rejects outright as 'executive placement snapshot contains duplicate rows'.
    const { fetchBreakdowns } = await loadFetchBreakdowns([
      cell('facebook', 'feed', { spend: '2.58', impressions: '147', clicks: '2', ctr: '1.360544' }, [leadAction, bookingAction], bookingResult),
      cell('instagram', 'feed', { spend: '20.00', impressions: '853', clicks: '18', ctr: '2.110199' }, [leadAction, bookingAction], bookingResult),
      cell('instagram', 'story', { spend: '9.31', impressions: '637', clicks: '20', ctr: '3.139717' }, [leadAction, bookingAction], bookingResult),
    ])

    const rows = await fetchBreakdowns({
      accountId: '100000000000777',
      level: 'adset',
      since: '2026-08-14',
      until: '2026-08-14',
      breakdowns: ['platform_position'],
      strict: true,
    })

    expect(rows).toHaveLength(2)
    expect(rows.every((row) => row.breakdown_type === 'platform_position')).toBe(true)
    expect(new Set(rows.map((row) => row.breakdown_value))).toEqual(new Set(['feed', 'story']))

    const feed = rows.find((row) => row.breakdown_value === 'feed') as BreakdownRow
    expect(feed.spend).toBeCloseTo(22.58, 10)
    expect(feed.impressions).toBe(1000)
    expect(feed.clicks).toBe(20)
    expect(feed.leads).toBe(4)
    expect(feed.bookings).toBe(2)
    // ctr is re-derived from the merged delivery totals (Meta's own definition, clicks/impressions).
    expect(feed.ctr).toBeCloseTo(2, 10)
    expect(feed.cpa).toBeCloseTo(22.58 / 2, 10)

    // Total spend still equals the account partition — the executive placement reconciler requires it.
    expect(rows.reduce((total, row) => total + row.spend, 0)).toBeCloseTo(31.89, 10)
  })

  it('keeps a partially-reported placement NULL instead of coercing missing outcomes to zero', async () => {
    const { fetchBreakdowns } = await loadFetchBreakdowns([
      cell('facebook', 'feed', { spend: '2.58', impressions: '147', clicks: '2' }, [leadAction, bookingAction]),
      // Meta omits the actions array entirely for low-volume cells (verified live).
      cell('instagram', 'feed', { spend: '0.02', impressions: '1', clicks: '0' }),
    ])

    const rows = await fetchBreakdowns({
      accountId: '100000000000777',
      level: 'adset',
      since: '2026-08-14',
      until: '2026-08-14',
      breakdowns: ['platform_position'],
      strict: true,
    })

    expect(rows).toHaveLength(1)
    expect(rows[0]?.spend).toBeCloseTo(2.6, 10)
    expect(rows[0]?.impressions).toBe(148)
    expect(rows[0]?.leads).toBeNull()
    expect(rows[0]?.bookings).toBeNull()
    expect(rows[0]?.cpa).toBeNull()
  })
})

describe('fetchBreakdowns — shared daily-sync dimensions are unchanged', () => {
  it('requests each non-placement dimension bare and passes its rows through uncollapsed', async () => {
    for (const dimension of ['age', 'gender', 'device_platform', 'region'] as const) {
      const { fetchBreakdowns, calls } = await loadFetchBreakdowns([
        {
          campaign_id: 'campaign-1', adset_id: 'adset-1', [dimension]: 'value-a',
          spend: '1.00', impressions: '100', clicks: '2', ctr: '2', actions: [leadAction],
        } as MetaBreakdownRecord,
        {
          campaign_id: 'campaign-1', adset_id: 'adset-1', [dimension]: 'value-b',
          spend: '3.00', impressions: '200', clicks: '4', ctr: '2', actions: [leadAction],
        } as MetaBreakdownRecord,
      ])

      const rows = await fetchBreakdowns({
        accountId: '100000000000777',
        level: 'adset',
        since: '2026-08-14',
        until: '2026-08-14',
        breakdowns: [dimension],
      })

      expect(calls[0]?.breakdowns).toBe(dimension)
      expect(rows).toHaveLength(2)
      expect(rows.map((row) => row.ctr)).toEqual([2, 2])
      vi.resetModules()
      vi.doUnmock('@/lib/platforms/meta/client')
    }
  })

  it('still requests publisher_platform on its own', async () => {
    const { fetchBreakdowns, calls } = await loadFetchBreakdowns([
      cell('facebook', 'feed', { spend: '1.00', impressions: '100', clicks: '2' }, [leadAction]),
    ])

    await fetchBreakdowns({
      accountId: '100000000000777',
      level: 'adset',
      since: '2026-08-14',
      until: '2026-08-14',
      breakdowns: ['publisher_platform'],
      strict: true,
    })

    expect(calls[0]?.breakdowns).toBe('publisher_platform')
  })
})
