import { describe, it, expect } from 'vitest'
import { championVerdict, CHAMPION_BENCHMARK } from '@/lib/economics/champion'
import { buildProfitView } from '@/lib/economics/model'
import { scoreFlag, classifyConfidence, hookHoldPct } from '@/lib/learning/outcomes'
import { scoreSetupDecisionWindow } from '@/lib/learning/ledger-outcomes'
import { diffLayer } from '@/lib/diagnostics/drift-check'

// Property/adversarial stress for the recent-wave pure engines. These assert INVARIANTS that must hold
// for ANY input (random money numbers, zero/negative/huge, null CPAs) — the class of thing that breaks
// when a formula meets a real edge it wasn't written for. Deterministic PRNG so failures reproduce.

function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const rand = mulberry32(20260713)
const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)]

describe('championVerdict — invariants over random money', () => {
  it('never throws and gives a coherent verdict/ratio for 2000 random (cpa, bookings)', () => {
    for (let i = 0; i < 2000; i++) {
      const cpa = pick([null, 0, -5, 0.01, rand() * 500, 41.7, 1e9, NaN, Infinity]) as number | null
      const bookings = Math.floor(rand() * 40)
      const v = championVerdict(cpa, bookings)
      expect(['beats', 'matches', 'worse', 'unproven']).toContain(v.verdict)
      // Decisive verdicts require enough bookings AND a finite positive CPA.
      if (v.verdict !== 'unproven') {
        expect(bookings).toBeGreaterThanOrEqual(3)
        expect(cpa !== null && isFinite(cpa)).toBe(true)
        expect(v.ratio).toBeCloseTo((cpa as number) / CHAMPION_BENCHMARK.lifetime_cpa, 6)
      }
      expect(typeof v.detail).toBe('string')
    }
  })

  it('verdict boundaries at exactly ±10% of the champion bar', () => {
    const bar = CHAMPION_BENCHMARK.lifetime_cpa
    expect(championVerdict(bar * 0.9, 5).verdict).toBe('beats')
    expect(championVerdict(bar, 5).verdict).toBe('matches')
    expect(championVerdict(bar * 1.1, 5).verdict).toBe('matches')
    expect(championVerdict(bar * 1.1 + 0.01, 5).verdict).toBe('worse')
  })
})

describe('buildProfitView — breakeven honesty contract', () => {
  it('breakeven is null IFF gross margin is unknown, for random inputs', () => {
    for (let i = 0; i < 500; i++) {
      const margin = pick([null, 0.3, 0.5, 0.64, 0.9]) as number | null
      const view = buildProfitView({
        cpa: pick([null, 20, 83, 200]) as number | null,
        bookings: Math.floor(rand() * 10),
        inputs: { aov: 212, gross_margin_rate: margin, repeat_rate: null, source_note: 'Synthetic explicit input' },
      })
      expect(view.breakeven_cpa === null).toBe(margin === null)
      if (margin !== null) {
        // breakeven = aov × margin × (1 + repeat[=0]) — matches the documented formula.
        expect(view.breakeven_cpa).toBe(Math.round(212 * margin))
      }
      // The model must always spell out its assumptions and never crash.
      expect(view.assumptions.length).toBeGreaterThan(0)
    }
  })
})

