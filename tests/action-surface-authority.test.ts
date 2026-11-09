import { describe, expect, it } from 'vitest'
import {
  containsUngovernedActionLanguage,
  projectFlagSurface,
  projectGeneratedReportNarrative,
  projectStoredReport,
  projectTaskSurface,
  REPORT_DIAGNOSTIC_NOTICE,
} from '@/lib/authority/diagnostic-surface'
import { ACTION_DECISION_POLICY_FLOOR } from '@/lib/authority/legacy-cutover'
import {
  applyRecommendationAuthority,
  decideRecommendationAuthority,
  recommendationDecisionCommit,
} from '@/lib/authority/recommendation-authority'
import type { Recommendation } from '@/lib/recommendations/types'
import type { DirectionalEvidence } from '@/lib/authority/directional-policy'
import { governedRecommendationAppendix, governedRecommendationTasks } from '@/lib/report/generator'
import type { StoredRecommendation } from '@/lib/recommendations/store'
import { judge } from '@/lib/learning/patterns'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const PROFIT_EVIDENCE: Pick<DirectionalEvidence, 'profitPolicy' | 'recentContribution' | 'proposedTotalContribution' | 'laggedContribution'> = {
  profitPolicy: {
    status: 'governed', version: 'maxx-owner-profit-v1', objective: 'maximize_incremental_contribution_from_ad_attributed_collected_revenue',
    dailyBudgetCeiling: 100, currentAccountDailyBudget: 50, proposedAccountDailyBudget: 60,
  },
  recentContribution: {
    status: 'complete', currency: 'USD', metricDefinitionVersion: 'maxx-causal-contribution-v1',
    realizationHorizonDays: 30, costPolicyVersion: 'cost-v1',
    causalDecisionPackageId: 'decision-package-v1', measurementDesignId: 'design-v1',
    estimand: 'marginal_contribution_vs_current_state', collectedRevenue: 1_200, refundsAndChargebacks: 0,
    paymentProcessingFees: 36, variableFulfillmentCosts: 264, observedTreatmentAdSpend: 400, adSpend: 400,
    contributionAfterAds: 500, contributionInterval: { lower: 100, upper: 900, confidence: 0.9 },
    observedSettledPayments: 6, matured: true, collectionLineage: 'processor_settled',
    measurementLineage: 'quasi_experimental_comparison', costLineage: 'governed_cost_policy',
    incrementality: 'quasi_experimental',
  },
  proposedTotalContribution: {
    status: 'complete', currency: 'USD', metricDefinitionVersion: 'maxx-causal-contribution-v1',
    realizationHorizonDays: 30, costPolicyVersion: 'cost-v1',
    causalDecisionPackageId: 'decision-package-v1', measurementDesignId: 'design-v1',
    estimand: 'total_contribution_vs_no_ads', collectedRevenue: 1_200, refundsAndChargebacks: 0,
    paymentProcessingFees: 36, variableFulfillmentCosts: 264, observedTreatmentAdSpend: 400, adSpend: 400,
    contributionAfterAds: 500, contributionInterval: { lower: 100, upper: 900, confidence: 0.9 },
    observedSettledPayments: 6, matured: true, collectionLineage: 'processor_settled',
    measurementLineage: 'quasi_experimental_comparison', costLineage: 'governed_cost_policy',
    incrementality: 'quasi_experimental',
  },
  laggedContribution: null,
}

const recommendation = (over: Partial<Recommendation> = {}): Recommendation => ({
  recommendation_type: 'refresh_creative',
  target_entity_type: 'ad',
  target_entity_id: 'ad-1',
  target_entity_name: 'Ad 1',
  observed_fact: 'Frequency is elevated and CTR has declined.',
  metric_values: [],
  date_range: { start: '2026-07-01', end: '2026-07-14' },
  data_sources: ['meta_api'],
  confidence_score: 0.5,
  confidence_label: 'medium',
  risk_level: 'medium',
  evidence_summary: 'Meta delivery signal.',
  reason_for_action: 'Upstream placeholder.',
  what_could_make_this_wrong: [],
  approval_required: true,
  action_allowed_now: false,
  low_data_warning: null,
  estimate_warning: null,
  attribution_warning: null,
  no_oscillation_check: { is_reversal_class: false, allowed: true, reason: '', blocking_factors: [] },
  recommended_next_check_date: null,
  target_evaluation: null,
  grounding: {
    passed: true, decision: 'allow', confidence_score: 0.5, confidence_label: 'medium', risk_level: 'medium',
    checks: [], reasons: [], warnings: { low_data: null, estimate: null, attribution: null },
  },
  ...over,
})

