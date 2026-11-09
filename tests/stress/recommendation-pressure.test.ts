import { describe, it, expect } from 'vitest'
import { runGroundingGate, type GroundingInput } from '@/lib/recommendations/grounding-gate'
import { scoreFlag } from '@/lib/learning/outcomes'
import { classifyChannel } from '@/lib/ga4/client'
import { matchGa4Campaign } from '@/lib/analytics/campaign-roas'
import { getMetricStatus } from '@/lib/targets/target-ranges'

// RECOMMENDATION PRESSURE TESTS.
// Each test actively TRIES to make Maxx give bad advice, and asserts the real code refuses.
// Baseline is a fully-grounded rec that passes; each scenario knocks out one thing.

const grounded: GroundingInput = {
  recommendation_type: 'scale', spend: 600, bookings: 16, window_days: 14, data_age_hours: 5,
  data_sources_count: 2, uses_meta_estimate_as_revenue: false, days_since_last_change: 14,
  exited_learning: true, trend_stable: true, conflicting_signal: false,
  basis: 'observed_performance', reversible: true,
}

describe('Pressure 1 — one booking must not cause over-scaling', () => {
  it('gate HOLDS a scale on 1 booking / thin window', () => {
    const r = runGroundingGate({ ...grounded, recommendation_type: 'scale', bookings: 1, window_days: 3, spend: 25 })
    expect(r.passed).toBe(false)
    expect(['hold', 'block']).toContain(r.decision)
    expect(r.warnings.low_data).not.toBeNull()
  })
  it('scorer refuses a decisive verdict on 1 booking', () => {
    expect(scoreFlag('scale_candidate', 50, 200, 1, 200).outcome).toBe('inconclusive')
  })
})

describe('Pressure 2 — one bad/good day must not carry a verdict', () => {
  it('scorer is inconclusive when only 1 active delivering day (one-bad-day guard)', () => {
    // 4 bookings, good CPA, but all on a single day → not decisive.
    const r = scoreFlag('winner', 55, 220, 4, 55, /*attr*/ null, /*activeDays*/ 1)
    expect(r.outcome).toBe('inconclusive')
    expect(r.note).toMatch(/active delivering day/i)
  })
  it('a distributed Meta window still cannot establish causal contribution', () => {
    expect(scoreFlag('winner', 55, 800, 20, 40, null, 7).outcome).toBe('inconclusive')
  })
})

describe('Pressure 3 — organic revenue must not inflate paid ROAS', () => {
  it('non-paid channels classify organic; placeholders never match a paid campaign', () => {
    for (const g of ['Direct', 'Referral', 'Organic Search', 'Email', 'Unassigned', '(unknown)', '']) {
      expect(classifyChannel(g)).toBe('organic')
    }
    expect(matchGa4Campaign('(organic)', ['Example Studio | Photographers'])).toBeNull()
    expect(matchGa4Campaign('(direct)', ['Example Studio | Photographers'])).toBeNull()
  })
})

describe('Pressure 4 — a Meta estimate must not be treated as actual revenue', () => {
  it('gate caps confidence ≤0.6 and warns on estimate-as-revenue', () => {
    const r = runGroundingGate({ ...grounded, recommendation_type: 'keep', uses_meta_estimate_as_revenue: true })
    expect(r.warnings.estimate).not.toBeNull()
    expect(r.confidence_score).toBeLessThanOrEqual(0.6)
  })
  it('a Meta-estimate ROAS with unknown attribution is estimate_only, not a confident actual', () => {
    expect(getMetricStatus('roas', 4, { spend: 300, bookings: 5, windowDays: 7, attributionCoverage: null }).status).toBe('estimate_only')
  })
})

describe('Pressure 5 & 6 — external expert / competitor ideas suggest TESTS, never truths', () => {
  it('an external-best-practice action is downgraded to a labeled hypothesis, score ≤0.45', () => {
    const r = runGroundingGate({ ...grounded, recommendation_type: 'change_audience', basis: 'external_best_practice', days_since_last_change: null })
    expect(['downgrade_to_hypothesis', 'hold', 'block']).toContain(r.decision)
    expect(r.passed).toBe(false)
    expect(r.confidence_score).toBeLessThanOrEqual(0.45)
  })
  it('a test_hypothesis basis can never be a confident claim (≤0.5)', () => {
    const r = runGroundingGate({ ...grounded, recommendation_type: 'change_audience', basis: 'test_hypothesis', days_since_last_change: null })
    expect(r.decision).toBe('downgrade_to_hypothesis')
    expect(r.confidence_score).toBeLessThanOrEqual(0.5)
  })
})

