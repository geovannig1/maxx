import { ALERT_THRESHOLDS } from '@/config/alerts.config'

/**
 * Returns 'critical' or 'warning' if frequency exceeds thresholds, else null.
 */
export function checkFrequencyAlert(current: number): 'critical' | 'warning' | null {
  if (current >= ALERT_THRESHOLDS.frequency.critical) return 'critical'
  if (current >= ALERT_THRESHOLDS.frequency.warning) return 'warning'
  return null
}

/**
 * Returns 'warning' if CTR has dropped by more than the warning threshold vs baseline.
 * A drop means current < baseline.
 */
export function checkCtrDrop(current: number, baseline: number): 'warning' | null {
  if (baseline <= 0) return null
  const dropPct = (baseline - current) / baseline
  if (dropPct >= ALERT_THRESHOLDS.ctr_drop_pct.warning) return 'warning'
  return null
}

/**
 * Returns 'critical' or 'warning' if CPL has spiked above baseline by the respective thresholds.
 */
export function checkCplSpike(current: number, baseline: number): 'critical' | 'warning' | null {
  if (baseline <= 0) return null
  const spikePct = (current - baseline) / baseline
  if (spikePct >= ALERT_THRESHOLDS.cpl_spike_pct.critical) return 'critical'
  if (spikePct >= ALERT_THRESHOLDS.cpl_spike_pct.warning) return 'warning'
  return null
}

/**
 * Returns 'critical' or 'warning' if spend has spiked above baseline.
 */
export function checkSpendSpike(current: number, baseline: number): 'critical' | 'warning' | null {
  if (baseline <= 0) return null
  const spikePct = (current - baseline) / baseline
  if (spikePct >= ALERT_THRESHOLDS.spend_spike_pct.critical) return 'critical'
  if (spikePct >= ALERT_THRESHOLDS.spend_spike_pct.warning) return 'warning'
  return null
}

/**
 * Returns 'warning' if spend has dropped by more than the warning threshold vs baseline.
 */
export function checkSpendDrop(current: number, baseline: number): 'warning' | null {
  if (baseline <= 0) return null
  const dropPct = (baseline - current) / baseline
  if (dropPct >= ALERT_THRESHOLDS.spend_drop_pct.warning) return 'warning'
  return null
}

/**
 * Returns 'warning' if CPM has spiked above baseline.
 */
export function checkCpmSpike(current: number, baseline: number): 'warning' | null {
  if (baseline <= 0) return null
  const spikePct = (current - baseline) / baseline
  if (spikePct >= ALERT_THRESHOLDS.cpm_spike_pct.warning) return 'warning'
  return null
}

/** Zero-CONVERSION alert (leads OR bookings, whichever the campaign optimizes for). Fires ONLY when the
 *  campaign NORMALLY produces that conversion (baseline window total > 0) but today produced zero on real
 *  spend. This suppresses the structural-zero noise that fired "zero leads" every day on a bookings-
 *  optimized account (leads is structurally 0 there) and on learning-phase campaigns that never convert. */
export function checkZeroConversions(args: {
  todayConversions: number
  spend: number
  baselineConversions: number
}): 'warning' | null {
  if (args.baselineConversions <= 0) return null // structural zero — not a signal, don't cry wolf daily
  if (args.todayConversions === 0 && args.spend >= ALERT_THRESHOLDS.zero_leads_min_spend) return 'warning'
  return null
}

/**
 * Returns 'info' if spend has exhausted >= 95% of the budget.
 */
export function checkBudgetExhausted(spend: number, budget: number): 'info' | null {
  if (budget <= 0) return null
  const pct = spend / budget
  if (pct >= ALERT_THRESHOLDS.budget_exhausted_pct) return 'info'
  return null
}
