import {
  arbitrateMoneyDispositions, decideActionAuthority, isMoneyKind,
  type ActionAuthorityDecision, type ActionKind, type DecisionUnit, type EvidencePlane,
} from './action-authority'
import type { ActionDecisionCommit, ActionTargetLevel } from './action-decision-store'
import { ACTION_DECISION_POLICY_FLOOR } from './legacy-cutover'
import type { AuthorityBasis } from '@/lib/modes/operating-mode'
import { MAXX_OWNER_PROFIT_POLICY } from '@/lib/economics/profit-policy'
import type { DirectionalEvidence } from './directional-policy'
import type { DecisionResult } from '@/lib/recommendations/decision-policy'
import type { Recommendation, RecommendationType, TargetEntityType } from '@/lib/recommendations/types'

const KIND_BY_RECOMMENDATION: Record<RecommendationType, ActionKind> = {
  scale: 'budget_scale', scale_proposal: 'budget_scale', reduce_budget: 'budget_cut',
  pause: 'pause', activate: 'activate', refresh_creative: 'creative_refresh',
  change_optimization_event: 'structural', change_audience: 'structural', restructure: 'structural',
  launch_test: 'observe', keep: 'observe', investigate: 'observe', hold: 'observe', no_action: 'observe',
  launch_setup: 'structural', audience_test: 'structural', creative_test: 'creative_refresh',
  budget_watch: 'observe', pause_watch: 'observe', funnel_diagnosis: 'observe',
  attribution_issue: 'observe', tracking_issue: 'observe', low_data_guidance: 'observe',
  weekly_strategy: 'observe', do_not_touch: 'observe',
}

export const actionKindForRecommendation = (type: RecommendationType): ActionKind => KIND_BY_RECOMMENDATION[type]

function targetFor(type: TargetEntityType, id: string | null): { level: ActionTargetLevel; id: string | null } {
  if (type === 'campaign' || type === 'adset' || type === 'ad' || type === 'audience' || type === 'creative') {
    if (!id?.trim()) {
      throw new Error(`A ${type}-level ActionDecision requires a non-empty target id; it cannot be relabelled as an account decision.`)
    }
    return { level: type, id }
  }
  return { level: 'account', id: null }
}

/**
 * Lowering a decision to DIAGNOSTIC ONLY must lower the DIRECTION CEILING with it. They are one fact
 * about one decision, and the database says so: `action_decisions_v4_money_quarantine` admits a money
 * row at `authority_tier='diagnostic_only'` only when `direction_ceiling='unsupported'` and
 * `pragmatic_media_buyer IS NOT TRUE`. Spreading the decision and overriding `tier` alone left the
 * ceiling at `'owner_review'`, and `recommendationDecisionCommit` writes that ceiling verbatim --
 * so the row failed all four CHECK branches. The publisher is atomic (its function comment: "Any malformed
 * claim, binding, decision, or generation rolls the entire write back"), and `orchestrator.ts`
 * swallows the failure into `partialErrors`, so the visible symptom is not an error: it is the
 * account losing EVERY recommendation for the run, and its daily report, in silence.
 *
 * The bug could only fire once a money action actually reached `owner_review` -- which is exactly
 * what restoring the money-authority path does. The fix and the feature had to ship together.
 *
 * Kept as one function so the two fields cannot drift apart again at a future call site.
 */
function toDiagnosticOnly(
  decision: ActionAuthorityDecision,
  reason: string,
  copy: string,
): ActionAuthorityDecision {
  return { ...decision, tier: 'diagnostic_only', directionCeiling: 'unsupported', reason, copy }
}

