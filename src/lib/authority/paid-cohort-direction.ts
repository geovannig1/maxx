import type {
  InteractionCohortPairSignal,
  InteractionCohortSignal,
} from '@/lib/modes/operating-mode'
import type { MetaDeliveryObjective } from '@/lib/modes/objective'
import type { TargetPolicyStatus } from '@/lib/targets/store'
import type { PaidCohortEvidence, PaidCohortPairEvidence } from '@/lib/attribution/paid-cohort-store'
import { validateContributionEvidence, type DirectionalEvidence, type ModelledDirectionalEvidence } from './directional-policy'
import {
  ownerProfitPolicyEvidence,
  type ContributionWindowEvidence,
} from '@/lib/economics/profit-policy'
import { PRAGMATIC_DAILY_BUDGET_CEILING } from '@/lib/economics/pragmatic-profit-evidence'
import { isMoneyKind, type ActionKind, type EvidencePlane } from './action-authority'
import type { AuthorityBasis } from '@/lib/modes/operating-mode'

export interface PaidCohortDirectionInput {
  cohorts: InteractionCohortPairSignal | null
  objective: MetaDeliveryObjective
  structuralContinuity: boolean | null
  /** The owner's CPA target and maximum; null until set. */
  targetCpa: number | null
  maxCpa: number | null
  targetPolicyStatus: TargetPolicyStatus
  /** Profit evidence is a separate, stricter plane. Booked-value paid cohorts cannot manufacture it. */
  profit?: {
    currentAccountDailyBudget: number | null
    proposedAccountDailyBudget: number | null
    recent: ContributionWindowEvidence | null
    proposedTotal: ContributionWindowEvidence | null
    matured: ContributionWindowEvidence | null
    /** Proves contribution windows share the evaluated entity, dates, spend basis and run identity. */
    lineageMatchesEvaluationWindows: boolean
  } | null
  /** Meta-modelled fallback for this entity. Used only when no contribution evidence exists. */
  modelled?: ModelledDirectionalEvidence | null
}

export interface PaidCohortDirectionAnalysis {
  evidence: DirectionalEvidence | null
  scaleComplete: boolean
  recentCutComplete: boolean
  recentComplete: boolean
  maturedComplete: boolean
  recentCpa: number | null
  maturedCpa: number | null
  historicalLoss: boolean
  recentRecovery: boolean
  windowsConflict: boolean
}

const EMPTY_ANALYSIS: PaidCohortDirectionAnalysis = {
  evidence: null,
  scaleComplete: false,
  recentCutComplete: false,
  recentComplete: false,
  maturedComplete: false,
  recentCpa: null,
  maturedCpa: null,
  historicalLoss: false,
  recentRecovery: false,
  windowsConflict: false,
}

function signalFromStored(evidence: PaidCohortEvidence): InteractionCohortSignal {
  const recordedRevenue = evidence.metrics.outcome_recorded_revenue
  return {
    generationId: evidence.generationId,
    windowStart: evidence.windowStart,
    windowEnd: evidence.windowEnd,
    asOfDate: evidence.asOfDate,
    complete: evidence.complete,
    allUnitsComplete: evidence.generationComplete,
    blockerCodes: [...evidence.blockerCodes],
    spend: evidence.spend,
    bookings: evidence.bookings,
    bookedValue: evidence.bookedValue,
    recordedRevenue: evidence.complete
      && typeof recordedRevenue === 'number' && Number.isFinite(recordedRevenue) && recordedRevenue >= 0
      ? recordedRevenue
      : null,
  }
}

export function toInteractionCohortPairSignal(
  pair: PaidCohortPairEvidence | null,
): InteractionCohortPairSignal | null {
  return pair
    ? {
        evaluationRunId: pair.evaluationRunId,
        recentScale: signalFromStored(pair.recentScale),
        maturedCut: signalFromStored(pair.maturedCut),
      }
    : null
}

function windowUsable(signal: InteractionCohortSignal): boolean {
  return signal.complete
    && signal.spend !== null && Number.isFinite(signal.spend) && signal.spend >= 0
}

function bookingDiagnosticUsable(signal: InteractionCohortSignal): boolean {
  return windowUsable(signal)
    && signal.bookings !== null && Number.isInteger(signal.bookings) && signal.bookings >= 0
    && signal.bookedValue !== null && Number.isFinite(signal.bookedValue) && signal.bookedValue >= 0
}

function cpa(signal: InteractionCohortSignal): number | null {
  return signal.bookings && signal.bookings > 0 && signal.spend !== null
    ? signal.spend / signal.bookings
    : null
}

