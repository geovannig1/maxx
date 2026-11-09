import './_support/outcome-noun-booking'
import { describe, it, expect } from 'vitest'
import { runGroundingGate, type GroundingInput } from '@/lib/recommendations/grounding-gate'
import { buildRecommendation, type BuildRecommendationInput } from '@/lib/recommendations/builder'
import { judge } from '@/lib/learning/patterns'
import {
  filterUsableInsights,
  projectCitableInsights,
  tallyTrackRecord,
  overallWinRate,
  resolvePriorWinRate,
  areaForFlag,
} from '@/lib/recommendations/knowledge'
import type { BenchmarkPrior } from '@/lib/learning/model'
import { applyExampleOwnerTargetsPerTest } from './helpers/example-targets'

// cost metrics have no built-in target; these suites test behaviour WITH the owner's target set.
applyExampleOwnerTargetsPerTest()

// Tests for the recommendation-intelligence WIRING (this PR): the track-record adjuster in the gate,
// the variance-aware "scale here" verdict, the governed external-knowledge readers, and the honesty
// fields on the builder. Each proves the wiring IMPROVES behavior without inflating confidence.

const groundedScale: GroundingInput = {
  recommendation_type: 'scale', spend: 600, bookings: 16, window_days: 14, data_age_hours: 5,
  data_sources_count: 2, uses_meta_estimate_as_revenue: false, days_since_last_change: 14,
  exited_learning: true, trend_stable: true, conflicting_signal: false,
  basis: 'observed_performance', reversible: true,
}

describe('Gate track-record adjuster — history TEMPERS, never drives (owner directive)', () => {
  it('absent track record leaves the score unchanged', () => {
    const base = runGroundingGate(groundedScale).confidence_score
    const withNone = runGroundingGate({ ...groundedScale, track_record: { wins: 0, decisive: 0 } }).confidence_score
    expect(withNone).toBe(base)
  })
  it('a repeatedly-failing track record LOWERS the score and cites why', () => {
    const base = runGroundingGate(groundedScale).confidence_score
    const r = runGroundingGate({ ...groundedScale, track_record: { wins: 2, decisive: 40, priorWinRate: 0.5 } })
    expect(r.confidence_score).toBeLessThan(base)
    expect(r.reasons.some((x) => /track record/i.test(x))).toBe(true)
  })
  it('a winning/neutral track record does NOT penalize a well-grounded call', () => {
    const base = runGroundingGate(groundedScale).confidence_score
    expect(runGroundingGate({ ...groundedScale, track_record: { wins: 38, decisive: 40, priorWinRate: 0.5 } }).confidence_score).toBe(base)
    expect(runGroundingGate({ ...groundedScale, track_record: { wins: 20, decisive: 40, priorWinRate: 0.5 } }).confidence_score).toBe(base)
  })
})

describe('patterns.judge — variance-aware "scale here"', () => {
  const agg = (spend: number, bookings: number) => ({ spend, bookings, clicks: 100, impressions: 5000 })
  it('a thin lucky segment (great point-CPA, 2 bookings) is MIXED, not "scale here"', () => {
    const v = judge(agg(100, 2)) // $50 CPA vs $64 target, but 2 bookings = noise
    expect(v.verdict).toBe('mixed')
    expect(v.recommendation).toMatch(/not yet a decisive win|gather more/i)
  })
  it('a robust cheap segment is STRONG (decisively better)', () => {
    const v = judge(agg(600, 20)) // ~$30 CPA over 20 bookings, tight CI
    expect(v.verdict).toBe('strong')
  })
  it('spend with zero bookings is weak, not scale', () => {
    expect(judge(agg(120, 0)).verdict).toBe('weak')
    expect(judge(agg(40, 0)).verdict).toBe('insufficient')
  })
})

