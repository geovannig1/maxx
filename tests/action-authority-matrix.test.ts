import { describe, it, expect, vi } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { decideActionAuthority, assertsMoneyAuthority, isMoneyKind,
         type ActionCandidate, type ActionKind } from '@/lib/authority/action-authority'
import type { ContributionWindowEvidence, DirectionalEvidence } from '@/lib/authority/directional-policy'
import {
  arbitrateRecommendationPublications,
  decideRecommendationAuthority,
  recommendationDecisionCommit,
  type RecommendationAuthorityPublication,
} from '@/lib/authority/recommendation-authority'
import type { DecisionResult } from '@/lib/recommendations/decision-policy'
import type { Recommendation } from '@/lib/recommendations/types'
import { evaluateFlag, renderFlagAction } from '@/lib/flags/rules'
import {
  detectOperatingMode,
  type InteractionCohortPairSignal,
  type ModeSignals,
} from '@/lib/modes/operating-mode'

// The brief is DB-backed; feed it rows so this suite tests the RENDERING that reaches the report LLM.
const briefRows = [
  { dimension: 'audience', segment: 'Lookalike 1%', verdict: 'strong', cpa: 38, sample_bookings: 9,
    sample_spend: 342, confidence: 'high', recommendation: 'diagnostic signal', pattern_key: 'a' },
  { dimension: 'audience', segment: 'Broad', verdict: 'weak', cpa: 410, sample_bookings: 1,
    sample_spend: 410, confidence: 'medium', recommendation: 'diagnostic signal', pattern_key: 'b' },
]
vi.mock('@/lib/supabase/admin', () => {
  const chain: Record<string, unknown> = {}
  const self = () => chain
  chain.select = self; chain.eq = self; chain.gte = self; chain.lte = self
  chain.order = self; chain.limit = self
  chain.then = (res: (v: { data: unknown[]; error: null }) => unknown) => res({ data: briefRows, error: null })
  return { getAdminClient: () => ({ from: () => chain }) }
})
vi.mock('@/lib/accounts/active-account', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/accounts/active-account')>()),
  resolveOnlyActiveAccount: vi.fn(async () => ({
    ok: true,
    account: { id: 'acct-1', accountId: 'act_1', accountName: 'Example Studio' },
  })),
}))

/**
 * The entry-point matrix.
 *
 * The central defect was never one bad rule: Maxx had several independent brains that could each
 * produce money advice, so it could say "no money action is authorized" in one surface while another
 * said "Pause this" and a third said "scale these". Unit tests all passed, because each brain was
 * consistent with itself.
 *
 * This suite asserts the SYSTEM property those tests could not see: under calendar-only evidence, no
 * real output surface may emit an authorized money action or imperative action copy. One pure
 * causal-estimate fixture proves the central authority can still become reachable, so this is a
 * basis requirement and not a hardcoded refusal.
 */

const MONEY_KINDS: ActionKind[] = ['budget_scale', 'budget_cut', 'pause', 'activate']
const NON_MONEY: ActionKind[] = ['creative_refresh', 'structural', 'observe']

const candidate = (kind: ActionKind, plane: ActionCandidate['plane'] = 'meta_modelled'): ActionCandidate => ({
  kind, plane, observation: 'Modelled CPA is $412 against a $100 maximum over 14 days.',
  investigate: 'whether the exact join agrees',
})

