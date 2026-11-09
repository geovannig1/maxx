// Legacy automatic brief/test generation is intentionally quarantined.
//
// The retired implementation converted Meta-modelled winner flags into three LLM briefs plus a
// context-free budget, runtime, booking-CPA kill rule, keep rule, and scale rule. Those artifacts had
// no immutable business/page context, CampaignPlan revision, creative concept slot, exact paid outcome,
// or shared ActionDecision authority. Running it would continue polluting the owner's test queue.
//
// CAMPAIGN_PLAN_REQUIRED: the replacement belongs to the governed experiment system and may resume only
// when it loads an approved account-scoped plan revision, writes plan-bound briefs/experiments, and uses
// the plan's outcome-specific success/stop/review rules. Historical rows remain readable and untouched.

/** Compatibility entry point for the existing daily cron. No DB, LLM, or Meta call is made. */
export const runFeedbackLoop: (adAccountDbId: string) => Promise<number> = async () => 0

/** Compatibility entry point for legacy completed tests. No new feedback artifact is generated. */
export const processFeedbackForCompletedTests: (adAccountDbId: string) => Promise<number> = async () => 0
