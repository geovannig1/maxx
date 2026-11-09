import { describe, it, expect } from 'vitest'
import { priorPeriod, computeDelta, rangeLengthDays, comparisonLabel } from '@/lib/insights/compare'

describe('priorPeriod', () => {
  it('returns the equal-length window immediately before a 7-day range', () => {
    // 2026-06-08..2026-06-14 (7 days) → prior 2026-06-01..2026-06-07
    expect(priorPeriod('2026-06-08', '2026-06-14')).toEqual({ from: '2026-06-01', to: '2026-06-07' })
  })

  it('handles a single day', () => {
    expect(priorPeriod('2026-06-14', '2026-06-14')).toEqual({ from: '2026-06-13', to: '2026-06-13' })
  })

  it('handles a 30-day range across a month boundary', () => {
    // 2026-06-01..2026-06-30 (30d) → 2026-05-02..2026-05-31
    expect(priorPeriod('2026-06-01', '2026-06-30')).toEqual({ from: '2026-05-02', to: '2026-05-31' })
  })
})

describe('rangeLengthDays', () => {
  it('counts inclusively', () => {
    expect(rangeLengthDays('2026-06-08', '2026-06-14')).toBe(7)
    expect(rangeLengthDays('2026-06-14', '2026-06-14')).toBe(1)
  })
})

describe('computeDelta', () => {
  it('marks a rise as up for higher-is-better metrics', () => {
    expect(computeDelta(120, 100, false)).toEqual({ value: 20, direction: 'up' })
  })

  it('marks a rise as down (red) for lower-is-better metrics like CPL', () => {
    expect(computeDelta(60, 50, true)).toEqual({ value: 20, direction: 'down' })
  })

  it('marks a drop as up (green) for lower-is-better metrics', () => {
    const d = computeDelta(40, 50, true)
    expect(d?.direction).toBe('up')
    expect(d?.value).toBeCloseTo(-20, 6)
  })

  it('is flat for sub-0.5% moves', () => {
    expect(computeDelta(100.2, 100, false)).toEqual({ value: 0, direction: 'flat' })
  })

  it('returns undefined without a usable baseline', () => {
    expect(computeDelta(100, 0, false)).toBeUndefined()
    expect(computeDelta(100, null, false)).toBeUndefined()
    expect(computeDelta(null, 100, false)).toBeUndefined()
  })
})

describe('comparisonLabel', () => {
  it('names common windows', () => {
    expect(comparisonLabel('2026-06-08', '2026-06-14')).toBe('vs prior 7d')
    expect(comparisonLabel('2026-06-01', '2026-06-30')).toBe('vs prior month')
    expect(comparisonLabel('2026-06-14', '2026-06-14')).toBe('vs prior day')
  })
})