function constrainByPreflight(
  decision: ActionAuthorityDecision,
  preflight: DecisionResult | null,
  observation: string,
): ActionAuthorityDecision {
  // Missing preflight is UNKNOWN, not permission. The evaluator and any future producer that has not
  // resolved optimization unit, targeting, learning and conflict state cannot promote an action simply
  // by omitting the gate result. Observation-only candidates do not reach this branch as an action.
  if (!preflight) {
    if (!decision.isMoneyAction && decision.tier === 'diagnostic_only') return decision
    return toDiagnosticOnly(
      decision,
      'Final authority is DIAGNOSTIC ONLY because no server-resolved preflight decision was supplied.',
      `DIAGNOSTIC ONLY. ${observation} Required optimization-unit, targeting, learning and conflict checks were not resolved.`,
    )
  }
  if (preflight.verdict === 'ready_for_authority') return decision
  const subject = preflight.optimizationUnit === 'unknown' ? '' : `${preflight.optimizationUnit}: `
  const why = `Preflight verdict ${preflight.verdict}; blocked by ${preflight.blockedBy.join(', ') || 'policy review'}. ${preflight.summary}`
  if (preflight.verdict === 'owner_review' && decision.tier === 'execution_eligible') {
    return {
      ...decision,
      tier: 'owner_review',
      reason: `Final authority capped at OWNER REVIEW by preflight. ${why}`,
      copy: `${subject}FOR OWNER REVIEW — not execution-eligible. ${observation} ${why}`,
    }
  }
  if (preflight.verdict === 'owner_review' && decision.tier === 'owner_review') return decision
  return toDiagnosticOnly(
    decision,
    `Final authority is DIAGNOSTIC ONLY because preflight did not clear. ${why}`,
    `${subject}DIAGNOSTIC ONLY. ${observation} ${why}`,
  )
}

export interface RecommendationAuthorityInput {
  recommendation: Recommendation
  /** Original intent before grounding/evidence gates rewrite it to hold/investigate. */
  intendedType: RecommendationType
  basis: AuthorityBasis
  plane: EvidencePlane
  /** Trusted, server-resolved economics for the requested direction. Omitted fails money actions
   * closed even when the evidence label says interaction cohort. */
  evidence?: DirectionalEvidence
  preflight: DecisionResult | null
  /** Pragmatic media-buyer mode: attributed-only association evidence may reach owner_review. */
  pragmaticMediaBuyerEnabled?: boolean
}

/** Final authority for one recommendation. No other recommendation gate grants action permission. */
export function decideRecommendationAuthority(input: RecommendationAuthorityInput): ActionAuthorityDecision {
  const rec = input.recommendation
  const base = decideActionAuthority({
    kind: actionKindForRecommendation(input.intendedType),
    plane: input.plane,
    observation: rec.observed_fact,
    investigate: 'Verify the observation against the named evidence plane and the current account setup.',
    subjectRef: rec.target_entity_name ?? rec.target_entity_id ?? undefined,
  }, input.basis, input.evidence, { pragmaticMediaBuyerEnabled: input.pragmaticMediaBuyerEnabled })
  return constrainByPreflight(base, input.preflight, rec.observed_fact)
}