/**
 * Convert one immutable paid-cohort pair into the single directional policy vocabulary.
 *
 * Bookings/booked value remain diagnostics. Commercial direction exists only when separate settled-
 * contribution windows match the evaluated entity, dates, spend basis and immutable run identity.
 */
export function analyzePaidCohortDirection(
  input: PaidCohortDirectionInput,
): PaidCohortDirectionAnalysis {
  const pair = input.cohorts
  if (!pair) return EMPTY_ANALYSIS

  const recent = pair.recentScale
  const matured = pair.maturedCut
  const coherent = recent.asOfDate === matured.asOfDate
    && matured.windowEnd < recent.windowStart
  if (!coherent) return EMPTY_ANALYSIS

  const recentUsable = windowUsable(recent)
  const maturedUsable = windowUsable(matured)
  if (!recentUsable && !maturedUsable) return EMPTY_ANALYSIS

const recentCpa = bookingDiagnosticUsable(recent) ? cpa(recent) : null
  const recentOutcomes = bookingDiagnosticUsable(recent) ? recent.bookings : null
  const recentProfitSpendMatches = input.profit?.recent === null || input.profit?.recent === undefined
    || (recent.spend !== null && Math.abs(input.profit.recent.observedTreatmentAdSpend - recent.spend) <= 0.02)
  const proposedTotalSpendMatches = input.profit?.proposedTotal === null || input.profit?.proposedTotal === undefined
    || (recent.spend !== null && Math.abs(input.profit.proposedTotal.observedTreatmentAdSpend - recent.spend) <= 0.02)
  const maturedProfitSpendMatches = input.profit?.matured === null || input.profit?.matured === undefined
    || (matured.spend !== null && Math.abs(input.profit.matured.observedTreatmentAdSpend - matured.spend) <= 0.02)
  const profitAligned = input.profit?.lineageMatchesEvaluationWindows === true
    && recentProfitSpendMatches
    && proposedTotalSpendMatches
    && maturedProfitSpendMatches
  const recentProfitComplete = profitAligned
    && validateContributionEvidence(input.profit?.recent) === null
  const proposedTotalComplete = profitAligned
    && validateContributionEvidence(input.profit?.proposedTotal) === null
  const maturedProfitComplete = profitAligned
    && validateContributionEvidence(input.profit?.matured) === null

  // Pragmatic media-buyer mode uses attributed-only association evidence, labeled honestly. The
  // estimand is 'attributed_association'; it is allowed here for completeness checks, but the
  // directional policy still refuses execution and routes it to owner_review only.
  const estimandSupportsScale = (w: ContributionWindowEvidence | null | undefined) =>
    !!w && (w.estimand === 'marginal_contribution_vs_current_state'
      || (w.incrementality === 'attributed_only' && w.estimand === 'attributed_association'))
  const estimandSupportsCut = (w: ContributionWindowEvidence | null | undefined) =>
    !!w && (w.estimand === 'total_contribution_vs_no_ads'
      || (w.incrementality === 'attributed_only' && w.estimand === 'attributed_association'))

  const scaleComplete = recentUsable && recentProfitComplete && proposedTotalComplete
    && estimandSupportsScale(input.profit?.recent)
    && input.profit?.proposedTotal !== null
    && estimandSupportsCut(input.profit?.proposedTotal)
  const recentCutComplete = recentUsable && recentProfitComplete
    && estimandSupportsCut(input.profit?.recent)
  const maturedDecisionComplete = maturedUsable && maturedProfitComplete
    && estimandSupportsCut(input.profit?.matured)
  const recentRecovery = recentCutComplete
    && input.profit!.recent!.contributionInterval.lower > 0
  const historicalLoss = maturedDecisionComplete
    && input.profit!.matured!.contributionInterval.upper < 0
  const windowsConflict = historicalLoss
    && (recentRecovery || input.structuralContinuity !== true)

  const evidence: DirectionalEvidence = {
    objective: input.objective,
    exactCpa: recentCpa,
    provenOutcomes: recentOutcomes,
    lagged: bookingDiagnosticUsable(matured)
      ? {
          spend: matured.spend!,
          outcomes: matured.bookings,
          cpa: cpa(matured),
          matured: true,
        }
      : null,
    // A complete recent unit is required for a cut. Its zero is not independently called a loss; it
    // only proves that no positive recovery contradicts the already-matured loss.
    postPeriodCorroboratesLoss: recentUsable && !recentRecovery,
    structuralContinuity: input.structuralContinuity,
    windowsConflict,
    targetCpa: input.targetCpa,
    maxCpa: input.maxCpa,
    targetPolicyStatus: input.targetPolicyStatus,
    profitPolicy: ownerProfitPolicyEvidence(
      {
        currentAccountDailyBudget: input.profit?.currentAccountDailyBudget ?? null,
        proposedAccountDailyBudget: input.profit?.proposedAccountDailyBudget ?? null,
      },
      input.profit?.recent?.incrementality === 'attributed_only'
        ? PRAGMATIC_DAILY_BUDGET_CEILING
        : null,
    ),
    recentContribution: profitAligned ? input.profit?.recent ?? null : null,
    proposedTotalContribution: profitAligned ? input.profit?.proposedTotal ?? null : null,
    laggedContribution: profitAligned ? input.profit?.matured ?? null : null,
  }
  return {
    evidence,
    scaleComplete,
    recentCutComplete,
    recentComplete: recentCutComplete || scaleComplete,
    maturedComplete: maturedDecisionComplete,
    recentCpa,
    maturedCpa: bookingDiagnosticUsable(matured) ? cpa(matured) : null,
    historicalLoss,
    recentRecovery,
    windowsConflict,
  }
}