describe('owner-facing projections are structural', () => {
  it('uses policy v5 as the current ActionDecision authority floor', () => {
    expect(ACTION_DECISION_POLICY_FLOOR).toBe(5)
  })

  it('withholds money and structural commands from LLM report prose', () => {
    for (const text of ['Increase the budget by 20%.', 'Launch a new retargeting campaign.']) {
      expect(containsUngovernedActionLanguage(text)).toBe(true)
      const projected = projectGeneratedReportNarrative(text)
      expect(projected).toContain(REPORT_DIAGNOSTIC_NOTICE)
      expect(projected).toMatch(/withheld/)
      expect(projected).not.toContain(text)
    }
  })

  it('withholds budget reallocation synonyms from ungoverned LLM prose', () => {
    for (const text of [
      'Reallocate all Cold spend to Warm.',
      'Shift $45/day from Cold to Warm.',
      'Allocate more budget to the Warm retargeting ad set.',
      'Put all the money from Cold into Warm.',
      'You could shift $45/day from Cold to Warm.',
      'We might reallocate more budget to Warm.',
    ]) {
      expect(containsUngovernedActionLanguage(text), text).toBe(true)
      const projected = projectGeneratedReportNarrative(text)
      expect(projected).toMatch(/withheld/i)
      expect(projected).not.toContain(text)
    }
  })

  it('keeps factual report prose but labels it diagnostic', () => {
    const out = projectGeneratedReportNarrative('Spend was $100 and frequency was 2.1.')
    expect(out).toContain(REPORT_DIAGNOSTIC_NOTICE)
    expect(out).toContain('Spend was $100')
  })

  it('withholds a stored report unless its policy stamp reaches the floor', () => {
    const legacy = projectStoredReport({ summary_text: 'Pause it.', full_report_md: 'Increase budget.', report_json: {} })
    expect(legacy.summary_text).toBeNull()
    expect(legacy.full_report_md).toBeNull()

    const current = { summary_text: 'Diagnostic summary.', full_report_md: 'Diagnostic detail.', money_basis_version: 1, report_json: { action_authority_policy_version: ACTION_DECISION_POLICY_FLOOR } }
    expect(projectStoredReport(current)).toEqual(current)
  })

  it('withholds old money prose even when action-authority lineage is current', () => {
    const unstampedMoney = projectStoredReport({
      summary_text: 'Revenue was $4,000 and ROAS was 9x.',
      full_report_md: 'Scale the apparent winner.',
      money_basis_version: null,
      report_json: { action_authority_policy_version: ACTION_DECISION_POLICY_FLOOR },
    })
    expect(unstampedMoney.summary_text).toBeNull()
    expect(unstampedMoney.full_report_md).toBeNull()
    expect(unstampedMoney).toMatchObject({ narrative_withheld_reason: 'legacy_money_basis' })
  })

  it('legacy tasks and flags never surface their stored instructions', () => {
    const task = projectTaskSurface({ title: 'Pause ad', recommendation: 'Increase budget now.' })
    expect(task.action_authority_tier).toBe('diagnostic_only')
    expect(task.title).toBe('Review legacy diagnostic task')
    expect(task.recommendation).not.toMatch(/Increase budget/)

    const flag = projectFlagSurface({ recommended_action: 'Pause now.', watch_next: 'Increase budget tomorrow.' })
    expect(flag.action_authority_tier).toBe('diagnostic_only_legacy')
    expect(flag.recommended_action).not.toMatch(/^Pause/)
    expect(flag.watch_next).not.toMatch(/^Increase/)
    expect(flag).not.toHaveProperty('recommended_action_legacy_raw')
    expect(flag).not.toHaveProperty('watch_next_legacy_raw')
  })

  it('a task can carry owner-review copy only through a current-policy joined decision', () => {
    const task = projectTaskSurface({
      title: 'Review governed decision', recommendation: 'Legacy text.',
      action_decision: { authority_tier: 'owner_review', policy_version: ACTION_DECISION_POLICY_FLOOR, owner_copy: 'FOR OWNER REVIEW: inspect the structural proposal.' },
    })
    expect(task.action_authority_tier).toBe('owner_review')
    expect(task.recommendation).toBe('FOR OWNER REVIEW: inspect the structural proposal.')
  })

  it('v4 persisted ActionDecision artifacts are diagnostic-only after the persisted evidence cutover', () => {
    const task = projectTaskSurface({
      title: 'Prior owner-review decision',
      recommendation: 'FOR OWNER REVIEW: legacy v4 paid-cohort action.',
      action_decision: {
        authority_tier: 'owner_review',
        policy_version: 4,
        owner_copy: 'FOR OWNER REVIEW: legacy v4 paid-cohort action.',
      },
    })

    expect(task.action_authority_tier).toBe('diagnostic_only')
    expect(task.action_authority_legacy).toBe(true)
    expect(task.recommendation).toMatch(/historical/i)
    expect(task.recommendation).not.toContain('legacy v4 paid-cohort action')
  })

  it('learning producers emit diagnostic observations, never money instructions', () => {
    for (const result of [
      judge({ spend: 400, bookings: 0, clicks: 10, impressions: 1_000 }),
      judge({ spend: 100, bookings: 4, clicks: 20, impressions: 1_000 }),
      judge({ spend: 500, bookings: 2, clicks: 20, impressions: 1_000 }),
    ]) {
      expect(containsUngovernedActionLanguage(result.recommendation)).toBe(false)
      expect(result.recommendation).toMatch(/MODELLED|sample is too small/)
    }
  })

  it('the report learning brief never feeds legacy recommendation prose to the model', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/lib/learning/brief.ts'), 'utf8')
    expect(source).not.toMatch(/lines\.push\([^\n]*r\.recommendation/)
    expect(source).toMatch(/learned_patterns has no causal-contribution lineage/)
    expect(source).not.toMatch(/\.from\('learned_patterns'\)/)
  })
})