describe('the authority layer itself', () => {
  it('NO money kind reaches execution_eligible on any sub-cohort plane', () => {
    for (const kind of MONEY_KINDS) {
      for (const plane of ['exact_paid_join', 'ledger_business', 'meta_modelled', 'ga_telemetry', 'structural'] as const) {
        for (const basis of ['calendar_period_signal', 'unavailable', 'interaction_cohort_complete'] as const) {
          const d = decideActionAuthority(candidate(kind, plane), basis)
          expect(d.tier, `${kind} on ${plane} under ${basis}`).toBe('diagnostic_only')
          expect(assertsMoneyAuthority(d.copy), `${kind}/${plane}/${basis} copy asserts authority`).toBe(false)
        }
      }
    }
  })

  const contribution = (over: Partial<ContributionWindowEvidence> = {}): ContributionWindowEvidence => {
    const row = {
      status: 'complete' as const, currency: 'USD' as const,
      metricDefinitionVersion: 'maxx-causal-contribution-v1', realizationHorizonDays: 30,
      costPolicyVersion: 'cost-v1', causalDecisionPackageId: 'decision-package-v1',
      measurementDesignId: 'design-v1',
      estimand: 'marginal_contribution_vs_current_state' as const,
      collectedRevenue: 1_200, refundsAndChargebacks: 0,
      paymentProcessingFees: 36, variableFulfillmentCosts: 264, observedTreatmentAdSpend: 400, adSpend: 400,
      observedSettledPayments: 6, matured: true, collectionLineage: 'processor_settled' as const,
      measurementLineage: 'quasi_experimental_comparison' as const, costLineage: 'governed_cost_policy' as const,
      incrementality: 'quasi_experimental' as const, ...over,
    }
    const point = over.contributionAfterAds ?? row.collectedRevenue - row.refundsAndChargebacks
      - row.paymentProcessingFees - row.variableFulfillmentCosts - row.adSpend
    return { ...row, contributionAfterAds: point,
      contributionInterval: over.contributionInterval ?? { lower: point - 100, upper: point + 100, confidence: 0.9 } }
  }
  const loss = (spend = 400): ContributionWindowEvidence => contribution({
    estimand: 'total_contribution_vs_no_ads',
    collectedRevenue: 100, paymentProcessingFees: 3, variableFulfillmentCosts: 47, adSpend: spend,
    contributionAfterAds: 50 - spend,
    contributionInterval: { lower: -spend - 100, upper: -spend + 100, confidence: 0.9 },
  })
  const profitPolicy: NonNullable<DirectionalEvidence['profitPolicy']> = {
    status: 'governed', version: 'maxx-owner-profit-v1', objective: 'maximize_incremental_contribution_from_ad_attributed_collected_revenue',
    dailyBudgetCeiling: 100, currentAccountDailyBudget: 50, proposedAccountDailyBudget: 60,
  }
  const PROFITABLE: DirectionalEvidence = {
    objective: 'bookings', exactCpa: 30, provenOutcomes: 16,
    lagged: { spend: 400, outcomes: 9, cpa: 44, matured: true },
    postPeriodCorroboratesLoss: false, structuralContinuity: true, windowsConflict: false,
    targetCpa: 60, maxCpa: 100, targetPolicyStatus: 'governed',
    profitPolicy, recentContribution: contribution(),
    proposedTotalContribution: contribution({ estimand: 'total_contribution_vs_no_ads' }),
    laggedContribution: contribution(),
  }
  const LOSING: DirectionalEvidence = {
    objective: 'bookings', exactCpa: 412, provenOutcomes: 6,
    lagged: { spend: 400, outcomes: 0, cpa: null, matured: true },
    postPeriodCorroboratesLoss: true, structuralContinuity: true, windowsConflict: false,
    targetCpa: 60, maxCpa: 100, targetPolicyStatus: 'governed',
    profitPolicy, recentContribution: loss(), proposedTotalContribution: null, laggedContribution: loss(),
  }

  it('a LOSING unit cannot be scaled, however complete the cohort', () => {
    const d = decideActionAuthority(candidate('budget_scale', 'interaction_cohort'),
      'interaction_cohort_complete', LOSING)
    expect(d.tier).toBe('diagnostic_only')
    expect(d.directionSupported).toBe(false)
    expect(d.reason).toMatch(/positive total contribution.*does not prove|marginal causal-contribution/i)
    expect(assertsMoneyAuthority(d.copy)).toBe(false)
  })

  /**
   * MONEY-QUARANTINE PERMITTED MATRIX — the reachability property.
   *
   * The baseline schema admits two NON-causal owner-review money bases and shipped the database CHECK
   * (`action_decisions_v4_money_quarantine`) plus the direction rules. Its history records the reason:
   * the earlier pragmatic escape hatch was bound to `interaction_cohort_complete`, "no cohort has ever been
   * complete on any policy version", so "every money recommendation drained to diagnostic_only by
   * construction, and three months of work produced zero money recommendations."
   *
   * The authority gate was never updated, so both permitted branches were unsatisfiable by any row and
   * the owner-facing toggle had no effect even when switched on. These cases FAILED
   * before that fix; keeping them here is what stops the path silently closing again.
   *
   * Each row must stay byte-identical to a branch of the `action_decisions_v4_money_quarantine` CHECK.
   */
  // An attributed-association window is a distinct evidence CLASS, not a relabelled causal one:
  // validateContributionEvidence pairs incrementality with both its measurement lineage and its
  // estimand (directional-policy.ts:347-356), so all three must move together.
  const attributedLoss = (spend = 400): ContributionWindowEvidence => ({
    ...loss(spend),
    incrementality: 'attributed_only' as const,
    measurementLineage: 'exact_paid_touch' as const,
    estimand: 'attributed_association' as const,
  })
  const ATTRIBUTED_LOSING: DirectionalEvidence = {
    ...LOSING, recentContribution: attributedLoss(), laggedContribution: attributedLoss(),
  }

  it('money quarantine: attributed association reaches owner_review for a cut when pragmatic mode is ON', () => {
    for (const [plane, basis] of [
      ['interaction_cohort', 'interaction_cohort_complete'],
      ['meta_modelled', 'meta_modelled_association'],
    ] as const) {
      const d = decideActionAuthority(candidate('budget_cut', plane), basis, ATTRIBUTED_LOSING,
        { pragmaticMediaBuyerEnabled: true })
      expect(d.tier, `${plane}/${basis}`).toBe('owner_review')
      expect(d.directionSupported, `${plane}/${basis}`).toBe(true)
      expect(d.directionCeiling, `${plane}/${basis}`).toBe('owner_review')
      // The DB CHECK requires these four together; a decision that cannot persist is not a decision.
      expect(d.isMoneyAction).toBe(true)
      // Honestly labeled, and still not an instruction. Each path names its own evidence limit:
      // the cohort path "association evidence, not causal incrementality"; the modelled path
      // "Meta's MODELLED estimate, not measured settled revenue".
      expect(d.copy).toMatch(/not causal incrementality|MODELLED estimate, not measured settled revenue/)
      expect(d.copy).toMatch(/FOR OWNER REVIEW — not execution-eligible/)
      expect(assertsMoneyAuthority(d.copy), `${plane}/${basis} copy asserts authority`).toBe(false)
    }
  })

  /**
   * THE DOWNGRADE INVARIANT — the seam this suite never covered.
   *
   * The constraints are well tested in isolation. The generator is well tested in isolation. They
   * were never tested against each other, and the defect lived exactly there: `constrainByPreflight`
   * lowered a money decision's TIER to `diagnostic_only` by spreading the decision and overriding
   * `tier` alone, leaving `directionCeiling` at `'owner_review'`. `recommendationDecisionCommit`
   * writes that ceiling verbatim, and every branch of `action_decisions_v4_money_quarantine` then
   * refuses the row. The publisher is atomic, so ONE such row discards every recommendation for the
   * run -- and `orchestrator.ts` swallows it into `partialErrors`, so the account simply loses its
   * recommendations and its daily report in silence.
   *
   * It could only fire once a money action actually reached `owner_review`, which is precisely what
   * restoring the money-authority path does. Preflight has twelve gates; FOUR of its six reachable
   * outcomes produce the illegal row, including `preflight === null` (`generate.ts` passes
   * `gated?.decision ?? null`).
   *
   * The oracle below is transcribed from the constraint as it stands in PRODUCTION, read back with
   * `pg_get_constraintdef` rather than from the migration file -- so this test agrees with the
   * database that will actually reject the INSERT, not with a file that is merely supposed to match.
   */
  const MONEY_QUARANTINE_KINDS = new Set(['budget_scale', 'budget_cut', 'pause', 'activate'])

  /** Returns the CHECK branch that admits the row, or null when the INSERT would be rejected. */
  function admittingBranch(row: {
    action_kind: string
    authority_tier: string
    direction_ceiling: string
    pragmatic_media_buyer: boolean
    evidence_plane: string
    evidence_basis: string
    causal_contribution_estimate_id?: string | null
  }): string | null {
    const noEstimate = (row.causal_contribution_estimate_id ?? null) === null
    if (!MONEY_QUARANTINE_KINDS.has(row.action_kind)) return noEstimate ? 'non_money' : null
    if (noEstimate && row.authority_tier === 'diagnostic_only'
      && row.direction_ceiling === 'unsupported'
      && row.pragmatic_media_buyer !== true) return 'diagnostic_only'
    if (noEstimate && row.pragmatic_media_buyer === true
      && row.authority_tier === 'owner_review' && row.direction_ceiling === 'owner_review'
      && row.evidence_plane === 'interaction_cohort'
      && row.evidence_basis === 'interaction_cohort_complete') return 'owner_review_cohort'
    if (noEstimate && row.pragmatic_media_buyer === true
      && row.authority_tier === 'owner_review' && row.direction_ceiling === 'owner_review'
      && row.evidence_plane === 'meta_modelled'
      && row.evidence_basis === 'meta_modelled_association') return 'owner_review_modelled'
    if (!noEstimate && row.evidence_plane === 'causal_contribution'
      && row.evidence_basis === 'decision_grade_causal_estimate') return 'causal'
    return null
  }

  // Only `observed_fact`, the target fields and `date_range` are read on this path; the rest of the
  // Recommendation shape is irrelevant to the invariant under test. The ORACLE is the real constraint
  // and the SUBJECT is real production code -- only the input is narrowed.
  const moneyRec = (id: string): Recommendation => ({
    recommendation_type: 'reduce_budget',
    target_entity_type: 'adset', target_entity_id: id, target_entity_name: `Ad set ${id}`,
    observed_fact: 'Modelled CPA is $412 against a $100 maximum over 14 days.',
    metric_values: [], date_range: { start: '2026-08-11', end: '2026-08-24' },
  } as unknown as Recommendation)

  const preflightVerdict = (verdict: DecisionResult['verdict']): DecisionResult => ({
    verdict, optimizationUnit: 'adset', gates: [], blockedBy: ['sample_adequacy'],
    evidence: {
      businessTruth: '', webAttributed: '', metaModeled: '', delivery: '', viewClickMix: '',
      sampleAdequacy: '', creativeDiversity: '', experimentConflicts: '', learningState: '',
    },
    decisionThreshold: 'n/a', counterfactualRisk: 'n/a', testBriefRequired: false,
    writeModeEnabled: false, summary: 'blocked for the test',
  })

  const modelledMoneyDecision = (preflight: DecisionResult | null) => decideRecommendationAuthority({
    recommendation: moneyRec('adset-1'), intendedType: 'reduce_budget',
    basis: 'meta_modelled_association', plane: 'meta_modelled',
    evidence: ATTRIBUTED_LOSING, preflight, pragmaticMediaBuyerEnabled: true,
  })

  const commitFor = (decision: ReturnType<typeof modelledMoneyDecision>, sourceId = 'rec-1') =>
    recommendationDecisionCommit({
      recommendation: moneyRec('adset-1'), intendedType: 'reduce_budget', decision,
      sourceId, evidence: ATTRIBUTED_LOSING, paidCohortLineage: null,
    })

  it('ANTI-VACUITY: with preflight cleared, this exact setup really does reach owner_review', () => {
    // Without this, the two cases below could pass on a decision that never reached `owner_review`
    // at all -- which is how the defect survived a green suite in the first place.
    const decision = modelledMoneyDecision(preflightVerdict('ready_for_authority'))
    expect(decision.tier).toBe('owner_review')
    expect(decision.directionCeiling).toBe('owner_review')
    expect(admittingBranch(commitFor(decision))).toBe('owner_review_modelled')
  })

  it('a downgraded money decision lowers the CEILING with the TIER, and the row stays insertable', () => {
    // `preflight === null` is a real production path, not a contrivance: generate.ts passes
    // `gated?.decision ?? null`. 'monitor', 'freeze' and 'test' are the other three illegal-row
    // outcomes; all four must land on the diagnostic branch.
    for (const preflight of [
      null,
      preflightVerdict('monitor'),
      preflightVerdict('freeze'),
      preflightVerdict('test'),
    ]) {
      const label = preflight?.verdict ?? 'null'
      const decision = modelledMoneyDecision(preflight)
      expect(decision.tier, label).toBe('diagnostic_only')
      expect(decision.directionCeiling, label).toBe('unsupported')

      const commit = commitFor(decision)
      expect(commit.authority_tier, label).toBe('diagnostic_only')
      expect(commit.direction_ceiling, label).toBe('unsupported')
      expect(commit.pragmatic_media_buyer, label).toBe(false)
      // The whole point: the row the publisher would INSERT is one the database admits.
      expect(admittingBranch(commit), `${label} produced a row no CHECK branch admits`)
        .toBe('diagnostic_only')
    }
  })

  it('arbitration suppression clears the ceiling AND pragmatic_media_buyer, not just the tier', () => {
    // Arbitration runs AFTER the commit row is built, so `pragmatic_media_buyer` was already derived
    // as true from the pre-downgrade owner_review tier. Both must come down or the loser's row is
    // rejected -- and because the publisher is atomic, it takes the WINNER down with it.
    const cleared = preflightVerdict('ready_for_authority')
    const publication = (sourceId: string): RecommendationAuthorityPublication => {
      const decision = modelledMoneyDecision(cleared)
      return { decision, commit: commitFor(decision, sourceId), row: {} }
    }
    // Two money dispositions on the SAME unit — one must lose.
    const arbitrated = arbitrateRecommendationPublications('acct-1',
      [publication('rec-a'), publication('rec-b')])

    const losers = arbitrated.filter((p) => p.commit.authority_tier === 'diagnostic_only')
    expect(losers.length, 'arbitration suppressed nothing — the case is vacuous').toBeGreaterThan(0)
    for (const loser of losers) {
      expect(loser.decision.directionCeiling).toBe('unsupported')
      expect(loser.commit.direction_ceiling).toBe('unsupported')
      expect(loser.commit.pragmatic_media_buyer).toBe(false)
      expect(admittingBranch(loser.commit)).toBe('diagnostic_only')
    }
    for (const p of arbitrated) {
      expect(admittingBranch(p.commit), `${p.commit.source_id} produced an unwritable row`).not.toBeNull()
    }
  })

  it('the pragmatic path stays shut without the toggle, off-whitelist, or against the direction', () => {
    // Toggle off — the production default, and the state every existing matrix case asserts.
    expect(decideActionAuthority(candidate('budget_cut', 'meta_modelled'), 'meta_modelled_association',
      ATTRIBUTED_LOSING).tier).toBe('diagnostic_only')
    // Toggle on but the pair is NOT one the money-quarantine CHECK whitelists (mismatched plane/basis).
    expect(decideActionAuthority(candidate('budget_cut', 'meta_modelled'), 'interaction_cohort_complete',
      ATTRIBUTED_LOSING, { pragmaticMediaBuyerEnabled: true }).tier).toBe('diagnostic_only')
    // Toggle on, pair whitelisted, but the evidence contradicts the action: a profitable unit is not cut.
    expect(decideActionAuthority(candidate('budget_cut', 'meta_modelled'), 'meta_modelled_association',
      PROFITABLE, { pragmaticMediaBuyerEnabled: true }).tier).toBe('diagnostic_only')
  })

  it('EXECUTION ELIGIBILITY IS UNCHANGED: no pragmatic path ever reaches execution_eligible', () => {
    for (const kind of MONEY_KINDS) {
      for (const [plane, basis] of [
        ['interaction_cohort', 'interaction_cohort_complete'],
        ['meta_modelled', 'meta_modelled_association'],
      ] as const) {
        for (const ev of [PROFITABLE, LOSING, ATTRIBUTED_LOSING]) {
          const d = decideActionAuthority(candidate(kind, plane), basis, ev,
            { pragmaticMediaBuyerEnabled: true })
          expect(d.tier, `${kind}/${plane}/${basis}`).not.toBe('execution_eligible')
        }
      }
    }
  })

  it('a PROFITABLE unit cannot be cut or paused, however complete the cohort', () => {
    for (const kind of ['budget_cut', 'pause'] as ActionKind[]) {
      const d = decideActionAuthority(candidate(kind, 'interaction_cohort'),
        'interaction_cohort_complete', PROFITABLE)
      expect(d.tier, kind).toBe('diagnostic_only')
      expect(d.directionSupported).toBe(false)
    }
  })

  it('SCALE and CUT can never both be authorized for one evidence state', () => {
    for (const ev of [PROFITABLE, LOSING]) {
      const scale = decideActionAuthority(candidate('budget_scale', 'interaction_cohort'), 'interaction_cohort_complete', ev)
      const cut = decideActionAuthority(candidate('budget_cut', 'interaction_cohort'), 'interaction_cohort_complete', ev)
      expect(scale.tier === 'execution_eligible' && cut.tier === 'execution_eligible').toBe(false)
    }
    // Structural, not a special case: scale needs a positive lower bound; a cut needs a negative upper bound.
    expect(PROFITABLE.recentContribution!.contributionInterval.lower).toBeGreaterThan(0)
    expect(LOSING.laggedContribution!.contributionInterval.upper).toBeLessThan(0)
  })

  it('each direction IS reachable only on a decision-grade causal-estimate plane', () => {
    const scale = decideActionAuthority(candidate('budget_scale', 'causal_contribution'), 'decision_grade_causal_estimate', PROFITABLE)
    expect(scale.tier).toBe('execution_eligible')
    expect(scale.copy).toMatch(/owner approval and write mode/)

    const cut = decideActionAuthority(candidate('budget_cut', 'causal_contribution'), 'decision_grade_causal_estimate', LOSING)
    expect(cut.tier).toBe('execution_eligible')
  })

  it('delivery-objective labels cannot override the commercial profit direction', () => {
    for (const objective of ['unknown', 'leads', 'awareness'] as const) {
      expect(decideActionAuthority(candidate('budget_scale', 'causal_contribution'),
        'decision_grade_causal_estimate', { ...PROFITABLE, objective }).tier).toBe('execution_eligible')
      expect(decideActionAuthority(candidate('budget_cut', 'causal_contribution'),
        'decision_grade_causal_estimate', { ...LOSING, objective }).tier).toBe('execution_eligible')
    }
  })

  it('an Awareness delivery objective is still judged on contribution, never booking CPA', () => {
    const d = decideActionAuthority(candidate('budget_cut', 'causal_contribution'),
      'decision_grade_causal_estimate', { ...LOSING, objective: 'awareness' })
    expect(d.tier).toBe('execution_eligible')
    expect(d.reason).toMatch(/contribution interval remains below zero/i)
    expect(d.reason).not.toMatch(/booking CPA/i)
  })

  it('WITHOUT trusted evidence, every money kind fails closed', () => {
    for (const kind of MONEY_KINDS) {
      const d = decideActionAuthority(candidate(kind, 'interaction_cohort'), 'interaction_cohort_complete')
      expect(d.tier, kind).toBe('diagnostic_only')
      expect(d.reason).toMatch(/UNPROVEN|does not support/)
    }
  })

  it('CONFLICTING windows authorize neither direction', () => {
    for (const kind of MONEY_KINDS) {
      const d = decideActionAuthority(candidate(kind, 'interaction_cohort'),
        'interaction_cohort_complete', { ...LOSING, windowsConflict: true })
      expect(d.tier, kind).toBe('diagnostic_only')
    }
  })

  it('an UNMATURED lagged window blocks a cut; discontinuity blocks it too', () => {
    const immature = decideActionAuthority(candidate('budget_cut', 'interaction_cohort'),
      'interaction_cohort_complete', { ...LOSING, laggedContribution: { ...LOSING.laggedContribution!, matured: false } })
    expect(immature.tier).toBe('diagnostic_only')
    expect(immature.reason).toMatch(/has not matured/i)

    for (const continuity of [false, null] as const) {
      const d = decideActionAuthority(candidate('budget_cut', 'interaction_cohort'),
        'interaction_cohort_complete', { ...LOSING, structuralContinuity: continuity })
      expect(d.tier, `continuity=${continuity}`).toBe('diagnostic_only')
    }
  })

  it('SPEND ALONE is not evidence of loss', () => {
    const d = decideActionAuthority(candidate('budget_cut', 'interaction_cohort'),
      'interaction_cohort_complete',
      { ...LOSING, laggedContribution: null })
    expect(d.tier).toBe('diagnostic_only')
    expect(d.reason).toMatch(/contribution evidence is incomplete/i)
  })

  it('interaction-cohort evidence remains diagnostic even when its cohort basis is complete', () => {
    for (const kind of MONEY_KINDS) {
      const d = decideActionAuthority(candidate(kind, 'interaction_cohort'), 'interaction_cohort_complete', PROFITABLE)
      expect(d.tier).toBe('diagnostic_only')
      expect(d.directionCeiling).toBe('unsupported')
    }
  })

  it('non-money kinds may reach owner_review, with the plane named', () => {
    for (const kind of NON_MONEY.filter((k) => k !== 'observe')) {
      const d = decideActionAuthority(candidate(kind), 'calendar_period_signal')
      expect(d.tier).toBe('owner_review')
      expect(d.isMoneyAction).toBe(false)
      expect(d.copy).toMatch(/Basis: /)
      expect(d.copy).toMatch(/No spend change is implied/)
    }
  })

  it('every downgrade states its reason — no silent withholding', () => {
    // Supply evidence that SUPPORTS each direction, so the calendar basis is the only thing blocking:
    // otherwise the directional refusal fires first and this would test the wrong gate.
    const supporting: Record<string, DirectionalEvidence> = {
      budget_scale: PROFITABLE, activate: PROFITABLE, budget_cut: LOSING, pause: LOSING,
    }
    for (const kind of MONEY_KINDS) {
      const d = decideActionAuthority(candidate(kind), 'calendar_period_signal', supporting[kind])
      expect(d.reason, kind).toMatch(/require an exact decision-grade causal-contribution estimate/)
      expect(d.copy).toMatch(/NOT a causal incremental-contribution result/)
    }
  })

  it('the OBSERVATION survives the downgrade — evidence is never suppressed', () => {
    const d = decideActionAuthority(candidate('budget_cut'), 'calendar_period_signal')
    expect(d.copy).toMatch(/\$412/)
    expect(d.copy).toMatch(/\$100 maximum/)
  })
})

