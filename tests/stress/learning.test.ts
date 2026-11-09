import { describe, it, expect } from 'vitest'
import { scoreFlag, classifyConfidence } from '@/lib/learning/outcomes'

// ─────────────────────────────────────────────────────────────────────────────────────────────
// the learning scorer receives Meta-estimate bookings, not causal contribution evidence.
// ─────────────────────────────────────────────────────────────────────────────────────────────
describe('estimate↔actual reconciliation in the learning scorer', () => {
  it('with NO coverage signal, a thin Meta winner remains inconclusive', () => {
    const r = scoreFlag('winner', 50, 200, 5, 40)
    expect(r.outcome).toBe('inconclusive')
    expect(r.confidence).toBe('low')
    expect(r.estimateOnly).toBe(true)
  })

  it('withholds a Meta winner from commercial learning when GA4 coverage is low', () => {
    const r = scoreFlag('winner', 50, 800, 20, 40, /* attributionCoverage */ 0.1, 7)
    expect(r.outcome).toBe('inconclusive')
    expect(r.confidence).toBe('low')
    expect(r.estimateOnly).toBe(true)
    expect(r.note).toMatch(/diagnostic only|incremental contribution/i)
  })

  it('marks even a thin diagnostic inconclusive as non-commercial evidence', () => {
    const r = scoreFlag('winner', 50, 200, 1, 40, 0.1) // 1 booking ⇒ inconclusive
    expect(r.outcome).toBe('inconclusive')
    expect(r.estimateOnly).toBe(true)
  })

  it('does not turn high GA4 tag coverage into causal proof', () => {
    const r = scoreFlag('winner', 50, 800, 20, 40, 0.9, 7)
    expect(r.outcome).toBe('inconclusive')
    expect(r.confidence).toBe('low')
    expect(r.estimateOnly).toBe(true)
    expect(r.note).toMatch(/causal counterfactual|incremental contribution/i)
  })
})

// ─────────────────────────────────────────────────────────────────────────────────────────────
// count uncertainty and active-day coverage prevent a lucky week from reading as stable proof.
// ─────────────────────────────────────────────────────────────────────────────────────────────
describe('confidence reflects count uncertainty and active-day coverage', () => {
  it('uses Poisson relative error instead of a five-booking high-confidence shortcut', () => {
    expect(classifyConfidence(16, 7)).toBe('high')
    expect(classifyConfidence(5, 5)).toBe('medium')
    expect(classifyConfidence(2, 5)).toBe('low')
    expect(classifyConfidence(1)).toBe('low')
  })

  it('a one-lucky-window point estimate cannot mint a worked lesson', () => {
    const lucky = scoreFlag('winner', null, 90, 5, 18, null, 1)
    expect(lucky.confidence).toBe('low')
    expect(lucky.outcome).toBe('inconclusive')
  })
})

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Existing guardrails that DO hold — confirm the strong parts of the loop still pass (regression guard).
// ─────────────────────────────────────────────────────────────────────────────────────────────
describe('learning guardrails that correctly hold', () => {
  it('never blames an unimplemented pause (kept spending ⇒ inconclusive, not failed)', () => {
    const r = scoreFlag('loser', 50, /* postSpend */ 200, /* postBookings */ 3, /* postCpa */ 70)
    expect(r.outcome).toBe('inconclusive')
  })

  it('does not confuse a pause being implemented with proof it created contribution', () => {
    const r = scoreFlag('loser', 50, /* postSpend */ 2, /* postBookings */ 0, /* postCpa */ null)
    expect(r.outcome).toBe('inconclusive')
    expect(r.estimateOnly).toBe(true)
  })

  it('refuses a decisive verdict below the booking bar', () => {
    const r = scoreFlag('winner', 50, /* postSpend */ 200, /* postBookings */ 1, /* postCpa */ 40)
    expect(r.outcome).toBe('inconclusive')
  })
})