/** Make the source recommendation agree with its durable authority projection. */
export function applyRecommendationAuthority(
  rec: Recommendation,
  intendedType: RecommendationType,
  decision: ActionAuthorityDecision,
): Recommendation {
  const intendedKind = actionKindForRecommendation(intendedType)
  const moneyOrChange = intendedKind !== 'observe'
  const shouldDowngradeType = moneyOrChange && decision.tier === 'diagnostic_only'
    && !['hold', 'investigate', 'launch_test', 'budget_watch', 'pause_watch'].includes(rec.recommendation_type)
  const authorityNote = `ACTION AUTHORITY (${decision.tier}; ${decision.plane}/${decision.authorityBasis}): ${decision.reason}`
  const finalAuthorityCleared = moneyOrChange && decision.tier !== 'diagnostic_only'
  const finalGroundingReason = finalAuthorityCleared
    ? 'Final governed authority cleared this direction. Legacy booking/CPA, platform ROAS, spend-volume, and fixed-day diagnostics cannot authorize or veto it.'
    : null
  return {
    ...rec,
    recommendation_type: shouldDowngradeType
      ? 'investigate'
      : finalAuthorityCleared ? intendedType : rec.recommendation_type,
    reason_for_action: decision.copy,
    approval_required: decision.tier !== 'diagnostic_only',
    action_allowed_now: false,
    expected_upside: moneyOrChange && decision.tier === 'diagnostic_only'
      ? null
      : rec.expected_upside,
    possible_downside: moneyOrChange && decision.tier === 'diagnostic_only'
      ? null
      : rec.possible_downside,
    low_data_warning: finalAuthorityCleared && decision.directionCeiling === 'execution'
      ? null
      : rec.low_data_warning,
    minimum_data_needed: finalAuthorityCleared
      ? decision.directionCeiling === 'execution'
        ? null
        : 'More causal-contribution precision or explicit owner judgment is required; booking and CPA volume cannot close this gap.'
      : rec.minimum_data_needed,
    no_oscillation_check: finalAuthorityCleared
      ? {
          is_reversal_class: rec.no_oscillation_check.is_reversal_class,
          allowed: true,
          reason: 'Final authority applied the governed causal contribution, maturity, continuity, and budget contract; legacy booking/CPA cadence rules do not control this money direction.',
          blocking_factors: [],
        }
      : rec.no_oscillation_check,
    what_could_make_this_wrong: [...rec.what_could_make_this_wrong, authorityNote],
    grounding: {
      ...rec.grounding,
      passed: finalAuthorityCleared ? true : rec.grounding.passed,
      decision: finalAuthorityCleared ? 'allow' : rec.grounding.decision,
      reasons: [
        ...rec.grounding.reasons,
        ...(finalGroundingReason ? [finalGroundingReason] : []),
        authorityNote,
      ],
    },
  }
}

function metricSnapshot(rec: Recommendation): Record<string, number | null> {
  const out: Record<string, number | null> = {}
  for (const metric of rec.metric_values) {
    const key = metric.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')
    if (key) out[key] = typeof metric.value === 'number' && Number.isFinite(metric.value) ? metric.value : null
  }
  return out
}

/** Durable RPC payload. `sourceId` is the recommendation row UUID generated before publication. */
export function recommendationDecisionCommit(args: {
  sourceId: string
  recommendation: Recommendation
  intendedType: RecommendationType
  decision: ActionAuthorityDecision
  /**
   * The evidence the decision was actually taken on. `undefined` is meaningful and permitted —
   * `decideActionAuthority` takes optional evidence, and a non-money kind genuinely has none — in
   * which case the three fields below are null because nothing was computed, which is the truth.
   * What is NOT permitted is null when a value exists, which is what this parameter exists to end.
   */
  evidence: DirectionalEvidence | undefined
  paidCohortLineage: {
    recentGenerationId: string
    maturedGenerationId: string
  } | null
}): ActionDecisionCommit {
  const target = targetFor(args.recommendation.target_entity_type, args.recommendation.target_entity_id)
  const interactionCohort = args.decision.authorityBasis === 'interaction_cohort_complete'
    || args.decision.plane === 'interaction_cohort'
  if (interactionCohort && !args.paidCohortLineage) {
    throw new Error('An interaction-cohort ActionDecision requires durable paid-cohort lineage.')
  }
  if (!interactionCohort && args.paidCohortLineage) {
    throw new Error('Paid-cohort lineage may only accompany interaction-cohort evidence.')
  }
  return {
    action_kind: actionKindForRecommendation(args.intendedType),
    target_level: target.level,
    target_id: target.id,
    evidence_plane: args.decision.plane,
    evidence_basis: args.decision.authorityBasis,
    authority_tier: args.decision.tier,
    authority_reason: args.decision.reason,
    owner_copy: args.decision.copy,
    direction_ceiling: args.decision.directionCeiling,
    direction_reason: args.decision.reason,
    policy_version: ACTION_DECISION_POLICY_FLOOR,
    dedupe_key: `recommendation:${args.sourceId}:v${ACTION_DECISION_POLICY_FLOOR}`,
    source_id: args.sourceId,
    window_start: args.recommendation.date_range?.start ?? null,
    window_end: args.recommendation.date_range?.end ?? null,
    objective: MAXX_OWNER_PROFIT_POLICY.objective,
    // These three were literal `null` on every row. The columns exist, the engine computes all three,
    // and the reasoning that lands in `authority_reason` is derived from them — so a reader querying
    // the table saw "unknown" on decisions whose stated reason was "a material setup change falls
    // inside the two windows being compared", which is `continuity: false`, a proven fact.
    //
    // That is not a cosmetic gap. It is the denormalised-trust failure this codebase keeps paying
    // for: the durable record contradicting the decision it records. It produced a wrong diagnosis
    // during the investigation that found it — `continuity: null` across many rows read as "continuity
    // could not be established", and the conclusion drawn was that the continuity fix had not worked
    // when it had.
    matured: args.evidence?.lagged?.matured ?? null,
    continuity: args.evidence?.structuralContinuity ?? null,
    windows_conflict: args.evidence?.windowsConflict ?? null,
    metrics: metricSnapshot(args.recommendation),
    proposed_mutation: null,
    paid_cohort_recent_generation_id: args.paidCohortLineage?.recentGenerationId ?? null,
    paid_cohort_matured_generation_id: args.paidCohortLineage?.maturedGenerationId ?? null,
    pragmatic_media_buyer: args.decision.isMoneyAction
      && args.decision.tier === 'owner_review'
      && (
        (args.decision.plane === 'interaction_cohort'
          && args.decision.authorityBasis === 'interaction_cohort_complete')
        || (args.decision.plane === 'meta_modelled'
          && args.decision.authorityBasis === 'meta_modelled_association')
      ),
  }
}