describe('ENTRY POINT: raw flag rules and the flags surface', () => {
  // The exact shapes that previously produced "Pause.", "Increase budget by 20%",
  // "Reduce budget or pause" and "cut losses" straight from Meta-modelled conversions.
  const inputs = [
    { name: 'zero-booking loser', spend: 400, cpa: null, cpl: null, ctr: 0.4, frequency: 1.2, impressions: 900,
      bookings: 0, leads: 0, window_days: 7, entity_age_days: 30 },
    { name: 'unprofitable', spend: 800, cpa: 412, cpl: null, ctr: 1.2, frequency: 1.4, impressions: 4000,
      bookings: 2, leads: 0, window_days: 7, entity_age_days: 30 },
    { name: 'winner/scale', spend: 300, cpa: 42, cpl: null, ctr: 2.4, frequency: 1.3, impressions: 6000,
      bookings: 7, leads: 0, window_days: 7, entity_age_days: 30 },
    { name: 'fatigued', spend: 300, cpa: 55, cpl: null, ctr: 0.8, frequency: 6.5, impressions: 9000,
      bookings: 3, leads: 0, window_days: 7, entity_age_days: 30, peak_ctr: 2.4 },
  ]

  it('no flag rule emits imperative money copy under calendar-only evidence', () => {
    for (const input of inputs) {
      const rule = evaluateFlag(input as never)
      if (!rule) continue
      const decision = renderFlagAction(rule, 'calendar_period_signal')
      expect(assertsMoneyAuthority(decision.copy), `${input.name}: "${decision.copy}"`).toBe(false)
      if (isMoneyKind(rule.candidate.kind)) {
        expect(decision.tier, `${input.name} is a money candidate`).toBe('diagnostic_only')
      }
    }
  })

  it('flag rules carry a structured candidate and NO free-text action field', () => {
    for (const input of inputs) {
      const rule = evaluateFlag(input as never)
      if (!rule) continue
      expect(rule.candidate).toBeDefined()
      expect(rule.candidate.plane).toBeDefined()
      // The observation itself must not smuggle an instruction in.
      expect(assertsMoneyAuthority(rule.candidate.observation),
        `candidate observation is imperative: "${rule.candidate.observation}"`).toBe(false)
      expect((rule as unknown as Record<string, unknown>).recommended_action).toBeUndefined()
    }
  })
})

