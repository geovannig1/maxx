import { SPEND_FLOORS } from './spend-floors'

export const ALERT_THRESHOLDS = {
  frequency: {
    warning: 2.5,
    critical: 3.5,
  },
  ctr_drop_pct: {
    warning: 0.25,
    critical: 0.50,
  },
  cpl_spike_pct: {
    warning: 0.25,
    critical: 0.75,
  },
  spend_spike_pct: {
    warning: 0.50,
    critical: 1.00,
  },
  spend_drop_pct: {
    warning: 0.40,
  },
  cpm_spike_pct: {
    warning: 0.35,
  },
  /** Account currency: NEXT_PUBLIC_MIN_SPEND_TO_JUDGE. */
  get zero_leads_min_spend(): number { return SPEND_FLOORS.judge },
  budget_exhausted_pct: 0.95,
  baseline_days: 7,
} as const
