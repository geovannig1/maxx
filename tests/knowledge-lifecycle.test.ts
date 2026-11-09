import { describe, it, expect } from 'vitest'
import { renderKnowledgeDigest } from '@/lib/report/weekly'

// the weekly Knowledge & Learning digest: what entered/left the knowledge
// base and what the learning loop is waiting on, rendered deterministically (no LLM required).

describe('renderKnowledgeDigest', () => {
  const today = '2026-07-10'

  it('counts approved vs pending and nudges review when pending exist', () => {
    const d = renderKnowledgeDigest({
      insights: [
        { review_status: 'approved', expires_at: '2026-12-01', title: 'A' },
        { review_status: 'pending', expires_at: null, title: 'B' },
        { review_status: null, expires_at: null, title: 'C' }, // null = pending (fail-closed)
        { review_status: 'rejected', expires_at: null, title: 'D' },
      ],
      patterns: [],
      pendingOutcomeReviews: 0,
      today,
    })
    expect(d).toContain('1 approved')
    expect(d).toContain('2 pending your review')
    expect(d).toContain('← review these')
  })

  it('lists approved insights expiring within 14 days (re-approve or lapse)', () => {
    const d = renderKnowledgeDigest({
      insights: [
        { review_status: 'approved', expires_at: '2026-07-20', title: 'Expiring soon tip' },
        { review_status: 'approved', expires_at: '2026-10-01', title: 'Far away tip' },
        { review_status: 'pending', expires_at: '2026-07-12', title: 'Pending never listed' },
      ],
      patterns: [],
      pendingOutcomeReviews: 0,
      today,
    })
    expect(d).toContain('Expiring ≤14 days')
    expect(d).toContain('Expiring soon tip')
    expect(d).not.toContain('Far away tip')
    expect(d).not.toContain('Pending never listed')
  })

  it('labels owner-reviewed recommendation history without calling modelled segment averages decisive', () => {
    const d = renderKnowledgeDigest({
      insights: [],
      patterns: [
        { dimension: 'recommendation_type', segment: 'scale_candidate', verdict: 'strong' },
        { dimension: 'recommendation_type', segment: 'loser', verdict: 'weak' },
      ],
      pendingOutcomeReviews: 3,
      today,
    })
    expect(d).toContain('2 owner-reviewed')
    expect(d).toMatch(/1 strong/)
    expect(d).toMatch(/1 weak/)
    expect(d).toContain('scale_candidate = strong')
    expect(d).not.toContain('Decisive patterns')
    expect(d).toContain('3 lesson(s) pending')
  })

  it('renders a complete section shape (heading + all lines) even when empty', () => {
    const d = renderKnowledgeDigest({ insights: [], patterns: [], pendingOutcomeReviews: 0, today })
    expect(d).toContain('## Knowledge & Learning')
    expect(d).toContain('0 approved')
    expect(d).toContain('none yet')
  })
})
