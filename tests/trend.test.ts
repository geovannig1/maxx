import { describe, it, expect } from 'vitest'
import { computeTrendStable, daysSinceChange, deriveExitedLearning, type DailyPoint } from '@/lib/recommendations/trend'

const day = (spend: number, cpa: number | null): DailyPoint => ({ spend, cpa })

describe('computeTrendStable', () => {
  it('returns null (unknown → stays blocked) when there are too few delivering days', () => {
    expect(computeTrendStable([day(50, 55), day(50, 60)])).toBeNull() // only 2 delivering days
    expect(computeTrendStable([day(0, null), day(0, null), day(0, null)])).toBeNull() // no delivery at all
  })

  it('a winner with a steady CPA series is stable', () => {
    // 5 converting days, CPA ~55-62 → low coefficient of variation
    expect(computeTrendStable([day(60, 55), day(62, 58), day(58, 60), day(61, 57), day(59, 62)])).toBe(true)
  })

  it('a winner with a wildly swinging CPA series is NOT stable', () => {
    // same spend, CPA swings 20 → 140 → high coefficient of variation
    expect(computeTrendStable([day(60, 20), day(60, 140), day(60, 30), day(60, 130)])).toBe(false)
  })

  it('a loser (no conversions) with steady spend is stable — safe to pause', () => {
    // 0 bookings every day but steadily spending ~$40/day
    expect(computeTrendStable([day(40, null), day(41, null), day(39, null), day(40, null)])).toBe(true)
  })

  it('a loser with erratic spend is NOT stable', () => {
    expect(computeTrendStable([day(5, null), day(90, null), day(10, null), day(80, null)])).toBe(false)
  })
})

describe('daysSinceChange', () => {
  const today = '2026-06-15'
  it('returns whole days since the change', () => {
    expect(daysSinceChange('2026-06-08T00:00:00Z', today)).toBe(7)
    expect(daysSinceChange('2026-06-14T12:00:00Z', today)).toBe(0) // same-day / <1 day
  })
  it('null (fine to act) when there is no known prior change', () => {
    expect(daysSinceChange(null, today)).toBeNull()
    expect(daysSinceChange(undefined, today)).toBeNull()
  })
})

describe('deriveExitedLearning', () => {
  it('SUCCESS → exited (true)', () => {
    expect(deriveExitedLearning('SUCCESS')).toBe(true)
    expect(deriveExitedLearning('success')).toBe(true)
  })
  it('LEARNING / LEARNING_LIMITED → still learning (false)', () => {
    expect(deriveExitedLearning('LEARNING')).toBe(false)
    expect(deriveExitedLearning('LEARNING_LIMITED')).toBe(false)
  })
  it('unknown / null → null (conservative, keeps the learning-phase penalty)', () => {
    expect(deriveExitedLearning(null)).toBeNull()
    expect(deriveExitedLearning(undefined)).toBeNull()
    expect(deriveExitedLearning('WHATEVER')).toBeNull()
  })
})