export function buildPaidCohortDirectionalEvidence(
  input: PaidCohortDirectionInput,
): DirectionalEvidence | null {
  return analyzePaidCohortDirection(input).evidence
}

export interface PaidCohortActionEvidence {
  basis: AuthorityBasis
  plane: EvidencePlane
  evidence?: DirectionalEvidence
}

/**
 * The evidence a modelled fallback can honestly carry when the deterministic cohort carried nothing.
 *
 * Every field here comes from `input` — the objective, the owner's CPA policy, structural continuity.
 * The three cohort-derived diagnostics are NULL, because that is what they are: the cohort did not
 * establish them. Nothing is invented; the modelled numbers ride in `modelled` where the directional
 * policy can see them for what they are and cap them at owner_review.
 */
function inputOnlyEvidence(input: PaidCohortDirectionInput): DirectionalEvidence {
  return {
    objective: input.objective,
    exactCpa: null,
    provenOutcomes: null,
    lagged: null,
    postPeriodCorroboratesLoss: false,
    structuralContinuity: input.structuralContinuity,
    windowsConflict: false,
    targetCpa: input.targetCpa,
    maxCpa: input.maxCpa,
    targetPolicyStatus: input.targetPolicyStatus,
    profitPolicy: ownerProfitPolicyEvidence(
      {
        currentAccountDailyBudget: input.profit?.currentAccountDailyBudget ?? null,
        proposedAccountDailyBudget: input.profit?.proposedAccountDailyBudget ?? null,
      },
      PRAGMATIC_DAILY_BUDGET_CEILING,
    ),
    recentContribution: null,
    proposedTotalContribution: null,
    laggedContribution: null,
  }
}

export function resolvePaidCohortActionEvidence(
  input: PaidCohortDirectionInput & { kind: ActionKind; fallbackPlane: EvidencePlane },
): PaidCohortActionEvidence {
  if (!isMoneyKind(input.kind)) {
    return { basis: 'calendar_period_signal', plane: input.fallbackPlane, evidence: undefined }
  }
  const analysis = analyzePaidCohortDirection(input)
  const complete = input.kind === 'budget_scale' || input.kind === 'activate'
    ? analysis.scaleComplete
    : analysis.recentCutComplete && analysis.maturedComplete
  if (complete) {
    return {
      basis: 'interaction_cohort_complete',
      plane: 'interaction_cohort',
      evidence: analysis.evidence ?? undefined,
    }
  }
  // The deterministic cohort could not carry this action. Fall back to Meta's modelled numbers when
  // they are available, honestly labeled — the alternative is the silence that has produced zero
  // money recommendations in three months. The modelled evidence rides on the SAME DirectionalEvidence
  // object, so evaluateDirection's fallback guard (no contribution evidence present) still governs.
  //
  // This used to read `if (input.modelled && analysis.evidence)`, which locked the escape hatch behind
  // the door it was built to open: `analysis.evidence` is null exactly when BOTH cohort windows are
  // unusable, which is the only situation in which a fallback is wanted. Since 2026-05 the account has
  // had at least one incomplete window continuously, so this branch never once fired and the comment
  // above described an intention the code could not carry out.
  //
  // The modelled plane remains capped at owner_review by construction in directional-policy, carries a
  // mandatory disclosure, and still requires two agreeing non-overlapping windows with real spend — so
  // reaching it earlier widens nothing about what may be executed.
  if (input.modelled) {
    return {
      basis: 'meta_modelled_association',
      plane: 'meta_modelled',
      evidence: { ...(analysis.evidence ?? inputOnlyEvidence(input)), modelled: input.modelled },
    }
  }
  return {
    basis: 'calendar_period_signal',
    plane: input.fallbackPlane,
    evidence: analysis.evidence ?? undefined,
  }
}