describe('recommendation authority boundary', () => {
  it('quarantines trusted interaction-cohort direction until an exact causal estimate exists', () => {
    const evidence: DirectionalEvidence = {
      ...PROFIT_EVIDENCE,
      objective: 'bookings', exactCpa: 30, provenOutcomes: 16,
      lagged: null, postPeriodCorroboratesLoss: false,
      structuralContinuity: true, windowsConflict: false,
      targetCpa: 60, maxCpa: 100, targetPolicyStatus: 'governed',
    }
    const decision = decideRecommendationAuthority({
      recommendation: recommendation({ recommendation_type: 'scale' }),
      intendedType: 'scale', basis: 'interaction_cohort_complete', plane: 'interaction_cohort',
      evidence,
      preflight: {
        verdict: 'ready_for_authority', optimizationUnit: 'adset', gates: [], blockedBy: [],
        evidence: {
          businessTruth: '', webAttributed: '', metaModeled: '', viewClickMix: '',
          creativeDiversity: '', delivery: '', sampleAdequacy: '',
          experimentConflicts: '', learningState: '',
        },
        decisionThreshold: '', counterfactualRisk: '', testBriefRequired: false,
        writeModeEnabled: false, summary: '',
      },
    })
    expect(decision.tier).toBe('diagnostic_only')
    expect(decision.directionSupported).toBe(false)
    expect(decision.directionCeiling).toBe('unsupported')
    expect(decision.reason).toMatch(/decision-grade causal-contribution estimate/i)
  })

  it('restores the contribution-authorized money intent after legacy booking/CPA grounding held it', () => {
    const held = recommendation({
      recommendation_type: 'hold',
      grounding: {
        ...recommendation().grounding,
        passed: false,
        decision: 'hold',
        reasons: ['Only one booking under a legacy diagnostic floor.'],
      },
      minimum_data_needed: 'Need more bookings under a legacy diagnostic floor.',
      low_data_warning: 'Only one booking.',
    })
    const restored = applyRecommendationAuthority(held, 'scale', {
      tier: 'execution_eligible',
      isMoneyAction: true,
      authorityBasis: 'decision_grade_causal_estimate',
      plane: 'causal_contribution',
      directionSupported: true,
      directionCeiling: 'execution',
      reason: 'Causal marginal and proposed-total contribution intervals clear zero within the owner ceiling.',
      copy: 'Scale is execution-eligible after owner approval.',
    })

    expect(restored.recommendation_type).toBe('scale')
    expect(restored.grounding).toMatchObject({ passed: true, decision: 'allow' })
    expect(restored.minimum_data_needed).toBeNull()
    expect(restored.low_data_warning).toBeNull()
    expect(restored.no_oscillation_check.allowed).toBe(true)
    expect(restored.grounding.reasons.join(' ')).toMatch(/booking\/CPA.*cannot authorize or veto/i)
  })

  it('clears all proposal residue when a money intent is diagnostic-only', () => {
    const projected = applyRecommendationAuthority(recommendation({
      recommendation_type: 'scale',
      expected_upside: 'Increasing budget could add booked value.',
      possible_downside: 'The larger budget could lose money.',
    }), 'scale', {
      tier: 'diagnostic_only',
      isMoneyAction: true,
      authorityBasis: 'calendar_period_signal',
      plane: 'meta_modelled',
      directionSupported: false,
      directionCeiling: 'unsupported',
      reason: 'Meta modelled outcomes cannot authorize a money move.',
      copy: 'OBSERVATION — no budget action is authorized.',
    })

    expect(projected.recommendation_type).toBe('investigate')
    expect(projected.expected_upside).toBeNull()
    expect(projected.possible_downside).toBeNull()
  })

  it('persists the continuity, maturity and window-conflict the decision was actually taken on', () => {
    // These three columns were literal `null` on EVERY published decision while the engine computed
    // real values for all of them. The failure was invisible from the table: `continuity: null` reads
    // as "could not be established", and a live investigation drew exactly that wrong conclusion off
    // 20 rows whose stated reason was "a material setup change falls inside the two windows being
    // compared" — which IS continuity: false, a proven fact.
    //
    // Asserting the values are PRESENT is what a null-hardcode cannot satisfy. Asserting they stay
    // absent when no evidence exists is what stops the fix becoming a fabricated default.
    // THREE DISTINCT VALUES — false, true, null. The first version of this test set both
    // `lagged.matured` and `windowsConflict` to `true`, so swapping the two sources was invisible:
    // two columns, one value, exactly the cancelling-off-by-one shape ("13 === 13") this codebase has
    // paid for before. With false/true/null no pairwise swap can pass.
    const evidence: DirectionalEvidence = {
      ...PROFIT_EVIDENCE,
      objective: 'bookings', exactCpa: 30, provenOutcomes: 16,
      lagged: null,
      postPeriodCorroboratesLoss: false,
      structuralContinuity: false, windowsConflict: true,
      targetCpa: 60, maxCpa: 100, targetPolicyStatus: 'governed',
    }
    const decision = decideRecommendationAuthority({
      recommendation: recommendation({ recommendation_type: 'scale' }),
      // meta_modelled, matching what this account actually publishes: it needs no paid-cohort
      // lineage, so the commit under test is the one production takes.
      intendedType: 'scale', basis: 'meta_modelled_association', plane: 'meta_modelled',
      evidence, preflight: null,
    })
    const args = {
      recommendation: recommendation({ recommendation_type: 'scale' }),
      intendedType: 'scale' as const,
      decision,
      paidCohortLineage: null,
    }

    const withEvidence = recommendationDecisionCommit({ ...args, sourceId: 'rec-evidence', evidence })
    expect(withEvidence.continuity).toBe(false)
    expect(withEvidence.windows_conflict).toBe(true)
    expect(withEvidence.matured).toBeNull()

    // `matured` reads through `lagged`, so prove it actually does rather than inferring it from a
    // null. Inverting continuity and windows_conflict at the same time catches a swap in the other
    // direction too.
    const inverted = recommendationDecisionCommit({
      ...args,
      sourceId: 'rec-inverted',
      evidence: {
        ...evidence,
        structuralContinuity: true,
        windowsConflict: false,
        lagged: { spend: 100, outcomes: 2, cpa: 50, matured: true },
      },
    })
    expect(inverted.continuity).toBe(true)
    expect(inverted.windows_conflict).toBe(false)
    expect(inverted.matured).toBe(true)

    // No evidence: null is the honest answer, not a placeholder.
    const withoutEvidence = recommendationDecisionCommit({
      ...args, sourceId: 'rec-no-evidence', evidence: undefined,
    })
    expect(withoutEvidence.continuity).toBeNull()
    expect(withoutEvidence.windows_conflict).toBeNull()
    expect(withoutEvidence.matured).toBeNull()
  })

  it('persists both immutable paid-cohort generation ids with an interaction-cohort decision', () => {
    const evidence: DirectionalEvidence = {
      ...PROFIT_EVIDENCE,
      objective: 'bookings', exactCpa: 30, provenOutcomes: 16,
      lagged: null, postPeriodCorroboratesLoss: false,
      structuralContinuity: true, windowsConflict: false,
      targetCpa: 60, maxCpa: 100, targetPolicyStatus: 'governed',
    }
    const decision = decideRecommendationAuthority({
      recommendation: recommendation({ recommendation_type: 'scale' }),
      intendedType: 'scale', basis: 'interaction_cohort_complete', plane: 'interaction_cohort',
      evidence,
      preflight: {
        verdict: 'ready_for_authority', optimizationUnit: 'adset', gates: [], blockedBy: [],
        evidence: {
          businessTruth: '', webAttributed: '', metaModeled: '', viewClickMix: '',
          creativeDiversity: '', delivery: '', sampleAdequacy: '',
          experimentConflicts: '', learningState: '',
        },
        decisionThreshold: '', counterfactualRisk: '', testBriefRequired: false,
        writeModeEnabled: false, summary: '',
      },
    })
    const commit = recommendationDecisionCommit({
      sourceId: 'rec-lineage',
      recommendation: recommendation({ recommendation_type: 'scale' }),
      intendedType: 'scale', decision,
      evidence: undefined,
      paidCohortLineage: {
        recentGenerationId: '00000000-0000-4000-8000-000000000681',
        maturedGenerationId: '00000000-0000-4000-8000-000000000682',
      },
    })
    expect(commit).toMatchObject({
      objective: 'maximize_incremental_contribution_from_ad_attributed_collected_revenue',
      paid_cohort_recent_generation_id: '00000000-0000-4000-8000-000000000681',
      paid_cohort_matured_generation_id: '00000000-0000-4000-8000-000000000682',
    })
  })

  it('marks Meta-modelled owner-review decisions as pragmatic media-buyer rows', () => {
    const commit = recommendationDecisionCommit({
      sourceId: 'rec-modelled-owner-review',
      recommendation: recommendation({ recommendation_type: 'scale' }),
      intendedType: 'scale',
      decision: {
        tier: 'owner_review',
        isMoneyAction: true,
        authorityBasis: 'meta_modelled_association',
        plane: 'meta_modelled',
        directionSupported: true,
        directionCeiling: 'owner_review',
        reason: 'Both modelled windows support the direction.',
        copy: 'FOR OWNER REVIEW — Meta-modelled association, not causal evidence.',
      },
      evidence: undefined,
      paidCohortLineage: null,
    })

    expect(commit.pragmatic_media_buyer).toBe(true)
    expect(commit.evidence_basis).toBe('meta_modelled_association')
    expect(commit.evidence_plane).toBe('meta_modelled')
  })

  it('refuses to label a decision interaction-cohort complete when its durable lineage is absent', () => {
    const decision = decideRecommendationAuthority({
      recommendation: recommendation({ recommendation_type: 'scale' }),
      intendedType: 'scale', basis: 'interaction_cohort_complete', plane: 'interaction_cohort',
      evidence: {
        ...PROFIT_EVIDENCE,
        objective: 'bookings', exactCpa: 30, provenOutcomes: 16,
        lagged: null, postPeriodCorroboratesLoss: false,
        structuralContinuity: true, windowsConflict: false,
        targetCpa: 60, maxCpa: 100, targetPolicyStatus: 'governed',
      },
      preflight: null,
    })
    expect(() => recommendationDecisionCommit({
      sourceId: 'rec-no-lineage',
      recommendation: recommendation({ recommendation_type: 'scale' }),
      intendedType: 'scale', decision,
      evidence: undefined,
      paidCohortLineage: null,
    })).toThrow(/paid-cohort lineage/i)
  })

  it('missing preflight caps a non-observation recommendation at diagnostic', () => {
    const decision = decideRecommendationAuthority({
      recommendation: recommendation(), intendedType: 'refresh_creative',
      basis: 'calendar_period_signal', plane: 'structural', preflight: null,
    })
    expect(decision.tier).toBe('diagnostic_only')
    expect(decision.reason).toMatch(/no server-resolved preflight/)
  })

  it('a missing entity target cannot be silently relabelled account-level', () => {
    const rec = recommendation({ target_entity_id: null })
    const decision = decideRecommendationAuthority({
      recommendation: rec, intendedType: 'refresh_creative', basis: 'calendar_period_signal',
      plane: 'structural', preflight: null,
    })
    expect(() => recommendationDecisionCommit({
      sourceId: 'rec-1', recommendation: rec, intendedType: 'refresh_creative', decision,
      evidence: undefined,
      paidCohortLineage: null,
    })).toThrow(/requires a non-empty target id/)
  })
})