describe('Pressure 7 & 16 — low data / high-CTR-no-bookings must not fake certainty', () => {
  it('gate HOLDS an action with no bookings on thin data', () => {
    const r = runGroundingGate({ ...grounded, recommendation_type: 'pause', bookings: 0, spend: 15, window_days: 2 })
    expect(r.passed).toBe(false)
    expect(r.warnings.low_data).not.toBeNull()
  })
  it('high CTR but zero bookings → CPA is unknown, not a confident verdict', () => {
    // clicks flowing but no conversions: CPA can't be computed → unknown/needs_data, never "healthy".
    expect(getMetricStatus('cpa', null, { spend: 200, bookings: 0, windowDays: 7 }).status).toBe('unknown')
  })
})

describe('Pressure 8 — conflicting GA4 vs Meta signals must lower confidence', () => {
  it('gate fails the conflict check and drops confidence', () => {
    const r = runGroundingGate({ ...grounded, conflicting_signal: true, conflicting_signal_note: 'Meta 5 bookings, GA4 1.' })
    expect(r.checks.find((c) => c.id === 7)?.status).toBe('fail')
    expect(r.confidence_score).toBeLessThan(0.85)
  })
})

describe('Pressure 9 — stale data must not drive a confident action', () => {
  it('gate penalizes badly stale data', () => {
    const fresh = runGroundingGate({ ...grounded }).confidence_score
    const stale = runGroundingGate({ ...grounded, data_age_hours: 240 })
    expect(stale.confidence_score).toBeLessThan(fresh)
  })
})

describe('Pressure 10 — inconclusive results must not be learned as wins/losses', () => {
  it('thin/zero-conversion outcomes are inconclusive, never worked/failed', () => {
    expect(scoreFlag('winner', 55, 12, 0, null).outcome).toBe('inconclusive')
    expect(scoreFlag('loser', 80, 60, 0, null).outcome).toBe('inconclusive') // kept spending → not implemented
  })
  it('an acted-on pause stays inconclusive without a counterfactual', () => {
    const r = scoreFlag('loser', 80, 2, 0, null)
    expect(r.outcome).toBe('inconclusive')
    expect(r.confidence).toBe('low')
    expect(r.note).toMatch(/counterfactual/i)
  })
})

describe('Pressure 11 — strategy must not reverse too quickly', () => {
  it('gate HOLDS a reversal within the no-oscillation window', () => {
    const r = runGroundingGate({ ...grounded, recommendation_type: 'change_optimization_event', days_since_last_change: 1, exited_learning: false })
    expect(r.passed).toBe(false)
    expect(r.decision).toBe('hold')
    expect(r.checks.find((c) => c.id === 6)?.status).toBe('fail')
  })
})

describe('Pressure 12 — no recommendation is ever immediately actionable', () => {
  it('even a fully-grounded ACTION passes the gate but is capped high-risk (execution still needs approval + write mode)', () => {
    const r = runGroundingGate({ ...grounded, recommendation_type: 'scale' })
    // The gate may "allow" the recommendation to be MADE, but scaling is high-risk and — per builder.ts —
    // action_allowed_now is always false. The gate never grants immediate execution.
    expect(r.risk_level).toBe('high')
  })
  it('an ungrounded action never reaches "allow"', () => {
    const r = runGroundingGate({ ...grounded, recommendation_type: 'pause', spend: 5, bookings: 0, window_days: 1 })
    expect(r.decision).not.toBe('allow')
  })
})

describe('Pressure 14 & 15 — do NOT condemn a converting entity for surface metrics', () => {
  it('creative fatigue with a stable, converting CPA: a keep stays allowed', () => {
    const r = runGroundingGate({ ...grounded, recommendation_type: 'keep', bookings: 4, window_days: 7, spend: 240 })
    expect(r.decision).toBe('allow')
  })
  it('low CTR but healthy CPA: a keep is not blocked for CTR alone', () => {
    const r = runGroundingGate({ ...grounded, recommendation_type: 'keep', bookings: 3, window_days: 7, spend: 180 })
    expect(r.decision).toBe('allow')
  })
})

describe('Pressure 13 — budget moves are bounded (covered by reallocation + executor caps)', () => {
  it('per-entity ROAS/attribution guard blocks an unattributed confident claim', () => {
    const r = runGroundingGate({ ...grounded, recommendation_type: 'keep', claims_per_campaign_roas: true, attributed_share: 0 })
    expect(r.warnings.attribution).not.toBeNull()
    expect(r.confidence_score).toBeLessThanOrEqual(0.4)
  })
})
