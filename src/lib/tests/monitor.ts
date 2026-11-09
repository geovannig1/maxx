export interface LegacyTestMonitorResult {
  status: 'CAMPAIGN_PLAN_REQUIRED'
  inert: true
  processed: 0
  killed: 0
  completed: 0
  blocker_codes: ['campaign_plan_not_implemented', 'experiment_registry_not_implemented']
  note: string
}

/**
 * Compatibility entry point for the daily cron.
 *
 * The retired monitor parsed free-text rules stored on legacy test rows, evaluated them against
 * Meta-modelled bookings, mutated test status, and emitted pause/scale instructions. Those rows have
 * no immutable CampaignPlan lineage, plan-bound experiment identity, or exact paid-outcome cohort.
 * Reading or acting on them would bypass the current authority model, so this shim is intentionally
 * inert and preserves every historical row unchanged.
 */
export async function runTestMonitor(
  _adAccountDbId: string,
  _date: string,
): Promise<LegacyTestMonitorResult> {
  void _adAccountDbId
  void _date
  return {
    status: 'CAMPAIGN_PLAN_REQUIRED',
    inert: true,
    processed: 0,
    killed: 0,
    completed: 0,
    blocker_codes: ['campaign_plan_not_implemented', 'experiment_registry_not_implemented'],
    note: 'Legacy test monitoring is inert; historical rows remain untouched until a plan-bound experiment registry with exact outcome evidence exists.',
  }
}
