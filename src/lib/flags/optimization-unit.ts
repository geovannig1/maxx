import type { FlagType } from '@/types/db'

// The UNIT OF OPTIMIZATION — the level at which a budget/scale/pause decision should be judged.
// Doctrine (src/mcp/instructions.ts): "CBO → campaign; ABO → ad set; never judge one ad in isolation."
// This module makes that doctrine executable so the flag engine, recommendations and reporting all
// resolve the decision unit the same way instead of always defaulting to the ad set.

export type OptimizationUnit = 'campaign' | 'adset'

/**
 * A campaign runs Campaign Budget Optimization (CBO / Advantage+ campaign budget) when the budget is set
 * at the CAMPAIGN level; under ABO the budget lives on each ad set. Meta places the budget at exactly one
 * level, so budget location is the reliable signal (we do not get a dedicated CBO boolean on the entity).
 */
export function campaignIsCbo(c: { daily_budget: number | null; lifetime_budget: number | null }): boolean {
  return c.daily_budget != null || c.lifetime_budget != null
}

/**
 * The optimization unit for an entity in a campaign. CBO → campaign (Meta reallocates budget across the
 * campaign's ad sets, so pausing/scaling one ad set in isolation fights the optimizer); ABO → ad set.
 */
export function resolveOptimizationUnit(isCbo: boolean): OptimizationUnit {
  return isCbo ? 'campaign' : 'adset'
}

/**
 * Flag types that represent a BUDGET decision (pause a loser / scale a winner) and therefore belong to
 * the optimization unit. Under CBO these are evaluated at the campaign, not per ad set; everything else
 * (creative fatigue, watchlist, winner/too_early signals) stays at its own level.
 */
export const BUDGET_DECISION_FLAGS: ReadonlySet<FlagType> = new Set<FlagType>(['loser', 'scale_candidate'])

/** True when a budget-decision flag for an ad set should be suppressed because its campaign is CBO — the
 *  decision belongs to the campaign-level evaluation instead. */
export function suppressAdsetBudgetFlagUnderCbo(flagType: FlagType, isCbo: boolean): boolean {
  return isCbo && BUDGET_DECISION_FLAGS.has(flagType)
}
