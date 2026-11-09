import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import { calculateTrajectory } from '@/lib/analytics/predictor'
import { applyExampleOwnerTargetsPerTest } from './helpers/example-targets'

// cost metrics have no built-in target; these suites test behaviour WITH the owner's target set.
applyExampleOwnerTargetsPerTest()

// Helper: a day where cpa = spend (bookings = 1).
function day(date: string, cpa: number) {
  return { date, spend: cpa, bookings: 1 }
}

describe('calculateTrajectory', () => {
  it('returns low confidence and no projection with fewer than 3 booking-days', () => {
    const r = calculateTrajectory([day('2026-06-01', 50), day('2026-06-02', 55)])
    expect(r.data_points).toBe(2)
    expect(r.confidence).toBe('low')
    expect(r.projected_cpa_3d).toBeNull()
    expect(r.days_until_breach).toBeNull()
  })

  it('projects a worsening trend on contiguous days with day-correct breach timing', () => {
    const r = calculateTrajectory([
      day('2026-06-01', 48), day('2026-06-02', 53), day('2026-06-03', 58),
      day('2026-06-04', 63), day('2026-06-05', 68),
    ])
    expect(r.trend_direction).toBe('worsening')
    expect(r.current_cpa).toBe(68)
    // slope = +5/day, ceiling 98 → (98-68)/5 = 6 calendar days
    expect(r.days_until_breach).toBeCloseTo(6, 5)
    expect(r.projected_cpa_3d).toBeCloseTo(83, 5)
  })

  // Identical CPAs spread over twice the calendar span must yield a slower per-day
  // slope and therefore a LATER breach. The old index-based math gave the same 6 days for both.
  it('scales the breach estimate by calendar spacing, not point count', () => {
    const r = calculateTrajectory([
      day('2026-06-01', 48), day('2026-06-03', 53), day('2026-06-05', 58),
      day('2026-06-07', 63), day('2026-06-09', 68),
    ])
    expect(r.trend_direction).toBe('worsening')
    // slope = +2.5/day → (98-68)/2.5 = 12 calendar days (vs 6 for the contiguous case)
    expect(r.days_until_breach).toBeCloseTo(12, 5)
  })

  it('treats a noisy, non-trending series as flat with no breach', () => {
    const r = calculateTrajectory([
      day('2026-06-01', 50), day('2026-06-02', 52), day('2026-06-03', 49),
      day('2026-06-04', 51), day('2026-06-05', 50),
    ])
    expect(r.trend_direction).toBe('flat')
    expect(r.days_until_breach).toBeNull()
  })

  it('does not report a breach beyond the extrapolation horizon', () => {
    // Genuinely worsening (+1.2/day, clean fit) but the ceiling is ~37 days out → beyond the
    // 30-day horizon, so the breach estimate is suppressed even though the trend is real.
    const r = calculateTrajectory([
      day('2026-06-01', 49.0), day('2026-06-02', 50.2), day('2026-06-03', 51.4),
      day('2026-06-04', 52.6), day('2026-06-05', 53.8),
    ])
    expect(r.trend_direction).toBe('worsening')
    expect(r.days_until_breach).toBeNull()
  })
})

describe('trajectory source queries', () => {
  it('uses the deployed adsets schema for Meta id and display name lookups', () => {
    const predictor = readFileSync('src/lib/analytics/predictor.ts', 'utf8')
    const detector = readFileSync('src/lib/alerts/detector.ts', 'utf8')

    expect(predictor).toContain(".select('id, adset_id')")
    expect(detector).toContain(".select('id, adset_id, adset_name')")
    expect(predictor).not.toContain(".select('id, meta_adset_id')")
    expect(detector).not.toContain(".select('id, meta_adset_id, name')")
  })
})
