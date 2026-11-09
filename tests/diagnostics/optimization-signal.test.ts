import { describe, it, expect } from 'vitest'
import { classifyOptimizationSignal } from '@/lib/diagnostics/optimization-signal'
import { REC_THRESHOLDS } from '@/lib/recommendations/thresholds'

describe('classifyOptimizationSignal', () => {
  it('flags the Example Studio case as structurally_starved (~11/wk vs 50/wk needed)', () => {
    const r = classifyOptimizationSignal({ eventPerWeek: 11, activeAdsetsOnEvent: 2 })
    expect(r.perAdsetThreshold).toBe(REC_THRESHOLDS.LEARNING_EXIT_EVENTS_PER_WEEK) // 50
    expect(r.needPerWeek).toBe(100) // 50 × 2 ad sets
    expect(r.verdict).toBe('structurally_starved')
    expect(r.headroomPerWeek).toBe(89)
    expect(r.detail).toContain('11/week')
  })

  it('is structurally_starved even if a single ad set could capture 100% of site-wide volume', () => {
    // 40/wk, one ad set: still below the 50/wk a single ad set needs → cannot exit by waiting.
    const r = classifyOptimizationSignal({ eventPerWeek: 40, activeAdsetsOnEvent: 1 })
    expect(r.verdict).toBe('structurally_starved')
  })

  it('is marginal when one ad set could exit but the whole cohort cannot', () => {
    // 60/wk ≥ 50 (one ad set) but < 100 (two ad sets need 100 together).
    const r = classifyOptimizationSignal({ eventPerWeek: 60, activeAdsetsOnEvent: 2 })
    expect(r.verdict).toBe('marginal')
  })

  it('is sufficient when volume meets the whole cohort need', () => {
    const r = classifyOptimizationSignal({ eventPerWeek: 120, activeAdsetsOnEvent: 2 })
    expect(r.verdict).toBe('sufficient')
    expect(r.headroomPerWeek).toBe(0)
    expect(r.ratio).toBeGreaterThanOrEqual(1)
  })

  it('respects a custom threshold and never divides by zero ad sets', () => {
    const r = classifyOptimizationSignal({ eventPerWeek: 30, activeAdsetsOnEvent: 0, threshold: 25 })
    expect(r.perAdsetThreshold).toBe(25)
    expect(r.activeAdsetsOnEvent).toBe(1) // clamped to ≥1
    expect(r.verdict).toBe('sufficient') // 30 ≥ 25
  })
})
