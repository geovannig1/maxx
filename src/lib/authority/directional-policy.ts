import type { MetaDeliveryObjective } from '@/lib/modes/objective'
import { isIsoCurrency } from '@/config/business-config'
import type { TargetPolicyStatus } from '@/lib/targets/store'
import {
  MAXX_CONTRIBUTION_DEFINITION_VERSION,
  MAXX_OWNER_PROFIT_POLICY,
  type ContributionWindowEvidence,
  type ProfitPolicyEvidence,
} from '@/lib/economics/profit-policy'
import { PRAGMATIC_DAILY_BUDGET_CEILING } from '@/lib/economics/pragmatic-profit-evidence'
import type { ActionKind } from './action-authority'
import { formatMoney, formatMoneyAmount } from '@/lib/utils/format-currency'

export interface DirectionalEvaluationOptions {
  /** When true, attributed-only association evidence (honestly labeled) may reach owner_review for
   *  money recommendations. Execution still requires causal evidence. */
  pragmaticMediaBuyerEnabled?: boolean
}

/**
 * META-MODELLED PERFORMANCE — deliberately NOT a ContributionWindowEvidence.
 *
 * Routing modelled numbers through the contribution contract would mean declaring
 * `collectionLineage: 'processor_settled'` for money nobody settled. The contract's whole promise is
 * that a labeled estimate can never masquerade as measured money, so modelled evidence gets a
 * parallel type instead and the causal contract stays untouched and exactly as strict.
 *
 * `spend` is deterministic (daily_insights). `modelledBookings` is Meta's own estimate of its own
 * performance. The two are never blended into a single "contribution" number.
 */
export interface ModelledPerformanceWindow {
  windowStart: string
  windowEnd: string
  /** Existing source plane for this estimate. */
  source: 'daily_insights'
  /** Number of distinct daily insight rows observed in the window. */
  observedDays: number
  /** Number of complete daily insight rows required for this window. */
  expectedDays: number
  /** Latest sync timestamp among the rows that built this window. */
  earliestSyncedAt: string | null
  latestSyncedAt: string | null
  /** Deterministic — Meta bills it. */
  spend: number
  /** MODELLED. Meta's estimate, including view-through and modelled conversions. */
  modelledBookings: number
  /** Derived from the two above; null when bookings are zero. */
  modelledCpa: number | null
  /**
   * PEAK DAILY frequency -- `Math.max(...daily frequencies)`, not the window's own frequency.
   *
   * The distinction is load-bearing. Daily reach is deduplicated WITHIN a day only, while window
   * reach is deduplicated across the whole window. Neither reading bounds the other: repeat reach can
   * make window frequency exceed every daily reading, while disjoint daily audiences can make a
   * high-frequency day exceed the whole-window reading. This value is diagnostic only here.
   */
  peakDailyFrequency: number | null
  /**
   * The WINDOW's own frequency, which is the quantity a fatigue band is calibrated against.
   *
   * Always `null` today, deliberately. It cannot be derived from `daily_insights`: window reach is
   * deduplicated across days, so summing daily reach overcounts and taking the max undercounts, and
   * the true window value can sit far from either bound -- neither is usable. Only
   * Meta's window-level reach answers it (`fetchNativePeriodDelivery` already reads exactly that for
   * the cockpit), so wiring that reader into generation is what fills this in.
   */
  windowFrequency: number | null
}

export interface ModelledSourceGeneration {
  id: string
  status: string
  dateRangeStart: string | null
  dateRangeEnd: string | null
  startedAt: string | null
  completedAt: string | null
}

export interface ModelledDirectionalEvidence {
  recent: ModelledPerformanceWindow | null
  /** Non-overlapping prior window. A single window is never enough for a money direction. */
  prior: ModelledPerformanceWindow | null
  /** Exact sync generation that produced the mutable daily source. Missing/partial/stale fails closed. */
  sourceGeneration: ModelledSourceGeneration | null
  /** The owner's CPA target and watch CPA; null until set. A modelled direction needs them. */
  targetCpa: number | null
  watchCpa: number | null
  /**
   * Linked bookings ÷ fbclid-carrying bookings for the evaluated window. The deterministic cohort
   * reports ~0 attributed bookings while linkage is this low, so a cohort zero is UNDER-MEASUREMENT,
   * not evidence of failure. Below MIN_LINKAGE_COVERAGE_FOR_CUT the cut copy must say so.
   */
  linkageCoverage: number | null
  /** Account-level outcome-source revenue ÷ total spend. Deterministic CONTEXT only, never per-ad authority. */
  blendedRoas: number | null
}

/** Below this, a cohort zero cannot be read as a loss — it is under-measurement. */
export const MIN_LINKAGE_COVERAGE_FOR_CUT = 0.60
/** A window must have spent at least this multiple of the relevant CPA to say anything. */
const MIN_SPEND_MULTIPLE = 3
/** Creative fatigue band opens here; a scale into fatigue is not supported. */
const FREQUENCY_FATIGUE_FLOOR = 3.0
const MODELLED_COMPARISON_DAYS = 14

const usd = (n: number) => `${formatMoney(n)}`
const NO_CPA_TARGET = 'A Meta-modelled direction is judged against the owner\'s CPA target, and none is set. Set one in Settings → Performance Targets.'

