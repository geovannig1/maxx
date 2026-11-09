import { describe, it, expect } from 'vitest'
import {
  recencyWeight, shrinkRate, shrinkMean, poissonCountCI, decisiveCpaVsTarget,
  resolvePrior, trackRecordMultiplier, trackRecordAdjuster, type BenchmarkPrior,
} from '@/lib/learning/model'

describe('recencyWeight', () => {
  it('is 1 at age 0 and 0.5 at one half-life', () => {
    expect(recencyWeight(0)).toBe(1)
    expect(recencyWeight(17, 17)).toBeCloseTo(0.5)
    expect(recencyWeight(34, 17)).toBeCloseTo(0.25)
  })
  it('a 28-day-old lesson weighs less than a 3-day-old one', () => {
    expect(recencyWeight(28)).toBeLessThan(recencyWeight(3))
  })
})

describe('shrinkRate / shrinkMean (no more lucky-small-sample certainty)', () => {
  it('a 1-of-1 win shrinks well below 100% toward the prior', () => {
    const r = shrinkRate(1, 1, 0.5, 5)
    expect(r).toBeCloseTo((1 + 5 * 0.5) / (1 + 5)) // ≈ 0.58, not 1.0
    expect(r).toBeLessThan(0.7)
  })
  it('large samples approach the observed rate', () => {
    expect(shrinkRate(90, 100, 0.5, 5)).toBeGreaterThan(0.85)
  })
  it('a $18 CPA on one lucky booking shrinks toward the prior CPA', () => {
    const shrunk = shrinkMean(18, 1, 60, 3)
    expect(shrunk).toBeGreaterThan(40) // not naively $18
  })
})

describe('decisiveCpaVsTarget (variance-aware decisive bar)', () => {
  it('2 bookings is NOT decisive vs target (CI too wide)', () => {
    // CPA = 100/2 = $50 vs $64 target — looks good, but 2 bookings is pure noise.
    expect(decisiveCpaVsTarget(100, 2, 64)).toBe('inconclusive')
  })
  it('many cheap bookings ARE decisively better', () => {
    expect(decisiveCpaVsTarget(400, 20, 64)).toBe('better') // ~$20 CPA, tight CI
  })
  it('many expensive bookings ARE decisively worse', () => {
    expect(decisiveCpaVsTarget(3000, 20, 64)).toBe('worse') // ~$150 CPA
  })
  it('zero bookings is inconclusive, never decisive', () => {
    expect(decisiveCpaVsTarget(200, 0, 64)).toBe('inconclusive')
  })
})

describe('resolvePrior + BenchmarkPrior (cross-niche data is a weak, labeled prior only)', () => {
  const aroma: BenchmarkPrior = { source: 'benchmark', niche: 'fragrance', cpa: 35, winRate: 0.7, strength: 5 }

  it('prefers the account prior when present (benchmark is never an equal input)', () => {
    expect(resolvePrior(58, aroma, 'cpa')).toEqual({ mean: 58, k: 3, source: 'account' })
  })
  it('falls back to the benchmark at a DISCOUNTED strength when no account prior', () => {
    const p = resolvePrior(null, aroma, 'cpa')
    expect(p.source).toBe('benchmark')
    expect(p.mean).toBe(35)
    expect(p.k).toBeLessThanOrEqual(2) // strength capped — a different niche can't dominate
  })
  it('uses a neutral prior when neither exists', () => {
    expect(resolvePrior(null, null, 'winRate').source).toBe('neutral')
  })
})

describe('trackRecordMultiplier (history floors/caps a score, shrunk so thin records do not dominate)', () => {
  it('a thin record stays near neutral (cannot crush or inflate)', () => {
    const m = trackRecordMultiplier(0, 1) // 0/1 wins
    expect(m).toBeGreaterThan(0.6) // not floored to 0.5 on a single data point
    expect(m).toBeLessThan(0.8)
  })
  it('a long failing record is pushed toward the floor', () => {
    expect(trackRecordMultiplier(2, 40)).toBeLessThan(0.6)
  })
  it('a long winning record approaches 1', () => {
    expect(trackRecordMultiplier(38, 40)).toBeGreaterThan(0.9)
  })
  it('never exceeds 1 or drops below the floor', () => {
    expect(trackRecordMultiplier(100, 100)).toBeLessThanOrEqual(1)
    expect(trackRecordMultiplier(0, 100)).toBeGreaterThanOrEqual(0.5)
  })
})

describe('poissonCountCI', () => {
  it('widens (relatively) for small counts and is non-negative', () => {
    expect(poissonCountCI(0).lo).toBe(0)
    const ci = poissonCountCI(100)
    expect(ci.lo).toBeGreaterThan(0)
    expect(ci.hi).toBeGreaterThan(ci.lo)
  })
})

describe('trackRecordAdjuster (gate-facing, TUNED — history adjusts, never penalizes good/neutral)', () => {
  it('no record ⇒ exactly 1 (no effect)', () => {
    expect(trackRecordAdjuster(0, 0)).toBe(1)
  })
  it('a WINNING record is NOT penalized (fixes the raw multiplier over-suppression)', () => {
    // 38/40 wins → the raw trackRecordMultiplier would deflate to ~0.95; the tuned adjuster leaves it at 1.
    expect(trackRecordAdjuster(38, 40, { priorWinRate: 0.5 })).toBe(1)
    expect(trackRecordMultiplier(38, 40)).toBeLessThan(1) // proves the raw one WOULD have cut it
  })
  it('a NEUTRAL record (at the prior) is not penalized', () => {
    expect(trackRecordAdjuster(20, 40, { priorWinRate: 0.5 })).toBe(1)
  })
  it('a repeatedly-FAILING record tempers below 1 but never below the floor', () => {
    const adj = trackRecordAdjuster(2, 40, { priorWinRate: 0.5 })
    expect(adj).toBeLessThan(1)
    expect(adj).toBeGreaterThanOrEqual(0.5)
  })
  it('a couple of losses on a thin record barely moves it (shrunk toward the prior)', () => {
    expect(trackRecordAdjuster(0, 2, { priorWinRate: 0.5 })).toBeGreaterThan(0.7)
  })
  it('a registered benchmark can set the neutral point when there is no account prior', () => {
    // With a high benchmark win-rate as the prior, a mediocre record reads as below-neutral and tempers.
    const strict = trackRecordAdjuster(5, 20, { priorWinRate: 0.9 })
    const lenient = trackRecordAdjuster(5, 20, { priorWinRate: 0.4 })
    expect(strict).toBeLessThan(lenient)
  })
})