describe('knowledge readers (pure)', () => {
  it('filterUsableInsights keeps applies_to_account + unexpired + OWNER-APPROVED, drops the rest (035 gate)', () => {
    const rows = [
      { applies_to_account: true, expires_at: null, review_status: 'approved' },
      { applies_to_account: true, expires_at: '2020-01-01', review_status: 'approved' }, // expired
      { applies_to_account: false, expires_at: null, review_status: 'approved' }, // not applicable
      { applies_to_account: true, expires_at: '2099-01-01', review_status: 'approved' },
      { applies_to_account: true, expires_at: null, review_status: 'pending' }, // excluded: not reviewed
      { applies_to_account: true, expires_at: null, review_status: 'rejected' }, // excluded: rejected
      { applies_to_account: true, expires_at: null }, // excluded: no review_status (legacy row) — fail-closed
    ]
    const kept = filterUsableInsights(rows, '2026-06-30')
    expect(kept).toHaveLength(2)
  })
  it('filterUsableInsights is FAIL-CLOSED: nothing citable without explicit approval', () => {
    expect(filterUsableInsights([{ applies_to_account: true, expires_at: null, review_status: null }], '2026-06-30')).toHaveLength(0)
    expect(filterUsableInsights([{ applies_to_account: true, expires_at: null, review_status: 'pending' }], '2026-06-30')).toHaveLength(0)
  })
  it('requires resolved source provenance before an approved expert insight becomes citable', () => {
    const rows = [
      { id: 'missing', summary: 'Claim without lineage', title: null, confidence: 'high', applicable_area: 'budget', source_id: null, what_not_to_assume: null },
      { id: 'orphan', summary: 'Claim with orphan source', title: null, confidence: 'high', applicable_area: 'budget', source_id: 's-orphan', what_not_to_assume: null },
      { id: 'good', summary: 'Conditional sourced claim', title: null, confidence: 'medium', applicable_area: 'budget', source_id: 's-good', what_not_to_assume: 'Do not turn this into a universal threshold.' },
    ]
    const projected = projectCitableInsights(rows, new Map([['s-good', 'Meta official']]), 5)
    expect(projected).toEqual([expect.objectContaining({
      id: 'good',
      source: 'Meta official',
      caveat: 'Do not turn this into a universal threshold.',
    })])
  })
  it('tallyTrackRecord counts only APPROVED, non-estimate-only, decisive lessons (review gate)', () => {
    const t = tallyTrackRecord([
      { flag_type: 'loser', metric_name: 'causal_incremental_contribution', outcome: 'worked', outcome_note: 'clean', review_status: 'approved' },
      { flag_type: 'loser', metric_name: 'causal_incremental_contribution', outcome: 'failed', outcome_note: 'clean', review_status: 'approved' },
      { flag_type: 'loser', metric_name: 'cpa', outcome: 'worked', outcome_note: 'clean', review_status: 'approved' }, // excluded: wrong objective
      { flag_type: 'loser', metric_name: 'causal_incremental_contribution', outcome: 'worked', outcome_note: '[estimate-only — GA4 30%] ...', review_status: 'approved' }, // excluded: estimate-only
      { flag_type: 'loser', metric_name: 'causal_incremental_contribution', outcome: 'worked', outcome_note: 'clean', review_status: 'pending' }, // excluded: not approved
      { flag_type: 'loser', metric_name: 'causal_incremental_contribution', outcome: 'failed', outcome_note: 'clean', review_status: 'rejected' }, // excluded: rejected
      { flag_type: 'scale_candidate', metric_name: 'causal_incremental_contribution', outcome: 'inconclusive', outcome_note: 'thin', review_status: 'approved' }, // not decisive
    ])
    expect(t.loser).toEqual({ wins: 1, decisive: 2 })
    expect(t.scale_candidate).toEqual({ wins: 0, decisive: 0 })
  })
  it('tallyTrackRecord keeps learning FROZEN until an outcome is approved (default pending/unset)', () => {
    const t = tallyTrackRecord([
      { flag_type: 'loser', metric_name: 'causal_incremental_contribution', outcome: 'worked', outcome_note: 'clean', review_status: 'pending' },
      { flag_type: 'loser', metric_name: 'causal_incremental_contribution', outcome: 'failed', outcome_note: 'clean' }, // no review_status = not approved
    ])
    expect(t.loser).toBeUndefined()
  })
  it('overallWinRate is null with no decisive lessons', () => {
    expect(overallWinRate({})).toBeNull()
    expect(overallWinRate({ loser: { wins: 1, decisive: 2 } })).toBeCloseTo(0.5)
  })
  it('resolvePriorWinRate: account wins; benchmark is a discounted fallback; else neutral', () => {
    expect(resolvePriorWinRate(null, null)).toEqual({ priorWinRate: 0.5, k: 1 })
    expect(resolvePriorWinRate(0.62, null)).toEqual({ priorWinRate: 0.62, k: 3 })
    const bench: BenchmarkPrior = { source: 'benchmark', niche: 'fragrance', cpa: 35, winRate: 0.7, strength: 5 }
    const p = resolvePriorWinRate(null, bench)
    expect(p.priorWinRate).toBe(0.7)
    expect(p.k).toBeLessThanOrEqual(2) // discounted — a different niche can't dominate
  })
  it('areaForFlag maps flag types to insight areas', () => {
    expect(areaForFlag('creative_refresh')).toBe('creative')
    expect(areaForFlag('scale_candidate')).toBe('budget')
    expect(areaForFlag('winner')).toBeNull()
  })
})