function inclusiveWindowDays(start: string, end: string): number {
  const span = Date.parse(`${end}T00:00:00.000Z`) - Date.parse(`${start}T00:00:00.000Z`)
  return Number.isFinite(span) ? Math.floor(span / 86_400_000) + 1 : 0
}

function windowUsable(w: ModelledPerformanceWindow | null): w is ModelledPerformanceWindow {
  return !!w && Number.isFinite(w.spend) && w.spend > 0 && Number.isInteger(w.modelledBookings)
    && w.modelledBookings >= 0
    && w.source === 'daily_insights'
    && w.expectedDays === MODELLED_COMPARISON_DAYS
    && w.observedDays === w.expectedDays
    && inclusiveWindowDays(w.windowStart, w.windowEnd) === MODELLED_COMPARISON_DAYS
    && typeof w.earliestSyncedAt === 'string'
    && typeof w.latestSyncedAt === 'string'
    && w.latestSyncedAt.slice(0, 10) >= w.windowEnd
}

function modelledWindowFailure(w: ModelledPerformanceWindow | null, label: string): string | null {
  if (!w) return `${label} window is missing.`
  if (!Number.isFinite(w.spend) || w.spend <= 0) return `${label} window has no real spend.`
  if (!Number.isInteger(w.modelledBookings) || w.modelledBookings < 0) {
    return `${label} window has invalid Meta-modelled bookings.`
  }
  if (w.source !== 'daily_insights') return `${label} window does not identify daily_insights as its source.`
  if (w.expectedDays !== MODELLED_COMPARISON_DAYS
      || w.observedDays !== w.expectedDays
      || inclusiveWindowDays(w.windowStart, w.windowEnd) !== MODELLED_COMPARISON_DAYS) {
    return `${label} window is not a complete ${MODELLED_COMPARISON_DAYS}-day daily_insights window.`
  }
  if (typeof w.latestSyncedAt !== 'string' || w.latestSyncedAt.slice(0, 10) < w.windowEnd) {
    return `${label} window is not fresh: daily_insights was not synced through ${w.windowEnd}.`
  }
  return null
}

function modelledGenerationFailure(ev: ModelledDirectionalEvidence): string | null {
  const generation = ev.sourceGeneration
  if (!generation?.id?.trim()) return 'The daily_insights source generation is missing.'
  if (generation.status !== 'success') {
    return `The daily_insights source generation is not complete (status ${generation.status || 'unknown'}).`
  }
  if (!ev.prior || !ev.recent) return null
  if (
    !generation.dateRangeStart || generation.dateRangeStart > ev.prior.windowStart
    || !generation.dateRangeEnd || generation.dateRangeEnd < ev.recent.windowEnd
  ) {
    return 'The daily_insights source generation does not cover every required day in both windows.'
  }
  if (
    !generation.startedAt
    || !Number.isFinite(Date.parse(generation.startedAt))
    || !ev.prior.earliestSyncedAt || !ev.recent.earliestSyncedAt
    || Date.parse(ev.prior.earliestSyncedAt) < Date.parse(generation.startedAt)
    || Date.parse(ev.recent.earliestSyncedAt) < Date.parse(generation.startedAt)
  ) {
    return 'The daily_insights rows cannot all be linked to the declared source generation.'
  }
  if (
    !generation.completedAt
    || !Number.isFinite(Date.parse(generation.completedAt))
    || generation.completedAt.slice(0, 10) < ev.recent.windowEnd
  ) {
    return 'The daily_insights source generation is stale for the recent window.'
  }
  return null
}

/**
 * Every Meta-modelled money direction carries this, and the cancellation clause is not boilerplate.
 *
 * The reference scheduling adapter's webhook gates CAPI on `isInitialScheduled && !canceled` -- deliberately, because Meta
 * cannot retract a conversion once sent. The consequence is that Meta is NEVER told a booking
 * cancelled, so the booking count this CPA divides by is gross of every cancellation, and the CPA is
 * therefore optimistic by construction.
 *
 * That need not be a rounding difference. For example, if a modest share of all appointments cancel
 * but a much larger share of the paid-linked ones do, netting a $40 modelled CPA at those rates can
 * give anywhere from $50 to $80 -- across a $45 target and, at the upper end, across a $70 watch line,
 * which is the difference between "scale this" and "cut this".
 *
 * No rate is applied here, and that is deliberate: the policy has no per-entity cancellation evidence,
 * and picking one of three account-level rates to divide a per-ad-set number by would be inventing
 * precision. So the direction of the bias is STATED instead, and the owner is pointed at the surface
 * that does carry settled, cancellation-adjusted counts (`attribution-ladder.ts`, `cancelledPaidLinked`).
 */
const ESTIMATE_DISCLOSURE =
  'These are Meta-modelled results, not settled payments — Meta counts view-through and modelled '
  + 'conversions its own way, and it is never told when a booking cancels, so this cost per booking '
  + 'is GROSS of cancellations and reads better than the settled figure; the attribution ladder '
  + 'carries the cancellation-adjusted counts. Owner review only; this can never become an '
  + 'automatic execution.'

