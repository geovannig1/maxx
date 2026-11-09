import { describe, it, expect } from 'vitest'
import { decideActionAuthority, arbitrateMoneyDispositions, decisionUnitKey,
         assertsMoneyAuthority, type ActionKind, type DecisionUnit } from '@/lib/authority/action-authority'
import type { ContributionWindowEvidence, DirectionalEvidence } from '@/lib/authority/directional-policy'
import { resolveDisplayAuthority, ACTION_DECISION_POLICY_FLOOR } from '@/lib/authority/legacy-cutover'
import { arbitrateRecommendationPublications } from '@/lib/authority/recommendation-authority'
import type { ActionDecisionCommit } from '@/lib/authority/action-decision-store'

/**
 * Finding 1 was reported closed while a 2x zero-outcome "owner review
 * warranted" result still became execution_eligible for BOTH budget_cut and pause — the boolean
 * verdict collapsed the threshold tiers. Finding 4 was reported closed while live readers still used
 * a phrase matcher to decide whether stored prose was safe.
 */

const cand = (kind: ActionKind) => ({ kind, plane: 'causal_contribution' as const, observation: 'obs' })
const contribution = (over: Partial<ContributionWindowEvidence> = {}): ContributionWindowEvidence => {
  const row = {
    status: 'complete' as const,
    currency: 'USD' as const,
    metricDefinitionVersion: 'maxx-causal-contribution-v1',
    realizationHorizonDays: 30,
    costPolicyVersion: 'cost-v1',
    causalDecisionPackageId: 'decision-package-v1',
    measurementDesignId: 'design-v1',
    estimand: 'marginal_contribution_vs_current_state' as const,
    collectedRevenue: 1_200,
    refundsAndChargebacks: 0,
    paymentProcessingFees: 36,
    variableFulfillmentCosts: 264,
    observedTreatmentAdSpend: 400,
    adSpend: 400,
    observedSettledPayments: 6,
    matured: true,
    collectionLineage: 'processor_settled' as const,
    measurementLineage: 'quasi_experimental_comparison' as const,
    costLineage: 'governed_cost_policy' as const,
    incrementality: 'quasi_experimental' as const,
    ...over,
  }
  const point = over.contributionAfterAds ?? row.collectedRevenue - row.refundsAndChargebacks
    - row.paymentProcessingFees - row.variableFulfillmentCosts - row.adSpend
  return {
    ...row,
    contributionAfterAds: point,
    contributionInterval: over.contributionInterval ?? { lower: point - 100, upper: point + 100, confidence: 0.9 },
  }
}
const base: DirectionalEvidence = {
  objective: 'bookings', exactCpa: 30, provenOutcomes: 16,
  lagged: { spend: 400, outcomes: 16, cpa: 25, matured: true },
  postPeriodCorroboratesLoss: true, structuralContinuity: true, windowsConflict: false,
  targetCpa: 60, maxCpa: 100, targetPolicyStatus: 'governed',
  profitPolicy: {
    status: 'governed', version: 'maxx-owner-profit-v1', objective: 'maximize_incremental_contribution_from_ad_attributed_collected_revenue',
    dailyBudgetCeiling: 100, currentAccountDailyBudget: 50, proposedAccountDailyBudget: 60,
  },
  recentContribution: contribution(),
  proposedTotalContribution: contribution({ estimand: 'total_contribution_vs_no_ads' }),
  laggedContribution: contribution(),
}
const loss = (interval: { lower: number; upper: number } = { lower: -500, upper: -200 }): ContributionWindowEvidence =>
  contribution({
    estimand: 'total_contribution_vs_no_ads',
    collectedRevenue: 100, paymentProcessingFees: 3, variableFulfillmentCosts: 47,
    contributionAfterAds: -350,
    contributionInterval: { ...interval, confidence: 0.9 },
  })
const losing = (lagged = loss(), recent = loss()): DirectionalEvidence => ({
  ...base,
  recentContribution: recent,
  laggedContribution: lagged,
})
const decide = (kind: ActionKind, ev: DirectionalEvidence) =>
  decideActionAuthority(cand(kind), 'decision_grade_causal_estimate', ev)