describe('builder honesty fields + external knowledge (no inflation)', () => {
  const base: BuildRecommendationInput = {
    recommendation_type: 'scale', target_entity_type: 'adset',
    observed_fact: 'CPA $40 on 8 bookings over 14 days.', reason_for_action: 'Efficient winner with room to scale.',
    basis: 'observed_performance',
    metric_values: [
      { name: 'CPA', value: 40, unit: '$', source: 'meta_api' },
      { name: 'Bookings', value: 8, unit: 'count', source: 'meta_api' },
    ],
    spend: 600, bookings: 8, window_days: 14, data_age_hours: 5,
    uses_meta_estimate_as_revenue: false, days_since_last_change: 14, exited_learning: true,
    trend_stable: true, attributed_share: 0.8, reversible: true, today: '2026-06-15',
  }

  it('populates impact context but withholds learning eligibility without a causal contribution contract', () => {
    const r = buildRecommendation(base)
    expect(r.expected_upside).toBeTruthy()
    expect(r.possible_downside).toBeTruthy()
    expect(r.attribution_confidence).toBe(0.8)
    expect(r.learning_eligibility).toBe(false)
    expect(r.expected_upside).toMatch(/causal incremental contribution/i)
    expect(r.possible_downside).toMatch(/bookings, CPA or platform ROAS/i)
  })

  it('a held thin rec is NOT learning-eligible and states the minimum data needed', () => {
    const r = buildRecommendation({ ...base, recommendation_type: 'pause', spend: 15, bookings: 0, window_days: 2 })
    expect(r.learning_eligibility).toBe(false)
    expect(r.minimum_data_needed).toBeTruthy()
    // Genuinely short on all three here, so all three are named.
    expect(r.minimum_data_needed).toMatch(/\$20 spend/)
    expect(r.minimum_data_needed).toMatch(/outcomes/)
    expect(r.minimum_data_needed).toMatch(/days/)
  })

  it('when every floor is met it names the REASON, not the confidence label back at you', () => {
    // `thin` is not an OR over the floors, so a unit can be thin with all three cleared. The fallback
    // read `confidence is low for another reason (${confidence_label})` — printing "(low)", a
    // sentence that promises a reason and restates the symptom. `grounding.reasons` holds the cause.
    const r = buildRecommendation({
      ...base, recommendation_type: 'pause', spend: 600, bookings: 8, window_days: 14,
      conflicting_signal: true,
    })
    expect(r.minimum_data_needed).toBeTruthy()
    expect(r.minimum_data_needed).toMatch(/diagnostic floors are all met/)
    expect(r.minimum_data_needed).not.toMatch(/another reason \(low\)/)
    expect(r.minimum_data_needed).toMatch(/Conflicting signal/i)
  })

  it('names only the floor that is SHORT, never one the numbers already cleared', () => {
    // The defect: `thin` is an OR over three unrelated conditions, and the sentence then asserted all
    // three floors were unmet, so "≥ $20 spend ... not met" could render beside "$1,342.80 spent" — the
    // floor cleared fifty times over — on the primary "what should I do" surface, as in
    // "Only 1342.8 spent over 1 days — insufficient data to judge".
    const r = buildRecommendation({
      ...base, recommendation_type: 'pause', spend: 1342.8, bookings: 0, window_days: 1,
    })
    expect(r.minimum_data_needed).toBeTruthy()
    expect(r.minimum_data_needed).not.toMatch(/\$20 spend/)   // cleared 50x — must not be blamed
    expect(r.minimum_data_needed).toMatch(/days \(only 1 so far\)/)      // the floor that IS short
    expect(r.minimum_data_needed).toMatch(/outcomes \(only 0 so far\)/)  // and this one
    // Jargon: `CampaignPlan` is a class name, not something the owner has ever seen.
    expect(r.minimum_data_needed).not.toMatch(/CampaignPlan/)
    expect(r.minimum_data_needed).toMatch(/approved campaign plan/)
  })

  it('attached external knowledge is CITED + caveated but does NOT raise confidence', () => {
    const without = buildRecommendation(base)
    const withEk = buildRecommendation({
      ...base,
      external_knowledge: [{ id: 'e1', claim: 'Broad targeting is winning in 2026', source: 'JonLoomer' }],
    })
    expect(withEk.confidence_score).toBe(without.confidence_score) // no inflation
    expect(withEk.external_knowledge_used).toEqual(['JonLoomer: Broad targeting is winning in 2026'])
    expect(withEk.what_could_make_this_wrong.some((x) => /external best practice|test ideas/i.test(x))).toBe(true)
  })

  it('a failing track record lowers the built confidence; prior_learning_used names it', () => {
    const r = buildRecommendation({ ...base, track_record: { wins: 2, decisive: 40, priorWinRate: 0.5 } })
    expect(r.confidence_score).toBeLessThan(buildRecommendation(base).confidence_score)
    expect(r.prior_learning_used).toMatch(/2\/40 decisive wins/)
  })

  it('an external-best-practice action is not learning-eligible (gate demotes it)', () => {
    const r = buildRecommendation({ ...base, recommendation_type: 'change_audience', basis: 'external_best_practice', days_since_last_change: null })
    expect(r.learning_eligibility).toBe(false)
  })
})