describe('ENTRY POINT: operating mode', () => {
  const paidLoss = (spend: number): ContributionWindowEvidence => ({
    status: 'complete', currency: 'USD', metricDefinitionVersion: 'maxx-causal-contribution-v1',
    realizationHorizonDays: 30, costPolicyVersion: 'cost-v1',
    causalDecisionPackageId: 'decision-package-v1', measurementDesignId: 'design-v1',
    estimand: 'total_contribution_vs_no_ads', collectedRevenue: 100, refundsAndChargebacks: 0,
    paymentProcessingFees: 3, variableFulfillmentCosts: 47, observedTreatmentAdSpend: spend, adSpend: spend,
    contributionAfterAds: 50 - spend,
    contributionInterval: { lower: -spend - 100, upper: -spend + 100, confidence: 0.9 },
    observedSettledPayments: 1, matured: true, collectionLineage: 'processor_settled',
    measurementLineage: 'quasi_experimental_comparison', costLineage: 'governed_cost_policy',
    incrementality: 'quasi_experimental',
  })
  const losingPair: InteractionCohortPairSignal = {
    evaluationRunId: '00000000-0000-4000-8000-000000000200',
    recentScale: {
      generationId: '00000000-0000-4000-8000-000000000201',
      windowStart: '2026-06-15', windowEnd: '2026-06-28', asOfDate: '2026-06-29',
      complete: true, allUnitsComplete: true, blockerCodes: [],
      spend: 900, bookings: 0, bookedValue: 0,
    },
    maturedCut: {
      generationId: '00000000-0000-4000-8000-000000000202',
      windowStart: '2026-06-01', windowEnd: '2026-06-14', asOfDate: '2026-06-29',
      complete: true, allUnitsComplete: true, blockerCodes: [],
      spend: 1_800, bookings: 0, bookedValue: 0,
    },
  }
  const base: ModeSignals = {
    spend30d: 800, businessBookings30d: 8, exactPaidBookings30d: 8, metaModelledBookings30d: 8,
    attributedShare: 0.7, campaignMappingComplete: true, authoritativeSpendBasis: true,
    campaignSpendComplete: true, structuralContinuity: true, objective: 'bookings',
    interactionCohorts: null,
    laggedPeriod: { spend: 1800, exactPaidBookings: 0, daysSinceEnd: 14, start: '2026-05-15', end: '2026-06-14' },
    postPeriod: { spend: 900, exactPaidBookings: 0, daysSinceEnd: 14, start: '2026-06-15', end: '2026-06-28' },
    targetCpa: 60, maxCpa: 100, daysSinceLastDelivery: 0, activeAdsDelivering: 4,
    targetPolicyStatus: 'governed',
    anyAdsetExitedLearning: true, writeModeEnabled: false,
    mediaBuyerRecommendationsEnabled: false,
  } as ModeSignals

  it('emits no authorized money action and no imperative copy under calendar evidence', () => {
    const r = detectOperatingMode(base)
    expect(r.canRecommendBudgetScale).toBe(false)
    expect(r.canRecommendBudgetCut).toBe(false)
    for (const line of r.restrictions) {
      expect(assertsMoneyAuthority(line), `restriction asserts authority: "${line}"`).toBe(false)
    }
  })

  it('keeps interaction-aligned settled contribution diagnostic without an exact causal estimate', () => {
    const r = detectOperatingMode({
      ...base,
      interactionCohorts: losingPair,
      profit: {
        currentAccountDailyBudget: 90,
        proposedAccountDailyBudget: null,
        recent: paidLoss(900),
        proposedTotal: null,
        matured: paidLoss(1_800),
        lineageMatchesEvaluationWindows: true,
      },
    })
    expect(r.authorityBasis).toBe('interaction_cohort_complete')
    expect(r.canRecommendBudgetCut).toBe(false)
    expect(r.budgetVerdict).toBe('loss_signal_review')
  })
})

