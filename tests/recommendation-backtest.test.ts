import { describe, it, expect } from 'vitest'
import { buildRecommendation, formatRecommendation, type BuildRecommendationInput } from '@/lib/recommendations/builder'

// Recommendation backtest. These are LABELED SYNTHETIC fixtures — plausible
// scenarios, NOT claims that these results happened on any real account. They assert that the
// grounding gate produces the RIGHT behaviour end-to-end via buildRecommendation().

const TODAY = '2026-06-28'

function rec(over: Partial<BuildRecommendationInput>): ReturnType<typeof buildRecommendation> {
  const base: BuildRecommendationInput = {
    recommendation_type: 'keep',
    target_entity_type: 'adset',
    target_entity_name: 'Synthetic Ad Set',
    observed_fact: 'synthetic',
    reason_for_action: 'synthetic',
    basis: 'observed_performance',
    spend: 300,
    bookings: 5,
    window_days: 7,
    data_age_hours: 6,
    exited_learning: true,
    trend_stable: true,
    today: TODAY,
  }
  return buildRecommendation({ ...base, ...over })
}

describe('recommendation backtest (synthetic fixtures)', () => {
  it('correctly identifies a real winner and allows a grounded scale', () => {
    const r = rec({
      recommendation_type: 'scale',
      observed_fact: '[SYNTHETIC] CPA $48 over 14d on 11 bookings, frequency healthy.',
      reason_for_action: 'Beat target on a full week with headroom.',
      metric_values: [
        { name: 'cpa', value: 48, source: 'meta_api', unit: '$' },
        { name: 'bookings', value: 11, source: 'ga4', unit: 'count' },
      ],
      spend: 660,
      bookings: 11,
      window_days: 14,
      days_since_last_change: 14,
    })
    expect(r.recommendation_type).toBe('scale')
    expect(r.grounding.passed).toBe(true)
    expect(['high', 'medium']).toContain(r.confidence_label)
    expect(r.approval_required).toBe(true)
    expect(r.action_allowed_now).toBe(false) // write mode off — always human-gated
    expect(r.risk_level).toBe('high')
  })

  it('does NOT condemn a false loser (low CTR but good CPA) — keep stays allowed', () => {
    const r = rec({
      recommendation_type: 'keep',
      observed_fact: '[SYNTHETIC] CTR 0.4% but CPA $55 on 4 bookings — the funnel converts despite a weak hook.',
      reason_for_action: 'Cheap bookings; do not pause on CTR alone.',
      bookings: 4,
      spend: 240,
    })
    expect(r.recommendation_type).toBe('keep')
    expect(r.grounding.passed).toBe(true)
  })

  it('avoids scaling without enough booking data (holds it)', () => {
    const r = rec({ recommendation_type: 'scale', bookings: 1, spend: 60, window_days: 7, days_since_last_change: 14 })
    expect(r.recommendation_type).toBe('hold')
    expect(r.grounding.passed).toBe(false)
  })

  it('avoids pausing on weak data (holds it)', () => {
    const r = rec({ recommendation_type: 'pause', spend: 8, bookings: 0, window_days: 1 })
    expect(r.recommendation_type).toBe('hold')
    expect(r.low_data_warning).not.toBeNull()
  })

  it('separates actual GA4 revenue from a Meta estimate', () => {
    const r = rec({
      recommendation_type: 'keep',
      uses_meta_estimate_as_revenue: true,
      observed_fact: '[SYNTHETIC] Meta reports 3.1x ROAS.',
      reason_for_action: 'Looks profitable on Meta numbers.',
    })
    expect(r.estimate_warning).not.toBeNull()
    expect(r.confidence_score).toBeLessThanOrEqual(0.6)
  })

  it('handles a dormant account by holding performance actions', () => {
    const r = rec({ recommendation_type: 'pause', account_dormant: true })
    expect(r.recommendation_type).toBe('hold')
    expect(r.low_data_warning).toMatch(/dormant|pre-launch/i)
  })

  it('blocks per-campaign ROAS claims with low attribution coverage', () => {
    const r = rec({
      recommendation_type: 'keep',
      claims_per_campaign_roas: true,
      attributed_share: 0.0,
      observed_fact: '[SYNTHETIC] Campaign X shows 4x per-campaign ROAS.',
    })
    expect(r.attribution_warning).not.toBeNull()
  })

  it('labels confidence and risk, and always explains what could make it wrong', () => {
    const r = rec({ recommendation_type: 'reduce_budget', observed_fact: '[SYNTHETIC] CPA drifting up.', reason_for_action: 'Throttle a fading ad set.', spend: 300, bookings: 4, window_days: 7, days_since_last_change: 14 })
    expect(['high', 'medium', 'low', 'insufficient']).toContain(r.confidence_label)
    expect(['low', 'medium', 'high']).toContain(r.risk_level)
    expect(r.what_could_make_this_wrong.length).toBeGreaterThan(0)
    expect(r.recommended_next_check_date).toBe('2026-07-05')
  })

  it('renders a readable recommendation string with the safety fields', () => {
    const r = rec({ recommendation_type: 'scale', spend: 660, bookings: 11, window_days: 14, days_since_last_change: 14 })
    const s = formatRecommendation(r)
    expect(s).toMatch(/Confidence:/)
    expect(s).toMatch(/Approval required:/)
    expect(s).toMatch(/Action allowed now:/)
  })
})
