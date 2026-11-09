// The causal-contribution metric name. It was `causal_incremental_contribution_dollars`; the amount
// is in the experiment's currency, so the name no longer names one. The schema accepts only the new
// name; stored rows written before the rename (recommendation_outcomes.metric_name) are read through
// isCausalContributionMetric. Client-safe and dependency-free.

export const CAUSAL_CONTRIBUTION_METRIC = 'causal_incremental_contribution' as const

/** The legacy name, accepted when reading stored rows only. */
export const LEGACY_CAUSAL_CONTRIBUTION_METRIC = 'causal_incremental_contribution_dollars' as const

/** True for the causal-contribution metric under its current or its legacy name. */
export function isCausalContributionMetric(name: unknown): boolean {
  return name === CAUSAL_CONTRIBUTION_METRIC || name === LEGACY_CAUSAL_CONTRIBUTION_METRIC
}
