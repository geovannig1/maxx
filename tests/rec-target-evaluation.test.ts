import { describe, it, expect } from 'vitest'
import { buildRecommendation, formatRecommendation } from '@/lib/recommendations/builder'
import { applyExampleOwnerTargetsPerTest } from './helpers/example-targets'

// cost metrics have no built-in target; these suites test behaviour WITH the owner's target set.
applyExampleOwnerTargetsPerTest()

const base = {
  recommendation_type: 'keep' as const,
  target_entity_type: 'adset' as const,
  observed_fact: 'test',
  reason_for_action: 'test',
  basis: 'observed_performance' as const,
}

describe('recommendation target_evaluation (dynamic ranges)', () => {
  it('CPA $66.40 with adequate data → watch (not a failure), surfaced in the formatted output', () => {
    const rec = buildRecommendation({
      ...base,
      spend: 300,
      bookings: 5,
      window_days: 7,
      attributed_share: 0.7,
      primary_metric: { metric: 'cpa', value: 66.4 },
    })
    expect(rec.target_evaluation?.status).toBe('watch')
    expect(formatRecommendation(rec)).toMatch(/watch range/i)
    expect(formatRecommendation(rec)).toMatch(/PROVISIONAL diagnostic reference.*not an owner-governed business target/i)
  })

  it('High CPA on thin data → needs_data, never a confident loser', () => {
    const rec = buildRecommendation({
      ...base,
      spend: 10,
      bookings: 0,
      window_days: 1,
      primary_metric: { metric: 'cpa', value: 150 },
    })
    expect(rec.target_evaluation?.status).toBe('needs_data')
  })

  it('no primary_metric → no target_evaluation (back-compat)', () => {
    const rec = buildRecommendation({ ...base, spend: 300, bookings: 5, window_days: 7 })
    expect(rec.target_evaluation).toBeNull()
  })
})