describe('ENTRY POINT: learning brief consumed by the report prompts', () => {
  it('quarantines modelled segment averages from the report learning brief', async () => {
    const { buildLearningBrief } = await import('@/lib/learning/brief')
    const brief = await buildLearningBrief('acct-1')
    expect(brief).toBeNull()
  })
})

describe('ENTRY POINT: the flags MCP surface', () => {
  it('EVERY stored flag row resolves diagnostic by STRUCTURE, not by its wording', async () => {
    // The earlier version of this test asserted the prose-sniffing behaviour:
    // rows that "looked like" instructions were downgraded and the rest passed through as approved
    // advice. That made a phrase matcher the live safety decision. Now a flag with no ActionDecision
    // at or above the policy floor is diagnostic REGARDLESS of wording — including the innocuous-
    // sounding row, which the old matcher would have waved through.
    vi.resetModules()
    const legacyRows = [
      { flag_type: 'loser', reason: '$400 spent with 0 conversions',
        recommended_action: 'Pause. Check landing page URL, pixel firing, and creative angle.' },
      { flag_type: 'scale_candidate', reason: 'CPA under target',
        recommended_action: 'Do not pause; increase budget immediately.' },
      { flag_type: 'creative_refresh', reason: 'frequency 6.5',
        recommended_action: 'Everything looks completely fine here.' },
    ]
    vi.doMock('@/mcp/lib/supabase', () => {
      const chain: Record<string, unknown> = {}
      const self = () => chain
      chain.select = self; chain.eq = self; chain.order = self; chain.limit = self
      chain.then = (res: (v: { data: unknown[]; error: null }) => unknown) => res({ data: legacyRows, error: null })
      return { getSupabaseClient: () => ({ from: () => chain }) }
    })
    const { getWinnerLoserFlags } = await import('@/mcp/tools/flags')
    const out = await getWinnerLoserFlags({}) as {
      flags: Array<Record<string, unknown>>; action_authority: string }

    // ALL THREE are diagnostic — structure decided, not the words.
    expect(out.flags).toHaveLength(3)
    for (const f of out.flags) {
      expect(f.action_authority_tier).toBe('diagnostic_only_legacy')
      expect(assertsMoneyAuthority(String(f.recommended_action)),
        `MCP returned an imperative: ${f.recommended_action}`).toBe(false)
      expect(String(f.recommended_action)).toMatch(/HISTORICAL — DIAGNOSTIC ONLY/)
    }
    // Original prose remains in the database audit row but is never returned to a model/owner reader.
    expect(out.flags[0]).not.toHaveProperty('recommended_action_legacy_raw')
    expect(out.flags[1]).not.toHaveProperty('recommended_action_legacy_raw')
    // The negation-bypass phrase is flagged by defence-in-depth WITHOUT that changing its tier...
    expect(out.flags[1]!.action_authority_prose_warning).toBe(true)
    // ...and the innocuous row is still diagnostic, with no warning — proving structure, not wording.
    expect(out.flags[2]!.action_authority_prose_warning).toBeUndefined()
    expect(out.flags[2]!.action_authority_tier).toBe('diagnostic_only_legacy')

    expect(out.action_authority).toMatch(/DIAGNOSTIC/)
    vi.doUnmock('@/mcp/lib/supabase')
  })
})

