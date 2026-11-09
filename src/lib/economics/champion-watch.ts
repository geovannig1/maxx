// Legacy entry point retained for daily-sync compatibility. The former implementation compared
// Meta-modelled bookings to a pinned historical CPA and emitted a live "champion candidate" alert.
// That promoted a measurement-era-specific record into current policy outside ActionDecision.

export const CHAMPION_WATCH_STATUS = {
  status: 'disabled' as const,
  reason_code: 'historical_benchmark_has_no_current_authority' as const,
  action_authority: 'none' as const,
}

/** No-op by contract: historical audit records cannot create current alerts or actions. */
export async function runChampionWatch(adAccountDbId: string): Promise<number> {
  void adAccountDbId
  return 0
}
