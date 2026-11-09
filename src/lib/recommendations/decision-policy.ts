import { MAXX_OWNER_PROFIT_POLICY } from '@/lib/economics/profit-policy'
import type { AudienceResolution } from '@/lib/audience/resolver'
import type { ConversionActionability } from '@/lib/trust/conversion-actionability'
import type { DiversityReport } from '@/lib/creative/identity'
import { formatMoneyAmount } from '@/lib/utils/format-currency'

// RECOMMENDATION DECISION POLICY — what Maxx is allowed to output, and why.
//
// The failure this removes: "move Warm to $45 and Cold to $20" produced from a one-week snapshot in
// which the Warm set's modelled CPA looked better. That snapshot rested on view-through-heavy
// modelled conversions, a sample of three, and an audience whose real composition was MIXED. None of
// that supports a live spend instruction — but nothing in the pipeline said so.
//
// Every budget / pause / refresh / scale recommendation now passes an explicit gate chain. When the
// evidence is inadequate the output is FREEZE, MONITOR, TEST or OWNER_REVIEW — never a direct action
// dressed up with a confidence label. Write mode stays OFF regardless of the verdict.

/** Structural/evidence preflight only. `ready_for_authority` is NOT permission to act: it means the
 * candidate may proceed to the one ActionAuthority layer, which alone assigns an authority tier. */
export type DecisionVerdict = 'ready_for_authority' | 'test' | 'monitor' | 'freeze' | 'owner_review'
export type RecommendationKind = 'budget' | 'pause' | 'refresh' | 'scale'

/** Where the decision belongs — CBO campaigns are judged at campaign level, ABO at ad set level. */
export type OptimizationUnit = 'campaign' | 'adset' | 'ad' | 'unknown'

/**
 * WHERE a piece of outcome evidence was measured.
 *
 * The gate consumed ACCOUNT-wide first-party and GA4 totals and let them satisfy a
 * per-unit money decision. An account total is contextual business truth — it is not evidence that
 * THIS ad set caused those bookings. Attributing account outcomes to one unit is the same class of
 * error as reading a name as an audience.
 */
export type EvidenceScope = 'account' | 'campaign' | 'adset' | 'ad' | 'unknown'

export interface ScopedOutcomeEvidence {
  value: number | null
  scope: EvidenceScope
  provenance: string
}

export interface DecisionInputs {
  kind: RecommendationKind
  /** Budget structure decides the correct unit; unknown structure means the unit is unknown. */
  budgetStructure: 'cbo' | 'abo' | 'unknown'
  entityLevel: 'campaign' | 'adset' | 'ad'
  /** Resolved audience for the unit under consideration. */
  audience: AudienceResolution
  /** Actionability of the modelled conversion evidence. */
  conversions: ConversionActionability
  /** Business-truth outcomes in the window (first-party), WITH the scope they were measured at. */
  firstPartyOutcomes: ScopedOutcomeEvidence
  /** Web-attributed outcomes in the window, WITH the scope they were measured at. */
  webAttributedOutcomes: ScopedOutcomeEvidence
  /** Delivery facts available and fresh? */
  deliveryMeasured: boolean
  /** Meta learning state. */
  inLearning: boolean | null
  /** Creative duplication / diversity for the unit. */
  diversity: DiversityReport | null
  /**
   * Resolved audiences of the campaign's MEMBER ad sets. Required for a campaign-level decision: a
   * campaign has no targeting of its own, so mixed/missing/contradictory member metadata freezes.
   */
  memberAudiences?: AudienceResolution[] | null
  /** Running experiments whose changed_variable collides with this recommendation. */
  conflictingExperiments: string[]
  /** Days of data behind the recommendation. */
  windowDays: number
  /** Current and proposed budget, when the recommendation moves money. */
  currentBudget: number | null
  proposedBudget: number | null
  /** Is there completed causal evidence (a finished experiment) supporting this? */
  hasCausalEvidence: boolean
}

export interface DecisionGate {
  name: string
  passed: boolean
  detail: string
}

export interface EvidenceSeparation {
  businessTruth: string
  webAttributed: string
  metaModeled: string
  delivery: string
  viewClickMix: string
  sampleAdequacy: string
  creativeDiversity: string
  experimentConflicts: string
  learningState: string
}