describe('contribution evidence tiers survive into the authority tier', () => {
  it('a positive point estimate whose interval crosses zero is review-only', () => {
    const uncertain = contribution({ contributionInterval: { lower: -100, upper: 1_000, confidence: 0.9 } })
    const d = decide('budget_scale', { ...base, recentContribution: uncertain })
    expect(d.tier).toBe('owner_review')
    expect(d.directionCeiling).toBe('owner_review')
    expect(d.reason).toMatch(/interval crosses zero/i)
  })

  it('a mature loss can support a cut while a full pause remains owner review', () => {
    expect(decide('budget_cut', losing()).tier).toBe('execution_eligible')
    expect(decide('pause', losing()).tier).toBe('owner_review')
  })

  it('missing owner profit policy blocks both money directions', () => {
    expect(decide('budget_cut', { ...losing(), profitPolicy: null }).tier).toBe('diagnostic_only')
    expect(decide('budget_scale', { ...base, profitPolicy: null }).tier).toBe('diagnostic_only')
  })

  it('attributed-only positive contribution is diagnostic because attribution is not causality', () => {
    const d = decide('budget_scale', {
      ...base,
      recentContribution: contribution({
        incrementality: 'attributed_only', measurementLineage: 'exact_paid_touch',
        estimand: 'attributed_association',
      }),
    })
    expect(d.tier).toBe('diagnostic_only')
    expect(d.reason).toMatch(/attributed association, not incremental proof/i)
  })

  it('fails closed on malformed settled economics', () => {
    expect(decide('budget_scale', { ...base, recentContribution: contribution({ collectedRevenue: Number.NaN }) }).tier).toBe('diagnostic_only')
    expect(decide('budget_cut', { ...losing(), laggedContribution: loss({ lower: 20, upper: -20 }) }).tier).toBe('diagnostic_only')
  })

  it('positive contribution cannot support a cut even when booking CPA looks bad', () => {
    expect(decide('budget_cut', { ...base, exactCpa: 412 }).tier).toBe('diagnostic_only')
  })
})

describe('arbitration is scoped to the DECISION UNIT', () => {
  // Arbitration took a flat list and returned ONE global winner, so a
  // decision about ad set A could suppress an unrelated decision about campaign B, or a July window
  // could suppress an August one. A unit is account + target level/id + window + policy version.
  const unit = (over: Partial<DecisionUnit> = {}): DecisionUnit => ({
    adAccountId: 'acct-1', targetLevel: 'adset', targetId: 'as-1',
    windowStart: '2026-07-01', windowEnd: '2026-07-14', policyVersion: 1, ...over,
  })
  const item = (kind: ActionKind, ev = losing(), u = unit()) =>
    ({ kind, unit: u, decision: decide(kind, ev) })

  it('one money disposition per unit — execution-grade cut outranks review-only pause', () => {
    const out = arbitrateMoneyDispositions([item('budget_cut'), item('pause'), item('budget_scale')])
    expect(out).toHaveLength(1)
    expect(out[0]!.winner!.kind).toBe('budget_cut')
    expect(out[0]!.suppressed).toHaveLength(2)
    for (const sp of out[0]!.suppressed) expect(sp.reason).toMatch(/single money disposition/)
  })

  it('different TARGETS are arbitrated independently — never cross-suppressed', () => {
    const out = arbitrateMoneyDispositions([
      item('pause', losing(), unit({ targetId: 'as-1' })),
      item('budget_cut', losing(), unit({ targetId: 'as-2' })),
    ])
    expect(out).toHaveLength(2)
    for (const u of out) expect(u.winner).not.toBeNull()
    expect(out.flatMap((u) => u.suppressed)).toHaveLength(0)
  })

  it('different LEVELS, WINDOWS and POLICY VERSIONS are separate units', () => {
    const variants: Array<Partial<DecisionUnit>> = [
      { targetLevel: 'campaign', targetId: 'c-1' },
      { windowStart: '2026-08-01', windowEnd: '2026-08-14' },
      { policyVersion: 2 },
      { adAccountId: 'acct-2' },
    ]
    const items = [item('pause'), ...variants.map((v) => item('pause', losing(), unit(v)))]
    const out = arbitrateMoneyDispositions(items)
    expect(out).toHaveLength(5)
    expect(new Set(out.map((u) => decisionUnitKey(u.unit))).size).toBe(5)
    expect(out.flatMap((u) => u.suppressed)).toHaveLength(0)
  })

  it('below the stop tier the LEAST drastic sufficient action wins', () => {
    const uncertainLoss = losing(loss({ lower: -600, upper: 50 }), loss())
    const out = arbitrateMoneyDispositions([item('pause', uncertainLoss), item('budget_cut', uncertainLoss)])
    expect(out[0]!.winner!.kind).toBe('budget_cut')
  })

  it('when EVERY candidate is diagnostic there is NO actionable winner', () => {
    const weak = base
    const out = arbitrateMoneyDispositions([item('budget_cut', weak), item('pause', weak)])
    expect(out).toHaveLength(1)
    expect(out[0]!.winner).toBeNull()
    // ...and both are retained as diagnosis rather than one being promoted.
    expect(out[0]!.suppressed).toHaveLength(2)
    for (const sp of out[0]!.suppressed) expect(sp.reason).toMatch(/every candidate resolved diagnostic_only/)
  })

  it('non-money candidates are not arbitrated at all', () => {
    expect(arbitrateMoneyDispositions([
      { kind: 'creative_refresh' as ActionKind, unit: unit(), decision: decide('creative_refresh', losing()) },
    ])).toHaveLength(0)
  })
})