/**
 * Money direction from Meta-modelled performance. Conservative and ASYMMETRIC by construction:
 * every path tops out at `owner_review`, and both a recent AND a non-overlapping prior window must
 * agree before anything is proposed.
 */
export function evaluateModelledDirection(
  kind: ActionKind,
  ev: ModelledDirectionalEvidence,
): DirectionalVerdict {
  const { recent, prior } = ev
  const recentFailure = modelledWindowFailure(recent, 'Recent')
  const priorFailure = modelledWindowFailure(prior, 'Prior')
  const generationFailure = modelledGenerationFailure(ev)
  if (recentFailure || priorFailure || generationFailure || !windowUsable(recent) || !windowUsable(prior)) {
    return { ceiling: 'unsupported', reason: `Meta-modelled evidence needs a recent AND a non-overlapping prior window with real spend, complete source coverage, freshness, and one successful covering source generation. ${recentFailure ?? priorFailure ?? generationFailure}` }
  }
  if (
    Date.parse(`${recent.windowStart}T00:00:00.000Z`)
      - Date.parse(`${prior.windowEnd}T00:00:00.000Z`) !== 86_400_000
  ) {
    return {
      ceiling: 'unsupported',
      reason: 'Meta-modelled evidence requires two adjacent, non-overlapping 14-day comparison windows.',
    }
  }
  const blended = ev.blendedRoas != null ? ` Account blended ROAS is ${ev.blendedRoas.toFixed(2)}x (deterministic context, not per-ad attribution).` : ''

  if (kind === 'budget_scale' || kind === 'activate') {
    if (ev.targetCpa === null) return { ceiling: 'unsupported', reason: NO_CPA_TARGET }
    const floor = MIN_SPEND_MULTIPLE * ev.targetCpa
    if (recent.spend < floor || prior.spend < floor) {
      return { ceiling: 'unsupported', reason: `Each window must have spent at least ${usd(floor)} (3x the ${usd(ev.targetCpa)} target CPA) before a modelled increase is proposed; observed ${usd(recent.spend)} and ${usd(prior.spend)}.` }
    }
    if (recent.modelledCpa == null || prior.modelledCpa == null) {
      return { ceiling: 'unsupported', reason: 'A modelled increase requires a modelled CPA in both windows; a window with zero modelled bookings cannot support more spend.' }
    }
    if (recent.modelledCpa > ev.targetCpa || prior.modelledCpa > ev.targetCpa) {
      return { ceiling: 'unsupported', reason: `Modelled CPA must be at or under the ${usd(ev.targetCpa)} owner target in BOTH windows; observed ${usd(recent.modelledCpa)} recent and ${usd(prior.modelledCpa)} prior.` }
    }
    // FATIGUE -- and the unit it is measured in, which is where this went wrong twice.
    //
    // `FREQUENCY_FATIGUE_FLOOR` is 3.0, a WINDOW-level review band by every media-buying
    // convention. It was being compared against PEAK DAILY frequency. For example, a retargeting ad
    // set can show 2.1 at peak daily and pass a budget increase, while Meta's window frequency for the
    // same ad set over the same 14 days is 4.3 -- already above the band the guard exists to enforce.
    //
    // Neither reading bounds the other. For example, disjoint days with frequencies 3/1 and 100/100
    // produce a 103/101 whole-window frequency, below the 3.0 peak. A daily-spike rule therefore
    // needs its own calibrated band; it cannot borrow this window band. A scale needs positive
    // evidence that window fatigue is absent, and only the window reading carries it.
    if (recent.windowFrequency == null) {
      const peak = recent.peakDailyFrequency == null ? 'none' : recent.peakDailyFrequency.toFixed(1)
      return { ceiling: 'unsupported', reason: `A modelled increase requires the WINDOW's frequency, and only a peak DAILY reading (${peak}) is available. Daily and window frequency do not bound one another, so the daily reading cannot show that the whole-window audience is unsaturated. Meta's window-level reach is what answers this.` }
    }
    if (recent.windowFrequency >= FREQUENCY_FATIGUE_FLOOR) {
      return { ceiling: 'unsupported', reason: `Window frequency is ${recent.windowFrequency.toFixed(1)}, at or above the ${FREQUENCY_FATIGUE_FLOOR} review band. This is the creative-fatigue band: more budget buys repeat impressions to people already reached.` }
    }
    return {
      ceiling: 'owner_review',
      reason: `Meta-modelled CPA is at or under the ${usd(ev.targetCpa)} target in both windows (${usd(recent.modelledCpa)} recent, ${usd(prior.modelledCpa)} prior) on ${usd(recent.spend)} and ${usd(prior.spend)} of spend.${blended} ${ESTIMATE_DISCLOSURE}`,
    }
  }

  // budget_cut / pause
  const watchCpa = ev.watchCpa
  if (watchCpa === null) return { ceiling: 'unsupported', reason: NO_CPA_TARGET }
  const zeroFloor = MIN_SPEND_MULTIPLE * watchCpa
  const overWatch = (w: ModelledPerformanceWindow) => w.modelledCpa != null && w.modelledCpa >= watchCpa
  const zeroOutcome = (w: ModelledPerformanceWindow) => w.modelledBookings === 0 && w.spend >= zeroFloor
  const recentBad = overWatch(recent) || zeroOutcome(recent)
  const priorBad = overWatch(prior) || zeroOutcome(prior)
  if (!recentBad || !priorBad) {
    return { ceiling: 'unsupported', reason: `A modelled cut or pause requires BOTH windows at or above the ${usd(watchCpa)} watch CPA, or zero modelled bookings on at least ${usd(zeroFloor)} of spend. Only one window qualifies, so the windows disagree.` }
  }
  const coverage = ev.linkageCoverage
  const underMeasured = coverage != null && coverage < MIN_LINKAGE_COVERAGE_FOR_CUT
  const caveat = underMeasured
    ? ` NOTE: deterministic paid-touch linkage covers only ${(coverage * 100).toFixed(0)}% of fbclid-carrying bookings (below the ${(MIN_LINKAGE_COVERAGE_FOR_CUT * 100).toFixed(0)}% bar), so the exact-join cohort's near-zero booking count is UNDER-MEASUREMENT and is not being read as a loss. This verdict rests on Meta's modelled numbers alone.`
    : ''
  const describe = (w: ModelledPerformanceWindow) => w.modelledBookings === 0
    ? `zero modelled bookings on ${usd(w.spend)}`
    : `${usd(w.modelledCpa!)} modelled CPA`
  return {
    ceiling: 'owner_review',
    reason: `Meta-modelled CPA is at or above the ${usd(watchCpa)} watch threshold in both windows (${describe(recent)} recent, ${describe(prior)} prior).${blended}${caveat} ${ESTIMATE_DISCLOSURE}`,
  }
}

