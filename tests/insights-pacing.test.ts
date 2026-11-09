import { describe, it, expect } from 'vitest'
import { computePacing } from '@/lib/insights/pacing'

describe('computePacing', () => {
  it('returns none when there is no usable budget', () => {
    expect(computePacing(100, null, 7)).toEqual({ status: 'none', pct: 0, expected: 0 })
    expect(computePacing(100, 0, 7)).toEqual({ status: 'none', pct: 0, expected: 0 })
    expect(computePacing(100, 50, 0)).toEqual({ status: 'none', pct: 0, expected: 0 })
  })

  it('zero spend is "none", never "0% Under" — a paused row has no pace to judge', () => {
    // Paused ad set with a synced budget and days-in-range fallback used to render "0% Under".
    expect(computePacing(0, 35, 11).status).toBe('none')
    expect(computePacing(0, 35, 11, 0).status).toBe('none')
  })

  it('flags under-delivery below 80% of expected', () => {
    // budget 100/day × 7 = 700 expected; spent 350 → 50% → under
    const p = computePacing(350, 100, 7)
    expect(p.expected).toBe(700)
    expect(p.pct).toBeCloseTo(50, 6)
    expect(p.status).toBe('under')
  })

  it('flags on-pace between 80% and 110%', () => {
    expect(computePacing(700, 100, 7).status).toBe('on') // 100%
    expect(computePacing(560, 100, 7).status).toBe('on') // 80%
    expect(computePacing(770, 100, 7).status).toBe('on') // 110%
  })

  it('flags over-spend above 110%', () => {
    const p = computePacing(900, 100, 7) // ~128.6%
    expect(p.status).toBe('over')
    expect(p.pct).toBeCloseTo(128.5714, 3)
  })
})

describe('computePacing — days-delivering denominator', () => {
  it('paces over days DELIVERED, not days-in-range (the phantom "under" fix)', () => {
    // Ad set: $188.40 on $24/day, launched Mar 5, viewed Mar 10 on an MTD (Mar 1) range.
    // days-in-range = 10 → 188.40/(24*10)=79% "under" (WRONG). days-delivering = 6 → 131% "over" (right).
    expect(computePacing(188.4, 24, 10).status).toBe('under')                  // old (buggy) behaviour
    expect(computePacing(188.4, 24, 10, 6).status).toBe('over')                // corrected
    expect(Math.round(computePacing(188.4, 24, 10, 6).pct)).toBe(131)
  })
  it('falls back to days-in-range when daysDelivering is absent or zero', () => {
    expect(computePacing(100, 50, 4).expected).toBe(computePacing(100, 50, 4, 0).expected)
    expect(computePacing(100, 50, 4, undefined).expected).toBe(200)
  })
})