export interface DecisionResult {
  verdict: DecisionVerdict
  /** The unit this decision belongs at — a CBO campaign is never judged at ad-set level. */
  optimizationUnit: OptimizationUnit
  gates: DecisionGate[]
  /** Gates that failed, in order — the reason the candidate cannot proceed to final authority. */
  blockedBy: string[]
  /** Every plane stated separately, never blended. */
  evidence: EvidenceSeparation
  /** The threshold that would have to be met, stated explicitly. */
  decisionThreshold: string
  /** What could go wrong if this were acted on anyway. */
  counterfactualRisk: string
  /** Populated when the verdict is 'test'. */
  testBriefRequired: boolean
  /** Write mode is never enabled by a verdict. Always false here. */
  writeModeEnabled: false
  summary: string
}

/** A single week is never enough on its own for a live spend change. */
export const MIN_WINDOW_DAYS_FOR_DIRECT_ACTION = 14

/**
 * PURE: where the decision belongs — resolved by RECOMMENDATION KIND, not by budget structure alone.
 *
 * A single budget-shaped resolver was applied to every kind, so a creative REFRESH on
 * an ad and a STATUS change on a campaign were both forced onto the budget unit. Budget structure
 * only decides where MONEY decisions belong; a creative decision belongs to the ad that carries the
 * creative, and a status decision belongs to the level actually being paused or activated.
 */
export function resolveOptimizationUnit(
  budgetStructure: DecisionInputs['budgetStructure'],
  entityLevel: DecisionInputs['entityLevel'],
  kind: RecommendationKind = 'budget',
): OptimizationUnit {
  // Creative decisions target the AD — the thing that owns the creative. An ad never owns a budget,
  // but it does own its asset, so a refresh is correctly judged at ad level.
  if (kind === 'refresh') return entityLevel === 'ad' ? 'ad' : entityLevel

  // Status decisions (pause/activate) belong to the level actually being changed... EXCEPT under CBO,
  // where pausing one ad set redistributes budget across the rest and is therefore a campaign-level
  // consequence.
  if (kind === 'pause') {
    if (budgetStructure === 'unknown') return 'unknown'
    if (budgetStructure === 'cbo' && entityLevel === 'adset') return 'campaign'
    return entityLevel
  }

  // MONEY decisions: CBO -> campaign, ABO -> ad set. An ad never owns a budget.
  if (budgetStructure === 'cbo') return 'campaign'
  if (budgetStructure === 'abo') return entityLevel === 'ad' ? 'adset' : entityLevel
  return 'unknown'
}

const fmt = (v: number | null): string => (v === null ? 'unknown' : String(v))

/**
 * PURE: run the full gate chain. Order matters — structural blockers (unit, freshness) come before
 * evidence-quality gates, so the reported reason is the FIRST thing that must be fixed.
 */