/**
 * DIRECTIONAL POLICY — does the evidence support the direction being proposed?
 *
 * The authority layer validated the evidence LABEL (which plane,
 * which basis) and treated a complete interaction cohort as sufficient. It never asked whether the
 * evidence pointed the way the action pointed. Reproduced at 4749ecb: a `budget_scale` candidate whose
 * own observation was "CPA is $412 against a $100 maximum and the unit is losing money" returned
 * `execution_eligible`, and the same losing state authorised scale, cut AND pause simultaneously. The
 * matrix test asserted exactly that, so it enshrined the defect.
 *
 * Completeness is NECESSARY, never SUFFICIENT. This module owns the sufficiency half.
 */

export type { ContributionWindowEvidence, ProfitPolicyEvidence } from '@/lib/economics/profit-policy'

/** Trusted, server-resolved facts. Nothing here may come from a caller or a model. */
export interface DirectionalEvidence {
  /** @deprecated Delivery-objective context only. It cannot decide commercial direction. */
  objective: MetaDeliveryObjective
  /** @deprecated Diagnostic only. CPA is not the owner's objective. */
  exactCpa: number | null
  /** @deprecated Diagnostic only. Booking volume is not collected contribution. */
  provenOutcomes: number | null
  /** @deprecated Booking-CPA diagnostic retained during the storage cutover. */
  lagged: { spend: number; outcomes: number | null; cpa: number | null; matured: boolean } | null
  /** @deprecated Contribution windows are checked directly. */
  postPeriodCorroboratesLoss: boolean
  /** Whether the setup responsible for the evaluated spend is unchanged. null = unknown. */
  structuralContinuity: boolean | null
  /** Recent and historical windows disagree. */
  windowsConflict: boolean
  /** @deprecated Diagnostic display target only; never used for money authority. null until set. */
  targetCpa: number | null
  maxCpa: number | null
  /** @deprecated CPA target governance no longer controls commercial direction. */
  targetPolicyStatus: TargetPolicyStatus
  /** Owner-approved commercial objective and account-level spend ceiling. Missing fails closed. */
  profitPolicy?: ProfitPolicyEvidence | null
  /** Recent, interaction-aligned collected contribution used for increase/activation review. */
  recentContribution?: ContributionWindowEvidence | null
  /** Total contribution of the proposed treatment versus no ads. Required in addition to marginal
   * evidence so a locally improving change cannot be preferred while it still loses money overall. */
  proposedTotalContribution?: ContributionWindowEvidence | null
  /** Matured, non-overlapping collected contribution used for cut/pause review. */
  laggedContribution?: ContributionWindowEvidence | null
  /** Meta-modelled fallback. Consulted ONLY when no contribution evidence exists at all, so a
   *  causal or attributed result can never be displaced by an estimate. */
  modelled?: ModelledDirectionalEvidence | null
}

/**
 * How far the EVIDENCE may carry an action — a ceiling, not a yes/no.
 *
 * `supports: boolean` collapsed two different answers into one. A 2x
 * zero-outcome window says "an owner should look at this", not "a machine may execute this", but a
 * boolean made both `true` and therefore both `execution_eligible`. The threshold tiers only mean
 * something if the type can express them.
 */
export type AuthorityCeiling =
  /** The evidence contradicts, or cannot establish, the proposed direction. */
  | 'unsupported'
  /** Real evidence, but not strong enough to execute on. Owner decides. */
  | 'owner_review'
  /** Strong enough to be execution-eligible (still subject to plane, basis, approval, write mode). */
  | 'execution'