export interface RecommendationAuthorityPublication {
  row: Record<string, unknown>
  decision: ActionAuthorityDecision
  commit: ActionDecisionCommit
}

/** Apply final one-money-disposition-per-unit arbitration to the exact rows being published. */
export function arbitrateRecommendationPublications(
  adAccountId: string,
  publications: RecommendationAuthorityPublication[],
): RecommendationAuthorityPublication[] {
  const candidates = publications.flatMap((publication) => {
    const { commit } = publication
    if (!isMoneyKind(commit.action_kind)) return []
    if (!['account', 'campaign', 'adset', 'ad'].includes(commit.target_level)) return []
    const unit: DecisionUnit = {
      adAccountId,
      targetLevel: commit.target_level as DecisionUnit['targetLevel'],
      targetId: commit.target_id,
      windowStart: commit.window_start,
      windowEnd: commit.window_end,
      policyVersion: commit.policy_version,
    }
    return [{ publication, kind: commit.action_kind, decision: publication.decision, unit }]
  })

  const suppressed = new Map<string, string>()
  for (const result of arbitrateMoneyDispositions(candidates)) {
    // When every candidate is already diagnostic there is no actionable instruction to suppress.
    if (!result.winner) continue
    for (const loser of result.suppressed) {
      suppressed.set(loser.candidate.publication.commit.source_id, loser.reason)
    }
  }

  return publications.map((publication) => {
    const reason = suppressed.get(publication.commit.source_id)
    if (!reason) return publication
    const copy = `DIAGNOSTIC ONLY — suppressed by final arbitration. ${reason}`
    const priorRisks = Array.isArray(publication.row.what_could_make_this_wrong)
      ? publication.row.what_could_make_this_wrong
      : []
    return {
      decision: toDiagnosticOnly(publication.decision, reason, copy),
      commit: {
        ...publication.commit,
        authority_tier: 'diagnostic_only',
        // Unlike the preflight path, arbitration runs AFTER `recommendationDecisionCommit` has built
        // the row, so `pragmatic_media_buyer` was already derived as `true` from the pre-downgrade
        // `owner_review` tier and is stale here. Both fields must come down with the tier or the
        // CHECK rejects the row and the whole atomic publication with it.
        direction_ceiling: 'unsupported',
        pragmatic_media_buyer: false,
        authority_reason: reason,
        owner_copy: copy,
      },
      row: {
        ...publication.row,
        recommendation_type: 'investigate',
        reason_for_action: copy,
        approval_required: false,
        action_allowed_now: false,
        what_could_make_this_wrong: [...priorRisks, reason],
      },
    }
  })
}