describe('scoreFlag / scoreSetupDecisionWindow — decisive gates', () => {
  it('scoreFlag never returns worked/failed below the min-bookings bar', () => {
    for (let i = 0; i < 1000; i++) {
      const flagType = pick(['winner', 'loser', 'scale_candidate', 'creative_refresh'])
      const postSpend = rand() * 300
      const postBookings = Math.floor(rand() * 6)
      const postCpa = postBookings > 0 ? postSpend / postBookings : null
      const activeDays = Math.floor(rand() * 8)
      const r = scoreFlag(flagType, 60, postSpend, postBookings, postCpa, null, activeDays)
      if (r.outcome === 'worked' || r.outcome === 'failed') {
        // A decisive money verdict for keep/scale needs volume; loser/refresh may be decisive via
        // "acted on" (post-spend collapsed) which is intentionally allowed at low bookings.
        const actedOn = (flagType === 'loser' || flagType === 'creative_refresh') && postSpend <= 5
        if (!actedOn) {
          expect(postBookings).toBeGreaterThanOrEqual(2)
          expect(activeDays).toBeGreaterThanOrEqual(3)
        }
      }
    }
  })

  it('zero post-bookings ⇒ null CPA ⇒ never decisive for winner/scale', () => {
    expect(scoreFlag('winner', 60, 200, 0, null, null, 5).outcome).toBe('inconclusive')
    expect(scoreFlag('scale_candidate', 60, 200, 0, null, null, 5).outcome).toBe('inconclusive')
  })

  it('scoreSetupDecisionWindow can have sufficient telemetry without a causal verdict', () => {
    const decisive = scoreSetupDecisionWindow({ postSpend: 800, postBookings: 20, postCpa: 40, activeDays: 7, attributionCoverage: null, maxCpa: 100 })
    expect(decisive.dataSufficient).toBe(true)
    expect(decisive.outcome).toBe('inconclusive')
    expect(decisive.estimateOnly).toBe(true)
    for (const thin of [
      { postSpend: 5, postBookings: 3, activeDays: 4 },
      { postSpend: 100, postBookings: 1, activeDays: 4 },
      { postSpend: 100, postBookings: 3, activeDays: 1 },
    ]) {
      const r = scoreSetupDecisionWindow({ ...thin, postCpa: 40, attributionCoverage: null, maxCpa: 100 })
      expect(r.dataSufficient).toBe(false)
      expect(r.outcome).toBe('inconclusive')
    }
  })

  it('low GA4 attribution coverage stays diagnostic-only', () => {
    const r = scoreFlag('winner', 60, 800, 20, 40, 0.2, 7) // 20% attributed < 50% floor
    expect(r.estimateOnly).toBe(true)
    expect(r.confidence).toBe('low')
    expect(r.note).toMatch(/diagnostic only|incremental contribution/i)
  })
})

describe('hookHoldPct + classifyConfidence — no NaN/Infinity leakage', () => {
  it('returns null (not NaN/Infinity) whenever a denominator is zero', () => {
    for (let i = 0; i < 500; i++) {
      const impressions = pick([0, Math.floor(rand() * 5000)])
      const p25 = pick([0, Math.floor(rand() * impressions + 1)])
      const thruplays = pick([0, Math.floor(rand() * (p25 + 1))])
      const { hook, hold } = hookHoldPct(impressions, p25, thruplays)
      for (const v of [hook, hold]) {
        expect(v === null || Number.isFinite(v)).toBe(true)
      }
    }
  })
  it('classifyConfidence is monotone in bookings', () => {
    expect(classifyConfidence(0)).toBe('low')
    expect(classifyConfidence(2)).toBe('low')
    expect(classifyConfidence(5)).toBe('medium')
    expect(classifyConfidence(16)).toBe('high')
  })
})

describe('diffLayer — drift never crashes on ragged live/stored maps', () => {
  it('handles missing/extra/zero days for random windows without throwing', () => {
    for (let i = 0; i < 300; i++) {
      const days = Array.from({ length: 7 }, (_, k) => `2026-07-${String(k + 6).padStart(2, '0')}`)
      const live = new Map<string, number>()
      const stored = new Map<string, number>()
      for (const d of days) {
        if (rand() > 0.3) live.set(d, rand() * 200)
        if (rand() > 0.3) stored.set(d, rand() * 200)
      }
      const layer = diffLayer('daily_insights', live, stored, days)
      expect(layer.drifted_days).toBeGreaterThanOrEqual(0)
      expect(layer.drifted_days).toBeLessThanOrEqual(days.length)
      // worst is set iff at least one day drifted.
      expect(layer.worst !== null).toBe(layer.drifted_days > 0)
      for (const d of layer.days) expect(Number.isFinite(d.delta)).toBe(true)
    }
  })
})
