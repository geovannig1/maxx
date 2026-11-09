import { describe, it, expect } from 'vitest'
import {
  extractHook,
  analyzeCopyPerformance,
  copyMinSpend,
  COPY_MIN_IMPRESSIONS,
  type AdCopyRow,
} from '@/lib/creative/copy-performance'

function row(overrides: Partial<AdCopyRow>): AdCopyRow {
  return {
    meta_ad_id: 'ad_1',
    body: 'Your own private studio.\nBook by the hour.',
    title: 'Book Now',
    spend: 0,
    impressions: 0,
    link_clicks: 0,
    bookings: 0,
    ...overrides,
  }
}

describe('extractHook', () => {
  it('takes the first non-empty line', () => {
    expect(extractHook('Stop renting shared spaces.\nExample Studio is private.')).toBe('Stop renting shared spaces.')
    expect(extractHook('\n\n  Tired of crowded studios?  \nMore text')).toBe('Tired of crowded studios?')
  })
  it('cuts a one-paragraph body at the first sentence end', () => {
    expect(extractHook('Daylight 1,200 sq ft loft. Paper backdrops, a tethered station, and a changing room all included in the booking.')).toBe('Daylight 1,200 sq ft loft.')
  })
  it('returns null for empty/missing body', () => {
    expect(extractHook(null)).toBeNull()
    expect(extractHook('')).toBeNull()
    expect(extractHook('   \n  ')).toBeNull()
  })
})

describe('analyzeCopyPerformance', () => {
  it('groups ads running the same hook+headline and aggregates delivery', () => {
    const rows = [
      row({ meta_ad_id: 'a1', spend: 30, impressions: 2000, link_clicks: 40, bookings: 1 }),
      row({ meta_ad_id: 'a2', spend: 25, impressions: 1500, link_clicks: 20, bookings: 0 }),
      row({ meta_ad_id: 'a3', body: 'Different hook entirely.\nBody.', spend: 5, impressions: 100, link_clicks: 1, bookings: 0 }),
    ]
    const groups = analyzeCopyPerformance(rows)
    expect(groups).toHaveLength(2)
    const g = groups[0]
    expect(g.ads).toBe(2)
    expect(g.spend).toBe(55)
    expect(g.impressions).toBe(3500)
    expect(g.link_ctr).toBeCloseTo(60 / 3500)
    expect(g.cpc).toBeCloseTo(55 / 60, 2)
    expect(g.meta_bookings_estimate).toBe(1)
  })

  it('gates ranking on min spend OR min impressions — below both is insufficient, never ranked', () => {
    const groups = analyzeCopyPerformance([
      row({ meta_ad_id: 'a1', body: 'Thin hook.', spend: copyMinSpend() - 1, impressions: COPY_MIN_IMPRESSIONS - 1, link_clicks: 3 }),
      row({ meta_ad_id: 'a2', body: 'Spend-qualified hook.', spend: copyMinSpend(), impressions: 10, link_clicks: 1 }),
      row({ meta_ad_id: 'a3', body: 'Impression-qualified hook.', spend: 1, impressions: COPY_MIN_IMPRESSIONS, link_clicks: 12 }),
    ])
    const byHook = Object.fromEntries(groups.map((g) => [g.hook, g]))
    expect(byHook['Thin hook.'].verdict).toBe('insufficient')
    expect(byHook['Spend-qualified hook.'].verdict).toBe('ranked')
    expect(byHook['Impression-qualified hook.'].verdict).toBe('ranked')
  })

  it('orders ranked groups by link CTR (delivery truth), never by estimated bookings', () => {
    const groups = analyzeCopyPerformance([
      row({ meta_ad_id: 'a1', body: 'High CTR hook.', spend: 50, impressions: 1000, link_clicks: 50, bookings: 0 }),
      row({ meta_ad_id: 'a2', body: 'High bookings-estimate hook.', spend: 50, impressions: 1000, link_clicks: 10, bookings: 9 }),
      row({ meta_ad_id: 'a3', body: 'Tiny hook.', spend: 1, impressions: 10, link_clicks: 0 }),
    ])
    expect(groups[0].hook).toBe('High CTR hook.')
    expect(groups[1].hook).toBe('High bookings-estimate hook.')
    expect(groups[2].verdict).toBe('insufficient') // insufficient always after ranked
  })

  it('skips ads with no captured primary text (nothing to learn about copy)', () => {
    expect(analyzeCopyPerformance([row({ body: null, spend: 100, impressions: 5000, link_clicks: 50 })])).toHaveLength(0)
  })

  it('averages the Claude-vision hook_strength_score per group; null when no ad was scored', () => {
    const scored = analyzeCopyPerformance([
      row({ meta_ad_id: 'a1', spend: 30, impressions: 2000, hook_strength_score: 4 }),
      row({ meta_ad_id: 'a2', spend: 25, impressions: 1500, hook_strength_score: 5 }),
      row({ meta_ad_id: 'a3', spend: 25, impressions: 1500 }), // no vision score → excluded from the avg
    ])
    expect(scored[0].avg_hook_strength).toBeCloseTo(4.5) // (4 + 5) / 2, the unscored ad ignored
    const unscored = analyzeCopyPerformance([row({ meta_ad_id: 'b1', body: 'No vision hook.', spend: 40, impressions: 2000 })])
    expect(unscored[0].avg_hook_strength).toBeNull()
  })
})