describe('ENTRY POINT: no producer authors imperative money copy (source guard)', () => {
  it('imperative money strings exist only in the authority layer and its tests', () => {
    // A structural guard: the convergence is only durable if a future rule cannot quietly reintroduce
    // its own instruction string. Scans the real producer modules.
    const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(`${dir}/${e.name}`) : e.name.endsWith('.ts') ? [`${dir}/${e.name}`] : [])
    const files = ['src/lib/flags', 'src/lib/learning', 'src/lib/recommendations'].flatMap(walk)
    expect(files.length).toBeGreaterThan(5)
    const offenders: string[] = []
    for (const f of files) {
      const src = readFileSync(f, 'utf8')
      src.split('\n').forEach((line, i) => {
        // Only string literals matter; prose in comments is documentation, not output.
        const trimmed = line.trim()
        if (trimmed.startsWith('//') || trimmed.startsWith('*')) return
        const literals = line.match(/(['"`])(?:\\.|(?!\1).)*\1/g) ?? []
        for (const lit of literals) {
          if (assertsMoneyAuthority(lit)) offenders.push(`${f}:${i + 1} ${lit.slice(0, 90)}`)
        }
      })
    }
    expect(offenders, `producer modules author imperative money copy:\n${offenders.join('\n')}`).toEqual([])
  })
})
