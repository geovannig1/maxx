import './_support/outcome-noun-booking'
import { describe, it, expect } from 'vitest'
import { groupLearningNarrative, type NarrativeOutcome, type NarrativePattern } from '@/lib/recommendations/learning-narrative'

function outcome(over: Partial<NarrativeOutcome>): NarrativeOutcome {
  return { flag_type: 'high_cpa', metric_name: 'causal_incremental_contribution', outcome: 'worked', review_status: 'pending', estimate_only: false, ...over }
}
function pattern(over: Partial<NarrativePattern>): NarrativePattern {
  return { dimension: 'audience', segment: 'lookalike', verdict: 'strong', ...over }
}

describe('groupLearningNarrative — outcomes', () => {
  it('approved, decisive outcomes are trusted', () => {
    const r = groupLearningNarrative({ outcomes: [outcome({ review_status: 'approved' })], patterns: [] })
    expect(r.trusted).toHaveLength(1)
    expect(r.trusted[0].kind).toBe('outcome')
  })

  it('pending, decisive outcomes await review', () => {
    const r = groupLearningNarrative({ outcomes: [outcome({ review_status: 'pending' })], patterns: [] })
    expect(r.awaitingReview).toHaveLength(1)
  })

  it('rejected outcomes become informative hypotheses with framing', () => {
    const r = groupLearningNarrative({ outcomes: [outcome({ review_status: 'rejected', recommendation: 'Cut the ad set' })], patterns: [] })
    expect(r.hypotheses).toHaveLength(1)
    expect(r.hypotheses[0].detail).toMatch(/kept as a hypothesis/)
  })

  it('inconclusive outcomes are excluded with a plain why', () => {
    const r = groupLearningNarrative({ outcomes: [outcome({ outcome: 'inconclusive' })], patterns: [] })
    expect(r.excluded).toHaveLength(1)
    expect(r.excluded[0].why).toMatch(/Inconclusive/)
  })

  it('outcomes the owner marked inconclusive are excluded', () => {
    const r = groupLearningNarrative({ outcomes: [outcome({ outcome: 'worked', review_status: 'inconclusive' })], patterns: [] })
    expect(r.excluded[0].why).toMatch(/marked this inconclusive/)
  })

  it('estimate-only outcomes NEVER land in trusted, even when approved', () => {
    const r = groupLearningNarrative({
      outcomes: [outcome({ flag_type: 'estimate_flag', outcome: 'worked', review_status: 'approved', estimate_only: true })],
      patterns: [],
    })
    expect(r.trusted.some((e) => e.title.includes('estimate_flag'))).toBe(false)
    const ex = r.excluded.find((e) => e.item.title.includes('estimate_flag'))
    expect(ex).toBeDefined()
    expect(ex!.why).toMatch(/Estimate-only \(GA4 attribution below 50%\)/)
  })

  it('legacy CPA outcomes remain diagnostic even when approved', () => {
    const r = groupLearningNarrative({
      outcomes: [outcome({ metric_name: 'cpa', review_status: 'approved' })],
      patterns: [],
    })
    expect(r.trusted).toHaveLength(0)
    expect(r.excluded[0].why).toMatch(/not measured as causal incremental contribution/i)
  })
})

describe('groupLearningNarrative — patterns', () => {
  it('strong patterns are trusted; mixed/weak/insufficient are all hypotheses', () => {
    const r = groupLearningNarrative({
      outcomes: [],
      patterns: [
        pattern({ verdict: 'strong' }),
        pattern({ verdict: 'mixed' }),
        pattern({ verdict: 'weak' }),
        pattern({ verdict: 'insufficient' }),
      ],
    })
    expect(r.trusted).toHaveLength(1)
    expect(r.hypotheses).toHaveLength(3)
    expect(r.excluded).toHaveLength(0)
  })
})

describe('groupLearningNarrative — headline', () => {
  it('summarizes trusted · hypotheses · awaiting review (pluralized)', () => {
    const r = groupLearningNarrative({
      outcomes: [outcome({ review_status: 'approved' }), outcome({ review_status: 'pending' })],
      patterns: [pattern({ verdict: 'mixed' })],
    })
    expect(r.headline).toBe('1 trusted learning · 1 hypothesis · 1 awaiting your review')
  })

  it('pluralizes correctly for multiples', () => {
    const r = groupLearningNarrative({
      outcomes: [outcome({ review_status: 'approved' }), outcome({ review_status: 'approved' }), outcome({ review_status: 'pending' }), outcome({ review_status: 'pending' })],
      patterns: [pattern({ verdict: 'mixed' }), pattern({ verdict: 'weak' })],
    })
    expect(r.headline).toBe('2 trusted learnings · 2 hypotheses · 2 awaiting your review')
  })
})

describe('groupLearningNarrative — pattern meta completeness', () => {
  it('meta carries the verdict word, CPA, CTR, win rate, bookings, and confidence', () => {
    const r = groupLearningNarrative({
      outcomes: [],
      patterns: [pattern({ verdict: 'mixed', cpa: 42.5, ctr: 1.234, win_rate: 0.6, sample_bookings: 4, confidence: 'medium' })],
    })
    expect(r.hypotheses).toHaveLength(1)
    const meta = r.hypotheses[0].meta ?? ''
    expect(meta).toContain('mixed') // verdict word distinguishes mixed vs weak (tone color alone cannot)
    expect(meta).toContain('CPA $42.50')
    expect(meta).toContain('CTR 1.23%')
    expect(meta).toContain('win rate 60%')
    expect(meta).toContain('4 bookings')
    expect(meta).toContain('confidence: medium')
  })
})
