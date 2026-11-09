import { describe, it, expect } from 'vitest'
import { tallyTrackRecord } from '@/lib/recommendations/knowledge'
import { breakdownBookingsComplete, judge } from '@/lib/learning/patterns'
import { recencyWeight } from '@/lib/learning/model'
import { applyExampleOwnerTargetsPerTest } from './helpers/example-targets'

// cost metrics have no built-in target; these suites test behaviour WITH the owner's target set.
applyExampleOwnerTargetsPerTest()

// OWNER-GATED learning wiring — the before/after evidence this PR carries.
// recencyWeight into tallyTrackRecord (old lessons fade, half-life 17d).
// Historical Meta records are never injected as priors into current learned patterns.

const TODAY = '2026-07-10'
const daysAgo = (n: number) => new Date(new Date(TODAY + 'T00:00:00Z').getTime() - n * 86_400_000).toISOString()

describe('recency: tallyTrackRecord', () => {
  const rows = [
    { flag_type: 'scale_candidate', metric_name: 'causal_incremental_contribution', outcome: 'worked', outcome_note: '', review_status: 'approved', evaluated_at: daysAgo(2) },
    { flag_type: 'scale_candidate', metric_name: 'causal_incremental_contribution', outcome: 'failed', outcome_note: '', review_status: 'approved', evaluated_at: daysAgo(170) },
  ]

  it('BEFORE (no today passed): a 6-month-old failure weighs exactly like a fresh win', () => {
    const t = tallyTrackRecord(rows)
    expect(t.scale_candidate.wins).toBe(1)
    expect(t.scale_candidate.decisive).toBe(2) // 1 win + 1 old failure, equal weight
  })

  it('AFTER (today passed): the old lesson fades — fresh evidence dominates', () => {
    const t = tallyTrackRecord(rows, TODAY)
    const freshW = recencyWeight(2) // ≈ 0.92
    const oldW = recencyWeight(170) // ≈ 0.001
    expect(t.scale_candidate.wins).toBeCloseTo(freshW, 3)
    expect(t.scale_candidate.decisive).toBeCloseTo(freshW + oldW, 3)
    // Win-rate implied by the tally flips from 0.5 (before) to ~1.0 (after) — the 6-month-old failure
    // no longer vetoes a currently-working play.
    expect(t.scale_candidate.wins / t.scale_candidate.decisive).toBeGreaterThan(0.99)
  })

  it('rows without evaluated_at keep weight 1 (back-compat), gates unchanged (approved-only)', () => {
    const t = tallyTrackRecord(
      [
        { flag_type: 'loser', metric_name: 'causal_incremental_contribution', outcome: 'worked', outcome_note: '', review_status: 'approved' },
        { flag_type: 'loser', metric_name: 'causal_incremental_contribution', outcome: 'worked', outcome_note: '', review_status: 'pending', evaluated_at: daysAgo(1) },
        { flag_type: 'loser', metric_name: 'causal_incremental_contribution', outcome: 'worked', outcome_note: 'estimate-only lesson', review_status: 'approved', evaluated_at: daysAgo(1) },
      ],
      TODAY,
    )
    expect(t.loser.wins).toBe(1) // pending + estimate-only still contribute nothing
  })

  it('withholds legacy CPA outcomes even when approved', () => {
    expect(tallyTrackRecord([
      { flag_type: 'winner', metric_name: 'cpa', outcome: 'worked', outcome_note: '', review_status: 'approved' },
    ])).toEqual({})
  })
})

describe('patterns.judge has no historical champion prior', () => {
  it('rejects a partial breakdown outcome plane instead of learning zero conversions', () => {
    expect(breakdownBookingsComplete([{ bookings: 1 }, { bookings: null }])).toBe(false)
    expect(breakdownBookingsComplete([{ bookings: 1 }, { bookings: 0 }])).toBe(true)
  })

  it('keeps a one-booking $200 modelled CPA diagnostic without shrinking it toward history', () => {
    const v = judge({ spend: 200, bookings: 1, clicks: 50, impressions: 2000 })
    expect(v.verdict).toBe('weak')
    expect(v.confidence).toBe('low')
    expect(v.recommendation).not.toMatch(/champion|shrunk|prior/i)
  })

  it('an eight-booking $200 modelled CPA also stays weak without a prior', () => {
    const v = judge({ spend: 1600, bookings: 8, clicks: 300, impressions: 12000 })
    expect(v.verdict).toBe('weak')
  })

  it('unchanged: 0-booking verdicts and decisive-strong still behave as before', () => {
    expect(judge({ spend: 100, bookings: 0, clicks: 10, impressions: 1000 }).verdict).toBe('weak')
    expect(judge({ spend: 20, bookings: 0, clicks: 5, impressions: 400 }).verdict).toBe('insufficient')
    // A genuinely strong segment (decisive better at volume — passes the Poisson bound) stays strong:
    const strong = judge({ spend: 450, bookings: 15, clicks: 300, impressions: 12000 }) // $30 CPA on 15 bookings
    expect(strong.verdict).toBe('strong')
  })
})