export function decideRecommendation(input: DecisionInputs): DecisionResult {
  const gates: DecisionGate[] = []
  const unit = resolveOptimizationUnit(input.budgetStructure, input.entityLevel, input.kind)

  // 1. Correct optimization unit.
  gates.push({
    name: 'optimization_unit_identified',
    passed: unit !== 'unknown',
    detail:
      unit === 'unknown'
        ? 'budget structure is unknown, so the correct optimization unit cannot be identified — a CBO campaign must not be judged at ad-set level'
        : `budget structure ${input.budgetStructure} -> decide at ${unit} level`,
  })

  // 1b. CAMPAIGN-level decisions must rest on their MEMBER ad sets. A campaign has no targeting of
  //     its own, so its audience context is the conservative roll-up of its members: any member that
  //     is mixed, unknown, frozen or simply missing makes the campaign context unusable.
  if (unit === 'campaign') {
    const members = input.memberAudiences ?? null
    const usable = members !== null && members.length > 0 && members.every((m) => !m.frozen)
    const compositions = members ? [...new Set(members.map((m) => m.composition))] : []
    const conservative = !members || members.length === 0
      ? 'unknown'
      : compositions.includes('unknown') ? 'unknown'
      : compositions.includes('mixed') || compositions.length > 1 ? 'mixed'
      : compositions[0]
    gates.push({
      name: 'campaign_member_context_resolved',
      passed: usable && conservative !== 'unknown',
      detail: !members || members.length === 0
        ? 'a campaign-level decision was requested but NO member ad-set context was supplied — campaign context is unresolved'
        : !usable
          ? `${members.filter((m) => m.frozen).length} of ${members.length} member ad set(s) are frozen — campaign context is unresolved`
          : `member composition rolls up conservatively to ${conservative} across ${members.length} ad set(s)`,
    })
  }

  // 2. Fresh, complete targeting metadata.
  gates.push({
    name: 'targeting_fresh_and_complete',
    passed: !input.audience.frozen,
    detail: input.audience.frozen
      ? `targeting is unavailable or stale (${input.audience.unknownReason ?? 'unresolved'}) — audience and budget conclusions are frozen`
      : `targeting resolved ${input.audience.targetingAgeHours ?? '?'}h ago; composition ${input.audience.composition} (confidence ${input.audience.confidence})`,
  })

  // 3. Audience composition established. MIXED is a real, resolved configuration — not an evidence
  // failure. If the causal contribution result was measured on that exact unchanged configuration,
  // generic audience doctrine must not veto it. UNKNOWN remains blocked because transport and
  // structural continuity cannot be verified against an unidentified setup.
  const compositionOk = input.audience.composition !== 'unknown'
  gates.push({
    name: 'audience_composition_established',
    passed: compositionOk,
    detail: compositionOk
      ? `composition is established as ${input.audience.composition}; any causal result applies only to this exact unchanged configuration`
      : 'composition is unknown — the evaluated setup and transport boundary cannot be established',
  })

  // 4. Meta-modelled conversion context is recorded, never used as a commercial gate. Bookings,
  // leads, CPA and platform ROAS may explain delivery, but final ActionAuthority alone evaluates
  // causal incremental contribution from settled money components.
  gates.push({
    name: 'modelled_conversion_context_recorded',
    passed: true,
    detail: `Meta-modelled conversion context is ${input.conversions.level} (score ${input.conversions.score}) and is diagnostic only; it neither authorizes nor vetoes a commercial direction.`,
  })

  // 5. A fixed calendar floor is also diagnostic only. The governed contribution evidence owns its
  // realization horizon and must prove maturity through settlement, cancellation and refund lag.
  gates.push({
    name: 'calendar_window_context_recorded',
    passed: true,
    detail: `${input.windowDays}-day legacy diagnostic window recorded. Final authority uses the contribution evidence's governed realization horizon and maturity, not the fixed ${MIN_WINDOW_DAYS_FOR_DIRECT_ACTION}-day proxy floor.`,
  })

  // 6. Learning state is delivery context, not decision sufficiency. Exact paid evidence, maturity,
  // causal scope and governance decide actionability; learning neither proves nor vetoes a result.
  gates.push({
    name: 'learning_state_observed',
    passed: true,
    detail:
      input.inLearning === false
        ? 'the unit has exited the learning phase; that does not prove business impact'
        : input.inLearning === null
          ? 'learning state is unknown; decision sufficiency is evaluated independently'
          : 'the unit is in the learning phase; this describes delivery exploration, not whether the business result is true or actionable',
  })

  // 7. No conflicting running experiment.
  gates.push({
    name: 'no_experiment_conflict',
    passed: input.conflictingExperiments.length === 0,
    detail:
      input.conflictingExperiments.length === 0
        ? 'no running experiment touches this variable'
        : `conflicts with running experiment(s): ${input.conflictingExperiments.join(', ')} — acting now would contaminate the result`,
  })

  // 8. Attributed outcome scope is recorded for diagnosis only. Account totals remain contextual
  // business truth and unit paid-touch joins remain association. Neither can grant or deny the
  // causal contribution authority evaluated downstream against immutable experiment lineage.
  const needsUnitScoped = input.kind === 'budget' || input.kind === 'scale' || input.kind === 'pause'
  const scopeRank: Record<EvidenceScope, number> = { ad: 3, adset: 2, campaign: 1, account: 0, unknown: -1 }
  const unitRank = unit === 'unknown' ? -1 : scopeRank[unit as EvidenceScope]
  const unitScoped = [input.firstPartyOutcomes, input.webAttributedOutcomes].filter(
    (e) => e.value !== null && scopeRank[e.scope] >= unitRank && e.scope !== 'account',
  )
  gates.push({
    name: 'attributed_outcome_scope_recorded',
    passed: true,
    detail:
      !needsUnitScoped
        ? 'not required for this recommendation kind'
        : unitScoped.length > 0
          ? `Attributed outcome context exists at ${unitScoped.map((e) => e.scope).join(', ')} scope. It remains association and does not substitute for causal contribution authority.`
          : `Only ${input.firstPartyOutcomes.scope}/${input.webAttributedOutcomes.scope} attributed context exists. That does not block structural preflight, but it grants no commercial authority.`,
  })

  // 9. Legacy experiment metadata cannot serve as a second commercial brain. Final authority requires
  // the governed contribution definition, atomic settled-money reconciliation, treatment/comparator
  // lineage, uncertainty, maturity and the action-specific estimand regardless of this old boolean.
  const needsCausal = input.kind === 'budget' || input.kind === 'scale'
  gates.push({
    name: 'commercial_authority_deferred',
    passed: true,
    detail:
      !needsCausal
        ? 'Commercial direction is evaluated only by final governed contribution authority.'
        : input.hasCausalEvidence
          ? 'Legacy completed-test metadata is present, but final authority independently requires causal incremental contribution under the governed money contract.'
          : 'Legacy completed-test metadata is absent. This cannot veto or authorize final causal incremental contribution authority.',
  })

  // 10. Per-unit legacy budget sizing is context only. The final policy validates the proven live
  // account-total current and proposed exposure against the owner-approved hard ceiling (MAXX_OWNER_PROFIT_POLICY.dailyBudgetCeiling).
  if (input.kind === 'budget' || input.kind === 'scale') {
    gates.push({
      name: 'budget_context_recorded',
      passed: true,
      detail: `Legacy unit budget context: current ${fmt(input.currentBudget)}, proposed ${fmt(input.proposedBudget)}. Final authority uses proven account-total exposure and enforces the ${formatMoneyAmount(MAXX_OWNER_PROFIT_POLICY.dailyBudgetCeiling)} ceiling.`,
    })
  }

  // 11. Creative diversity, for refresh recommendations.
  if (input.kind === 'refresh' && input.diversity) {
    const dupSpanning = input.diversity.duplicates.filter((d) => d.spansMultipleAdsets)
    gates.push({
      name: 'creative_diversity_understood',
      passed: dupSpanning.length === 0,
      detail:
        dupSpanning.length === 0
          ? `${input.diversity.distinctAssets} distinct asset(s) across ${input.diversity.totalAds} ad(s)`
          : `${dupSpanning.length} asset(s) are reused across ad sets — apparent creative variety overstates real diversity`,
    })
  }

  const blockedBy = gates.filter((g) => !g.passed).map((g) => g.name)

  // Verdict, most-blocking first.
  let verdict: DecisionVerdict
  if (blockedBy.includes('targeting_fresh_and_complete')) {
    verdict = 'freeze'
  } else if (blockedBy.includes('optimization_unit_identified') || blockedBy.includes('campaign_member_context_resolved')) {
    verdict = 'owner_review'
  } else if (blockedBy.includes('no_experiment_conflict')) {
    verdict = 'monitor'
  } else if (blockedBy.length === 0) {
    verdict = 'ready_for_authority'
  } else if (
    blockedBy.includes('audience_composition_established')
  ) {
    // An unidentified configuration needs a governed test/measurement plan, never a spend instruction.
    verdict = 'test'
  } else {
    verdict = 'monitor'
  }

  const vtShare = input.conversions.viewThroughShare
  const evidence: EvidenceSeparation = {
    businessTruth: `first-party outcomes: ${fmt(input.firstPartyOutcomes.value)} [scope=${input.firstPartyOutcomes.scope}; ${input.firstPartyOutcomes.provenance}]`,
    webAttributed: `web-attributed (GA4) outcomes: ${fmt(input.webAttributedOutcomes.value)} [scope=${input.webAttributedOutcomes.scope}; ${input.webAttributedOutcomes.provenance}]`,
    metaModeled: `Meta modelled attribution: actionability ${input.conversions.level} (score ${input.conversions.score})`,
    delivery: input.deliveryMeasured
      ? 'Meta delivery facts (spend, impressions, reach) are measured and may be stated directly'
      : 'Meta delivery facts are unavailable',
    viewClickMix:
      vtShare === null
        ? 'view/click attribution mix is UNKNOWN — not evidence of click-driven conversions'
        : `${Math.round(vtShare * 100)}% of attributed conversions are view-through`,
    sampleAdequacy: `${input.windowDays}-day window; ${input.conversions.caps.length} evidence cap(s) applied`,
    creativeDiversity: input.diversity
      ? `${input.diversity.distinctAssets} distinct asset(s) across ${input.diversity.totalAds} ad(s); ${input.diversity.duplicates.length} duplicate group(s)`
      : 'creative diversity not evaluated for this recommendation',
    experimentConflicts:
      input.conflictingExperiments.length === 0 ? 'none' : input.conflictingExperiments.join(', '),
    learningState:
      input.inLearning === null ? 'unknown' : input.inLearning ? 'in learning' : 'exited learning',
  }

  const decisionThreshold =
    'ready_for_authority requires a correct optimization unit, fresh identified targeting, and no conflicting experiment. ' +
    'It grants no governed contribution authority: final ActionAuthority separately requires action-specific causal contribution, definition continuity, settled-money lineage, uncertainty, maturity, and the proven account-total budget ceiling.'

  const counterfactualRisk =
    verdict === 'ready_for_authority'
      ? 'Structural preflight passed; the final ActionAuthority layer still decides whether any owner-facing action is permitted from governed causal contribution evidence.'
      : `acting anyway would commit real spend on evidence that failed: ${blockedBy.join(', ')}. ` +
        `If the modelled signal is an artefact of ${vtShare !== null && vtShare >= 0.5 ? 'view-through attribution' : 'a thin or unresolved sample'}, ` +
        `the result could concentrate spend in inventory that is not actually performing, and the change itself would destroy the baseline needed to detect that.`

  const summary =
    verdict === 'ready_for_authority'
      ? 'Structural preflight is complete at the identified optimization unit. This candidate must now pass final ActionAuthority; this verdict grants no commercial authority or action permission.'
      : verdict === 'test'
        ? 'Evidence does not support a direct spend change. A governed CampaignPlan is required before any test can be created.'
        : verdict === 'freeze'
          ? 'Audience and budget conclusions are frozen until fresh targeting metadata is available.'
          : verdict === 'monitor'
            ? 'Hold and keep measuring — acting now would either contaminate a running test or rest on unresolved evidence.'
            : 'Escalate to owner review: the decision cannot be correctly scoped from available metadata.'

  return {
    verdict,
    optimizationUnit: unit,
    gates,
    blockedBy,
    evidence,
    decisionThreshold,
    counterfactualRisk,
    // Historical signal only. Production does not create a brief from this flag: an owner-governed
    // CampaignPlan must define the test variable, ceilings, measurement maturity, and stop rules.
    testBriefRequired:
      verdict !== 'freeze' &&
      !blockedBy.includes('optimization_unit_identified') &&
      verdict === 'test',
    writeModeEnabled: false,
    summary,
  }
}

export interface TestBrief {
  hypothesis: string
  /** EXACT identity of the unit under test. Matching never parses the free-text refs. */
  entityLevel: 'campaign' | 'adset' | 'ad'
  entityRef: string
  changedVariable: string
  controlRef: string
  challengerRef: string
  invariants: Record<string, string>
  primaryMetric: string
  guardrails: string[]
  minSample: number
  minSpend: number
  successContract: string
  provenance: string
}

/**
 * Disabled legacy surface. It manufactured booking/CPA hypotheses plus universal sample and spend
 * floors without processor-settled contribution, owner loss limits, assignment, or maturity. A
 * caller must use the governed CampaignPlan grader instead of reviving that second objective.
 */
export function buildTestBrief(
  _input: DecisionInputs,
  _decision: DecisionResult,
  _identity: { entityLevel: 'campaign' | 'adset' | 'ad'; entityRef: string },
): TestBrief {
  void _input
  void _decision
  void _identity
  throw new Error(
    'Legacy test-brief generation is disabled. Use the governed CampaignPlan grader with causal incremental contribution dollars, owner ceilings, assignment, maturity, and stop rules.',
  )
}