export interface DirectionalVerdict {
  /** The HIGHEST tier this evidence can justify. The authority layer may lower it, never raise it. */
  ceiling: AuthorityCeiling
  /** Always stated, so a refusal or a downgrade is never silent. */
  reason: string
}

/** Convenience for callers that only care whether anything at all is supported. */
export const isSupported = (v: DirectionalVerdict) => v.ceiling !== 'unsupported'

const MONEY_TOLERANCE = 0.01

function finiteNonNegative(value: number): boolean {
  return Number.isFinite(value) && value >= 0
}

function validateProfitPolicy(
  policy: ProfitPolicyEvidence | null | undefined,
  opts: DirectionalEvaluationOptions = {},
): string | null {
  if (!policy || policy.status !== 'governed') {
    return 'No durably governed owner profit policy is available, so no money direction can be evaluated.'
  }
  if (policy.version !== MAXX_OWNER_PROFIT_POLICY.version) {
    return 'The evidence does not reference the exact owner-approved profit policy version, so the money direction fails closed.'
  }
  if (policy.objective !== MAXX_OWNER_PROFIT_POLICY.objective) {
    return 'The governed commercial objective is not incremental contribution from ad-attributed collected revenue, so the owner profit policy fails closed.'
  }
  const allowedCeiling = opts.pragmaticMediaBuyerEnabled
    ? PRAGMATIC_DAILY_BUDGET_CEILING
    : MAXX_OWNER_PROFIT_POLICY.dailyBudgetCeiling
  if (!finiteNonNegative(policy.dailyBudgetCeiling ?? Number.NaN)
      || policy.dailyBudgetCeiling !== allowedCeiling) {
    return `The owner-approved ${formatMoneyAmount(allowedCeiling)} account daily-budget hard ceiling is missing or inconsistent.`
  }
  return null
}

export function validateContributionEvidence(window: ContributionWindowEvidence | null | undefined): string | null {
  if (!window || window.status !== 'complete') return 'Collected-contribution evidence is incomplete.'
  if (!isIsoCurrency(window.currency)
      || window.metricDefinitionVersion !== MAXX_CONTRIBUTION_DEFINITION_VERSION
      || !Number.isInteger(window.realizationHorizonDays)
      || window.realizationHorizonDays <= 0
      || !window.costPolicyVersion?.trim()
      || !window.causalDecisionPackageId?.trim()
      || !window.measurementDesignId?.trim()) {
    return 'Collected-contribution evidence lacks a governed currency, metric definition, realization horizon, cost-policy version, causal decision-package identity, or measurement-design identity.'
  }
  if (window.collectionLineage !== 'processor_settled' || window.costLineage !== 'governed_cost_policy') {
    return 'Collected-contribution evidence is incomplete: settled-payment, refund, or governed variable-cost lineage is unavailable.'
  }
  const lineageMatchesDesign =
    (window.incrementality === 'controlled_experiment' && window.measurementLineage === 'randomized_treatment_assignment')
    || (window.incrementality === 'quasi_experimental' && window.measurementLineage === 'quasi_experimental_comparison')
    || (window.incrementality === 'attributed_only' && window.measurementLineage === 'exact_paid_touch')
  if (!lineageMatchesDesign) {
    return 'The measurement lineage does not support the declared incrementality design. Randomized assignment, a governed quasi-experimental comparison, and exact paid-touch association are different evidence classes.'
  }
  if ((window.incrementality === 'attributed_only') !== (window.estimand === 'attributed_association')) {
    return 'The declared contribution estimand does not match its evidence class; paid-touch association cannot be labeled causal, and causal evidence cannot be labeled attributed association.'
  }
  const components = [
    window.collectedRevenue,
    window.refundsAndChargebacks,
    window.paymentProcessingFees,
    window.variableFulfillmentCosts,
    window.adSpend,
  ]
  const componentsValid = window.incrementality === 'attributed_only'
    ? components.every(finiteNonNegative)
    : components.every(Number.isFinite)
  if (!componentsValid
      || !finiteNonNegative(window.observedTreatmentAdSpend)
      || !Number.isFinite(window.contributionAfterAds)
      || !Number.isInteger(window.observedSettledPayments)
      || window.observedSettledPayments < 0) {
    return 'Collected-contribution evidence contains invalid numeric values.'
  }
  if (window.estimand !== 'marginal_contribution_vs_current_state'
      && Math.abs(window.adSpend - window.observedTreatmentAdSpend) > MONEY_TOLERANCE) {
    return 'Unit-total or attributed contribution must reconcile its spend component to observed treatment spend.'
  }
  const expected = window.collectedRevenue
    - window.refundsAndChargebacks
    - window.paymentProcessingFees
    - window.variableFulfillmentCosts
    - window.adSpend
  if (Math.abs(expected - window.contributionAfterAds) > MONEY_TOLERANCE) {
    return 'Collected-contribution evidence does not reconcile to its atomic money components.'
  }
  const { lower, upper, confidence } = window.contributionInterval
  if (!Number.isFinite(lower) || !Number.isFinite(upper) || lower > upper
      || !Number.isFinite(confidence) || confidence <= 0 || confidence >= 1
      || window.contributionAfterAds < lower - MONEY_TOLERANCE
      || window.contributionAfterAds > upper + MONEY_TOLERANCE) {
    return 'The contribution uncertainty interval is invalid or does not contain the point estimate.'
  }
  if (!window.matured) return 'Collected-contribution evidence has not matured through the declared payment, cancellation, and refund lag.'
  return null
}