describe('report actions come only from persisted recommendation decisions', () => {
  const stored = (tier: StoredRecommendation['action_authority_tier']): StoredRecommendation => ({
    id: `rec-${tier}`,
    recommendation_type: tier === 'diagnostic_only' ? 'investigate' : 'refresh_creative',
    target_entity_type: 'ad', target_entity_id: 'ad-1', target_entity_name: 'Ad 1',
    observed_fact: 'Frequency is elevated.', reason_for_action: `${tier} governed copy.`,
    action_decision: { id: `decision-${tier}`, source_kind: 'recommendation', source_id: `rec-${tier}`,
      action_kind: 'creative_refresh', target_level: 'ad', target_id: 'ad-1', evidence_plane: 'structural',
      evidence_basis: 'calendar_period_signal', authority_tier: tier, authority_reason: 'reason',
      owner_copy: `${tier} governed copy.`, direction_ceiling: tier === 'diagnostic_only' ? 'unsupported' : 'owner_review',
      direction_reason: 'reason', policy_version: ACTION_DECISION_POLICY_FLOOR, approval_state: 'not_requested',
      paid_cohort_recent_generation_id: null, paid_cohort_matured_generation_id: null,
      causal_contribution_estimate_id: null,
      metrics: {}, proposed_mutation: null },
    action_authority_tier: tier, action_authority_legacy: false, action_authority_prose_warning: false,
    date_range_start: null, date_range_end: null, data_sources: ['meta_api'], evidence_summary: 'signal',
    what_could_make_this_wrong: [], confidence_label: 'medium', confidence_score: 0.5, risk_level: 'medium',
    gate_decision: 'allow', approval_required: tier !== 'diagnostic_only', action_allowed_now: false,
    low_data_warning: null, estimate_warning: null, attribution_warning: null,
    recommended_next_check_date: null, target_metric: null, target_status: null, target_confidence: null,
    target_language: null, attribution_confidence: null, external_knowledge_used: null,
    prior_learning_used: null, expected_upside: null, possible_downside: null,
    minimum_data_needed: null, learning_eligibility: false, metric_claim_ids: [], status: 'open', generated_at: '2026-07-14T00:00:00Z',
  })

  it('renders a deterministic appendix from stored decision projections', () => {
    const out = governedRecommendationAppendix([stored('owner_review')])
    expect(out).toContain('## Governed Recommendations')
    expect(out).toContain('Authority: owner_review')
  })

  it('never materializes a task for a diagnostic decision', () => {
    expect(governedRecommendationTasks([stored('diagnostic_only')])).toEqual([])
    expect(governedRecommendationTasks([stored('owner_review')])).toEqual([
      expect.objectContaining({ action_decision_id: 'decision-owner_review' }),
    ])
  })
})
