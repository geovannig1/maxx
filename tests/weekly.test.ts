import { describe, it, expect } from 'vitest'
import { aggregateWeekly, pctDelta } from '@/lib/report/weekly'

describe('aggregateWeekly', () => {
  it('sums volume and recomputes rates from totals', () => {
    const a = aggregateWeekly([
      { spend: 100, leads: 10, bookings: 2, impressions: 1000, reach: 800, clicks: 20, appointment_value: 300 },
      { spend: 50, leads: 5, bookings: 1, impressions: 500, reach: 400, clicks: 5, appointment_value: 100 },
    ])
    expect(a.days).toBe(2)
    expect(a.spend).toBe(150)
    expect(a.bookings).toBe(3)
    expect(a.cpl).toBeCloseTo(10, 5) // 150/15
    expect(a.cpb).toBeCloseTo(50, 5) // 150/3
    expect(a.ctr).toBeCloseTo((25 / 1500) * 100, 5)
    expect(a.cpm).toBeCloseTo(100, 5) // 150/1500*1000
    expect(a.roas).toBeCloseTo(400 / 150, 5)
  })

  it('returns zeros and null rates for an empty week', () => {
    const a = aggregateWeekly([])
    expect(a.days).toBe(0)
    expect(a.spend).toBe(0)
    expect(a.cpb).toBeNull()
    expect(a.ctr).toBeNull()
    expect(a.roas).toBeNull()
  })
})

describe('pctDelta', () => {
  it('computes week-over-week percent change', () => {
    expect(pctDelta(150, 100)).toBeCloseTo(50, 5)
    expect(pctDelta(50, 100)).toBeCloseTo(-50, 5)
  })
  it('returns null when the prior value is zero (no ratio)', () => {
    expect(pctDelta(100, 0)).toBeNull()
    expect(pctDelta(0, 0)).toBeNull()
  })
})