function sameContributionDefinition(a: ContributionWindowEvidence, b: ContributionWindowEvidence): boolean {
  return a.currency === b.currency
    && a.metricDefinitionVersion === b.metricDefinitionVersion
    && a.realizationHorizonDays === b.realizationHorizonDays
    && a.costPolicyVersion === b.costPolicyVersion
    && a.causalDecisionPackageId === b.causalDecisionPackageId
    && a.incrementality === b.incrementality
    && a.measurementLineage === b.measurementLineage
}

function validateIncreaseBudget(policy: ProfitPolicyEvidence): string | null {
  const current = policy.currentAccountDailyBudget
  const proposed = policy.proposedAccountDailyBudget
  if (!finiteNonNegative(current ?? Number.NaN) || !finiteNonNegative(proposed ?? Number.NaN)) {
    return 'The current and proposed account-total daily budgets are not both proven, so an increase cannot be evaluated.'
  }
  if (proposed! <= current!) return 'The proposed account-total daily budget is not an increase.'
  if (proposed! > policy.dailyBudgetCeiling!) {
    return `The proposed ${formatMoney(proposed!)} account daily budget exceeds the owner-approved ${policy.dailyBudgetCeiling === null ? 'unavailable' : formatMoneyAmount(policy.dailyBudgetCeiling)} hard ceiling. Profit proof can start a new owner discussion; it cannot raise the ceiling.`
  }
  return null
}

function validateModelledBudgetIntent(kind: ActionKind, policy: ProfitPolicyEvidence): string | null {
  const current = policy.currentAccountDailyBudget
  const proposed = policy.proposedAccountDailyBudget
  if (!finiteNonNegative(current ?? Number.NaN) || !finiteNonNegative(proposed ?? Number.NaN)) {
    return 'The current and proposed account-total daily budgets are not both proven, so a Meta-modelled money recommendation cannot be evaluated.'
  }
  if (proposed! > policy.dailyBudgetCeiling!) {
    return `The proposed ${formatMoney(proposed!)} account daily budget exceeds the owner-approved ${policy.dailyBudgetCeiling === null ? 'unavailable' : formatMoneyAmount(policy.dailyBudgetCeiling)} hard ceiling.`
  }
  if (kind === 'budget_scale' || kind === 'activate') {
    if (proposed! <= current!) return 'The proposed account-total daily budget is not an increase.'
  } else if (proposed! >= current!) {
    return 'The proposed account-total daily budget is not a reduction, so a cut or pause has no concrete sized money move.'
  }
  return null
}

/**
 * Does the trusted evidence support this direction?
 *
 * MUTUAL EXCLUSION is structural: a scale needs a positive contribution lower bound, while a cut
 * needs a negative contribution upper bound. A point estimate or booking CPA cannot satisfy either.
 */
