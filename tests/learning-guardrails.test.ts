import { describe, it, expect } from 'vitest'
import { scoreFlag, classifyConfidence, lessonCategory } from '@/lib/learning/outcomes'

// Guardrails that stop the learning loop from FALSE-learning. These are the exact
// failure modes called out: never-implemented recs, low-spend, thin conversions, conflicting data.

describe('classifyConfidence', () => {
  it('scales with count precision and active-day coverage', () => {
    expect(classifyConfidence(16, 7)).toBe('high')
    expect(classifyConfidence(5, 5)).toBe('medium')
    expect(classifyConfidence(2, 5)).toBe('low')
    expect(classifyConfidence(1)).toBe('low')
    expect(classifyConfidence(0)).toBe('low')
  })
})

describe('lessonCategory', () => {
  it('separates creative / budget / performance lessons', () => {
    expect(lessonCategory('creative_refresh')).toBe('creative')
    expect(lessonCategory('scale_candidate')).toBe('budget')
    expect(lessonCategory('winner')).toBe('performance')
    expect(lessonCategory('loser')).toBe('performance')
  })
})

describe('scoreFlag guardrails', () => {
  it('does NOT mark a pause "failed" when it was never implemented (kept spending)', () => {
    // loser flag, but the entity kept spending $60 → almost certainly not paused. Must be inconclusive.
    const r = scoreFlag('loser', 80, 60, 0, null)
    expect(r.outcome).toBe('inconclusive')
    expect(r.note).toMatch(/not implemented/i)
  })

  it('does not confuse implementation confirmation with causal commercial impact', () => {
    const r = scoreFlag('loser', 80, 2, 0, null)
    expect(r.outcome).toBe('inconclusive')
    expect(r.estimateOnly).toBe(true)
    expect(r.note).toMatch(/incremental contribution|causal/i)
  })

  it('will not call a keep/scale "worked" on too little spend', () => {
    const r = scoreFlag('winner', 50, 10, 0, null)
    expect(r.outcome).toBe('inconclusive')
  })

  it('will not call a keep/scale decisive below the booking bar', () => {
    const r = scoreFlag('winner', 50, 200, 1, 200) // 1 booking only
    expect(r.outcome).toBe('inconclusive')
  })

  it('does not call a sustained low Meta-modelled CPA a commercial win', () => {
    const r = scoreFlag('winner', 55, 800, 20, 40, null, 7)
    expect(r.outcome).toBe('inconclusive')
    expect(r.confidence).toBe('low')
    expect(r.estimateOnly).toBe(true)
  })

  it('does not call a high Meta-modelled CPA a causal scale failure', () => {
    const r = scoreFlag('scale_candidate', 55, 3_000, 20, 150, null, 7)
    expect(r.outcome).toBe('inconclusive')
    expect(r.estimateOnly).toBe(true)
  })

  it('treats delayed/zero conversions on thin spend as inconclusive, not failed', () => {
    const r = scoreFlag('winner', 55, 12, 0, null)
    expect(r.outcome).toBe('inconclusive')
  })
})
