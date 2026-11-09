import { formatMoneyAmount } from '@/lib/utils/format-currency'
export const MAXX_CONTRIBUTION_DEFINITION_VERSION = 'maxx-causal-contribution-v1' as const

const DEFAULT_DAILY_BUDGET_CEILING = 100

/** Owner-approved account-total daily budget ceiling, in the account currency. DAILY_BUDGET_CEILING
 *  overrides the default; the deprecated DAILY_BUDGET_CEILING_USD is still accepted. */
export function readDailyBudgetCeiling(env: Record<string, string | undefined> = process.env): number {
  const current = env.DAILY_BUDGET_CEILING?.trim()
  const name = current ? 'DAILY_BUDGET_CEILING' : 'DAILY_BUDGET_CEILING_USD'
  const raw = current || env.DAILY_BUDGET_CEILING_USD?.trim()
  if (!raw) return DEFAULT_DAILY_BUDGET_CEILING
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0 || value > 1_000_000) {
    throw new Error(`${name} must be a positive amount in the account currency.`)
  }
  return value
}

const DAILY_BUDGET_CEILING = readDailyBudgetCeiling()

/**
 * Owner commercial policy v1.
 *
 * This is deliberately narrower than the legacy target/AOV settings. Maxx exists to maximize
 * incremental contribution from ad-attributed, processor-settled collected revenue. "Incremental"
 * requires a causal comparison; ad attribution identifies which settled money enters that comparison.
 * Exact paid touch alone is a fallback association measure, not causal proof. Booking counts, booked
 * value, platform ROAS, and CPA stay diagnostic only.
 */
export const MAXX_OWNER_PROFIT_POLICY = Object.freeze({
  status: 'governed' as const,
  version: 'maxx-owner-profit-v1',
  objective: 'maximize_incremental_contribution_from_ad_attributed_collected_revenue' as const,
  dailyBudgetCeiling: DAILY_BUDGET_CEILING,
  collectionBasis: 'processor_settled_excluding_tax' as const,
  measurementHierarchy: [
    'controlled_incrementality',
    'quasi_experimental_incrementality',
    'exact_paid_touch_association',
  ] as const,
  revenueAttributionRule:
    'Attribute processor-settled collected revenue through governed treatment/comparator assignment; exact paid touch alone is an association view and cannot establish incrementality.',
  contributionFormula:
    'settled collections excluding tax - refunds/chargebacks - payment fees - variable fulfillment costs - ad spend',
  contributionDefinitionVersion: MAXX_CONTRIBUTION_DEFINITION_VERSION,
  minimumExecutionConfidence: 0.9,
  estimandRule:
    'Every causal component is treatment minus the declared comparator. Budget increases require both marginal contribution versus the current state and proposed total contribution versus no ads.',
  budgetRule:
    `The ${formatMoneyAmount(DAILY_BUDGET_CEILING)} account daily ceiling cannot increase without new owner approval after decision-grade positive contribution evidence.`,
})

export type MaxxCommercialObjective = typeof MAXX_OWNER_PROFIT_POLICY.objective

export type ContributionEvidenceStatus = 'complete' | 'incomplete'
export type ContributionIncrementality =
  | 'controlled_experiment'
  | 'quasi_experimental'
  | 'attributed_only'
  | 'unavailable'
export type ContributionEstimand =
  /** Incremental contribution from the proposed configuration/budget versus the current state. */
  | 'marginal_contribution_vs_current_state'
  /** Incremental contribution from the evaluated ad unit versus a no-ad counterfactual. */
  | 'total_contribution_vs_no_ads'
  /** Observed paid-touch association; explicitly not a causal estimand. */
  | 'attributed_association'

/** One immutable, server-resolved profit window. Positive monetary components stay separate so a
 * pre-netted or double-subtracted number cannot silently masquerade as contribution. */
export interface ContributionWindowEvidence {
  status: ContributionEvidenceStatus
  currency: string
  metricDefinitionVersion: string
  realizationHorizonDays: number
  costPolicyVersion: string
  /** One governed decision package may contain separate immutable designs for separate estimands. */
  causalDecisionPackageId: string
  /** Exact design for this estimand; two different estimands must not pretend to share one design. */
  measurementDesignId: string
  estimand: ContributionEstimand
  /** Atomic amounts for the declared measurement basis. Under causal designs these are treatment-
   *  minus-counterfactual deltas and may be signed; under paid-touch association they are observed
   *  non-negative amounts. They must reconcile exactly to contributionAfterAds. */
  collectedRevenue: number
  refundsAndChargebacks: number
  paymentProcessingFees: number
  variableFulfillmentCosts: number
  /** Treatment/configuration spend observed in the source cohort. Used for lineage reconciliation. */
  observedTreatmentAdSpend: number
  /** Spend component of the estimand. This is treatment minus comparator under a causal design. */
  adSpend: number
  contributionAfterAds: number
  contributionInterval: { lower: number; upper: number; confidence: number }
  /** Observed settled payment records supporting precision diagnostics; not a claim of attribution. */
  observedSettledPayments: number
  matured: boolean
  collectionLineage: 'processor_settled' | 'unavailable'
  /** How payments enter the evaluated comparison. Paid touch supports association only; treatment
   *  assignment/comparison supports the corresponding incrementality design. */
  measurementLineage:
    | 'randomized_treatment_assignment'
    | 'quasi_experimental_comparison'
    | 'exact_paid_touch'
    | 'unavailable'
  costLineage: 'governed_cost_policy' | 'unavailable'
  incrementality: ContributionIncrementality
}

export interface ProfitPolicyEvidence {
  status: 'governed' | 'missing' | 'invalid' | 'unavailable'
  version: string | null
  objective: 'maximize_incremental_contribution_from_ad_attributed_collected_revenue' | 'unknown'
  dailyBudgetCeiling: number | null
  /** Account-total budgets, never one ad set's isolated budget. */
  currentAccountDailyBudget: number | null
  proposedAccountDailyBudget: number | null
}

export function ownerProfitPolicyEvidence(
  budgets: {
    currentAccountDailyBudget: number | null
    proposedAccountDailyBudget: number | null
  },
  /** Override the daily-budget ceiling when the evidence is evaluated under a different policy
   *  context (e.g. pragmatic media-buyer mode). Defaults to the governed causal-pipeline ceiling. */
  dailyBudgetCeiling: number | null = null,
): ProfitPolicyEvidence {
  return {
    status: MAXX_OWNER_PROFIT_POLICY.status,
    version: MAXX_OWNER_PROFIT_POLICY.version,
    objective: MAXX_OWNER_PROFIT_POLICY.objective,
    dailyBudgetCeiling: dailyBudgetCeiling ?? MAXX_OWNER_PROFIT_POLICY.dailyBudgetCeiling,
    ...budgets,
  }
}