export function evaluateDirection(
  kind: ActionKind,
  ev: DirectionalEvidence,
  opts: DirectionalEvaluationOptions = {},
): DirectionalVerdict {
  // Non-money kinds carry no directional economics — the authority layer gates them on plane alone.
  if (kind === 'creative_refresh' || kind === 'structural' || kind === 'observe') {
    return { ceiling: 'execution', reason: 'Non-money action: no directional economics required.' }
  }

  // MODELLED FALLBACK. Strictly a fallback: it fires only when NO contribution evidence of any
  // kind was supplied, so causal and attributed results always take precedence and can never be
  // displaced by an estimate. Its every path tops out at owner_review.
  if (ev.modelled && !ev.recentContribution && !ev.laggedContribution && !ev.proposedTotalContribution) {
    const policyFailure = validateProfitPolicy(ev.profitPolicy, opts)
    if (policyFailure) return { ceiling: 'unsupported', reason: policyFailure }
    if (ev.structuralContinuity !== true) {
      // Distinguish the two, exactly as the contribution path does below. They are different facts and
      // they need different owner responses: `false` means the setup DID change inside the windows
      // being compared and the comparison is invalid until it settles; `null` means we could not
      // establish it either way. Collapsing both into "not explicitly proven" made a real, actionable
      // finding ("5 ads were edited in the last 28 days") read as a bookkeeping shrug.
      return {
        ceiling: 'unsupported',
        reason: ev.structuralContinuity === false
          ? 'A material setup change falls inside the two windows being compared, so they describe different configurations. The modelled comparison becomes valid once the setup has been stable for a full window.'
          : 'Setup continuity could not be established either way, so Meta-modelled evidence remains diagnostic-only.',
      }
    }
    const budgetFailure = validateModelledBudgetIntent(kind, ev.profitPolicy!)
    if (budgetFailure) return { ceiling: 'unsupported', reason: budgetFailure }
    return evaluateModelledDirection(kind, ev.modelled)
  }

  const policyFailure = validateProfitPolicy(ev.profitPolicy, opts)
  if (policyFailure) return { ceiling: 'unsupported', reason: policyFailure }
  const policy = ev.profitPolicy!

  if (ev.windowsConflict) {
    return { ceiling: 'unsupported' as const, reason: 'The recent and historical windows disagree, so NEITHER direction is supported. A disagreement is its own answer, not a licence to move in whichever direction is read first.' }
  }

  if (kind === 'budget_scale' || kind === 'activate') {
    if (ev.structuralContinuity !== true) {
      return {
        ceiling: 'unsupported',
        reason: 'Setup continuity from the causal measurement through the proposed change is not proven, so the contribution result cannot be transported to an increase or activation.',
      }
    }
    const budgetFailure = validateIncreaseBudget(policy)
    if (budgetFailure) return { ceiling: 'unsupported', reason: budgetFailure }
    const contributionFailure = validateContributionEvidence(ev.recentContribution)
    if (contributionFailure) return { ceiling: 'unsupported', reason: contributionFailure }
    const recent = ev.recentContribution!
    if (recent.incrementality === 'attributed_only') {
      if (!opts.pragmaticMediaBuyerEnabled) {
        return { ceiling: 'unsupported', reason: 'Paid-touch collected revenue is attributed association, not incremental proof, so it cannot support a spend increase or activation recommendation.' }
      }
      if (recent.contributionAfterAds <= 0) {
        return {
          ceiling: 'unsupported',
          reason: `Attributed paid-touch contribution after ads is negative (${formatMoney(recent.contributionAfterAds)}); this does not support a scale recommendation even under pragmatic review.`,
        }
      }
      return {
        ceiling: 'owner_review',
        reason: `Pragmatic media-buyer mode: attributed paid-touch contribution is positive (${formatMoney(recent.contributionAfterAds)}) and the proposed account total stays within the ${policy.dailyBudgetCeiling === null ? 'unavailable' : formatMoneyAmount(policy.dailyBudgetCeiling)} ceiling. This is association evidence, not incremental proof — owner review only.`,
      }
    }
    if (recent.estimand !== 'marginal_contribution_vs_current_state') {
      return { ceiling: 'unsupported', reason: 'Positive total contribution from the existing ads does not prove the proposed change is profitable. A spend increase or activation requires a marginal causal-contribution comparison against the current state.' }
    }
    if (recent.adSpend <= 0) {
      return { ceiling: 'unsupported', reason: 'A proposed spend increase or activation must carry a positive incremental ad-spend component versus the current state.' }
    }
    const proposedFailure = validateContributionEvidence(ev.proposedTotalContribution)
    if (proposedFailure) return { ceiling: 'unsupported', reason: `Proposed post-change total contribution is unusable: ${proposedFailure}` }
    const proposed = ev.proposedTotalContribution!
    if (proposed.incrementality === 'attributed_only' || proposed.estimand !== 'total_contribution_vs_no_ads') {
      return { ceiling: 'unsupported', reason: 'A spend increase requires the proposed treatment’s causal total contribution versus no ads, not attributed revenue or another marginal proxy.' }
    }
    if (!sameContributionDefinition(recent, proposed)) {
      return { ceiling: 'unsupported', reason: 'Marginal and proposed-total contribution do not share one currency, metric definition, realization horizon, cost policy, and governed causal decision package.' }
    }
    if (recent.contributionAfterAds <= 0) {
      return {
        ceiling: 'unsupported',
        reason: `Recent collected contribution after ads is negative (${formatMoney(recent.contributionAfterAds)}). A cheap CPA or positive gross revenue does not prove profit and cannot support more spend.`,
      }
    }
    if (recent.contributionInterval.lower <= 0) {
      return {
        ceiling: 'owner_review',
        reason: `Recent collected contribution is positive at the point estimate, but its ${(recent.contributionInterval.confidence * 100).toFixed(0)}% interval crosses zero (${formatMoney(recent.contributionInterval.lower)} to ${formatMoney(recent.contributionInterval.upper)}). This is not execution-grade evidence for more spend.`,
      }
    }
    if (proposed.contributionAfterAds <= 0) {
      return { ceiling: 'unsupported', reason: `The proposed treatment’s total causal contribution after ads is negative (${formatMoney(proposed.contributionAfterAds)}). A locally improving change is not the profit-maximizing choice while no ads would contribute zero.` }
    }
    if (proposed.contributionInterval.lower <= 0) {
      return { ceiling: 'owner_review', reason: `Marginal contribution clears zero, but the proposed treatment’s total contribution interval crosses zero (${formatMoney(proposed.contributionInterval.lower)} to ${formatMoney(proposed.contributionInterval.upper)}). The change is not execution-grade.` }
    }
    const weakestConfidence = Math.min(
      recent.contributionInterval.confidence,
      proposed.contributionInterval.confidence,
    )
    if (weakestConfidence < MAXX_OWNER_PROFIT_POLICY.minimumExecutionConfidence) {
      return {
        ceiling: 'owner_review',
        reason: `Both intervals clear zero, but the weakest confidence level is ${(weakestConfidence * 100).toFixed(0)}%, below the owner policy's ${(MAXX_OWNER_PROFIT_POLICY.minimumExecutionConfidence * 100).toFixed(0)}% execution minimum.`,
      }
    }
    if (recent.incrementality === 'unavailable') {
      return { ceiling: 'unsupported', reason: 'Incrementality evidence is unavailable, so attributed revenue cannot justify more spend.' }
    }
    return {
      ceiling: 'execution',
      reason: `The ${(recent.contributionInterval.confidence * 100).toFixed(0)}% marginal-contribution interval remains above zero (${formatMoney(recent.contributionInterval.lower)} to ${formatMoney(recent.contributionInterval.upper)}) under ${recent.incrementality.replaceAll('_', ' ')} evidence, the proposed treatment’s total-contribution interval also remains above zero, and the account total stays within the ${policy.dailyBudgetCeiling === null ? 'unavailable' : formatMoneyAmount(policy.dailyBudgetCeiling)} ceiling.`,
    }
  }

  // budget_cut and pause both withdraw spend and share the collected-loss contract.
  const laggedFailure = validateContributionEvidence(ev.laggedContribution)
  if (laggedFailure) return { ceiling: 'unsupported', reason: laggedFailure }
  const recentFailure = validateContributionEvidence(ev.recentContribution)
  if (recentFailure) return { ceiling: 'unsupported', reason: `The non-overlapping corroboration window is unusable: ${recentFailure}` }
  const lagged = ev.laggedContribution!
  const recent = ev.recentContribution!
  if (lagged.incrementality === 'attributed_only' || recent.incrementality === 'attributed_only') {
    if (!opts.pragmaticMediaBuyerEnabled) {
      return { ceiling: 'unsupported', reason: 'Paid-touch association cannot establish a causal contribution loss and therefore cannot authorize a budget cut or pause.' }
    }
    if (lagged.contributionAfterAds >= 0 || recent.contributionAfterAds >= 0) {
      return { ceiling: 'unsupported', reason: 'Pragmatic media-buyer mode: at least one attributed contribution window is not negative, so a cut/pause is not supported.' }
    }
    return {
      ceiling: 'owner_review',
      reason: `Pragmatic media-buyer mode: both attributed contribution windows are negative (mature ${formatMoney(lagged.contributionAfterAds)}, recent ${formatMoney(recent.contributionAfterAds)}). This is association evidence, not incremental proof — owner review only.`,
    }
  }
  if (lagged.estimand !== 'total_contribution_vs_no_ads' || recent.estimand !== 'total_contribution_vs_no_ads') {
    return { ceiling: 'unsupported', reason: 'A cut or pause requires the current unit’s causal incremental contribution versus a no-ad counterfactual in both non-overlapping windows.' }
  }
  if (!sameContributionDefinition(lagged, recent)) {
    return { ceiling: 'unsupported', reason: 'The two contribution windows do not share one currency, metric definition, realization horizon, cost policy, and governed causal decision package, so they are not comparable.' }
  }
  if (ev.structuralContinuity !== true) {
    return { ceiling: 'unsupported' as const, reason: ev.structuralContinuity === null
      ? 'The setup could NOT be shown unchanged since the historical period began, so that period\'s losses cannot be attributed to the current configuration.'
      : 'A material setting change separates the historical period from the current setup, so the two describe different configurations.' }
  }
  if (lagged.contributionAfterAds >= 0) {
    return { ceiling: 'unsupported', reason: `Mature positive contribution after ads is ${formatMoney(lagged.contributionAfterAds)}, so it contradicts the proposed ${kind === 'pause' ? 'pause' : 'cut'}.` }
  }
  if (recent.contributionAfterAds >= 0 || recent.contributionInterval.upper >= 0) {
    return { ceiling: 'unsupported', reason: 'The non-overlapping recent contribution window does not corroborate the mature loss, so the two windows conflict.' }
  }
  if (lagged.contributionInterval.upper >= 0) {
    return {
      ceiling: 'owner_review',
      reason: `Mature collected contribution is negative at the point estimate, but its ${(lagged.contributionInterval.confidence * 100).toFixed(0)}% interval crosses zero. Review is warranted; execution is not.`,
    }
  }
  const weakestConfidence = Math.min(
    lagged.contributionInterval.confidence,
    recent.contributionInterval.confidence,
  )
  if (weakestConfidence < MAXX_OWNER_PROFIT_POLICY.minimumExecutionConfidence) {
    return {
      ceiling: 'owner_review',
      reason: `Both loss intervals remain below zero, but the weakest confidence level is ${(weakestConfidence * 100).toFixed(0)}%, below the owner policy's ${(MAXX_OWNER_PROFIT_POLICY.minimumExecutionConfidence * 100).toFixed(0)}% execution minimum.`,
    }
  }
  const measured = `The mature ${(lagged.contributionInterval.confidence * 100).toFixed(0)}% collected-contribution interval remains below zero (${formatMoney(lagged.contributionInterval.lower)} to ${formatMoney(lagged.contributionInterval.upper)}), and the non-overlapping recent window corroborates the loss.`
  return kind === 'pause'
    ? { ceiling: 'owner_review', reason: `${measured} A pause stops the unit outright, so it remains an owner decision.` }
    : { ceiling: 'execution', reason: measured }
}