describe('recommendation publication applies arbitration, not just tests it in isolation', () => {
  const publication = (sourceId: string, kind: 'pause' | 'budget_cut') => {
    const decision = decide(kind, losing())
    const commit: ActionDecisionCommit = {
      action_kind: kind, target_level: 'adset', target_id: 'as-1',
      evidence_plane: 'causal_contribution', evidence_basis: 'decision_grade_causal_estimate',
      authority_tier: decision.tier, authority_reason: decision.reason, owner_copy: decision.copy,
      direction_ceiling: decision.directionCeiling, direction_reason: decision.reason,
      policy_version: ACTION_DECISION_POLICY_FLOOR, dedupe_key: `recommendation:${sourceId}`,
      source_id: sourceId, window_start: '2026-07-01', window_end: '2026-07-14',
      objective: 'maximize_incremental_contribution_from_ad_attributed_collected_revenue', matured: true, continuity: true, windows_conflict: false,
      metrics: {}, proposed_mutation: null,
      paid_cohort_recent_generation_id: null,
      paid_cohort_matured_generation_id: null,
      pragmatic_media_buyer: false,
    }
    return {
      row: { id: sourceId, recommendation_type: kind === 'pause' ? 'pause' : 'reduce_budget', reason_for_action: decision.copy, approval_required: true, action_allowed_now: false, what_could_make_this_wrong: [] },
      decision,
      commit,
    }
  }

  it('keeps one actionable row and durably downgrades the suppressed row', () => {
    const out = arbitrateRecommendationPublications('acct-1', [publication('cut-1', 'budget_cut'), publication('pause-1', 'pause')])
    const pause = out.find((x) => x.commit.source_id === 'pause-1')!
    const cut = out.find((x) => x.commit.source_id === 'cut-1')!
    expect(cut.commit.authority_tier).toBe('execution_eligible')
    expect(pause.commit.authority_tier).toBe('diagnostic_only')
    expect(pause.row).toMatchObject({ recommendation_type: 'investigate', approval_required: false, action_allowed_now: false })
    expect(String(pause.row.reason_for_action)).toMatch(/suppressed by final arbitration/i)
  })
})

describe('legacy rows resolve by STRUCTURE, never by wording', () => {
  const PHRASES = [
    'Do not pause; increase budget immediately.',
    'This is not ready. Pause this ad immediately.',
    'No change yet. Reduce budget by 30 percent tomorrow.',
    'Increase budget by 20% and monitor CPA for 3 days before increasing again.',
  ]

  it('none of the four legacy phrases can surface as actionable copy', () => {
    for (const raw of PHRASES) {
      const r = resolveDisplayAuthority(null, raw)
      expect(r.tier, raw).toBe('diagnostic_only')
      expect(r.legacy).toBe(true)
      expect(r.copy).not.toContain(raw)                    // the instruction never reaches display
      expect(assertsMoneyAuthority(r.copy), r.copy).toBe(false)
      expect(r.legacyRawForAudit).toBe(raw)                // preserved verbatim for audit
    }
  })

  it('MISSING structured lineage is diagnostic WITHOUT consulting the English', () => {
    // Innocuous wording, no decision: still diagnostic. Structure alone decided.
    const r = resolveDisplayAuthority(null, 'Everything looks completely fine here.')
    expect(r.tier).toBe('diagnostic_only')
    expect(r.legacy).toBe(true)
    expect(r.prosePhraseWarning).toBe(false)
  })

  it('a decision BELOW the policy floor is legacy; at/above it is honoured', () => {
    const below = resolveDisplayAuthority(
      { authority_tier: 'execution_eligible', policy_version: ACTION_DECISION_POLICY_FLOOR - 1 }, 'x')
    expect(below.tier).toBe('diagnostic_only')
    expect(below.legacy).toBe(true)

    const current = resolveDisplayAuthority(
      { authority_tier: 'owner_review', policy_version: ACTION_DECISION_POLICY_FLOOR, authority_reason: 'r' }, 'x')
    expect(current.tier).toBe('owner_review')
    expect(current.legacy).toBe(false)
  })

  it('the phrase check is defence-in-depth only — it never changes the tier', () => {
    const loud = resolveDisplayAuthority(null, 'Pause this ad immediately.')
    const quiet = resolveDisplayAuthority(null, 'Nothing to report.')
    expect(loud.prosePhraseWarning).toBe(true)
    expect(quiet.prosePhraseWarning).toBe(false)
    expect(loud.tier).toBe(quiet.tier)                      // the warning changed nothing
  })
})
