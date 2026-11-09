import { formatMoney, formatMoneyAmount } from '@/lib/utils/format-currency'
// EXAMPLE HISTORICAL BENCHMARK — illustrative placeholder, not data.
//
// Replace with your own account's proven baseline: a consolidated conversion ad set that ran long
// enough to be a benchmark. Pin the record from your Meta history (ad set id, period, spend,
// Meta-attributed results) and keep it as an audit record only.
//
// This record explains account history and creative-fatigue context. It is not current policy, a prior,
// a target, or action authority. Current money decisions require current exact evidence and governed
// targets; no producer may turn this record into a scale/keep/cut instruction.
//
// A final period with delivery signals consistent with creative wear (rising frequency, eroding CTR,
// rising modelled CPA) is a correlation; it does not establish the cause.

export interface ChampionBenchmark {
  adset_name: string
  meta_adset_id: string
  period: { start: string; end: string }
  spend: number
  bookings: number // Meta-attributed AppointmentConfirmed
  /** Lifetime Meta-attributed CPA. */
  lifetime_cpa: number
  /** Prime-months CPA band. */
  prime_cpa_low: number
  prime_cpa_high: number
  /** ~bookings/week during prime at ~$40–60/day. */
  prime_bookings_per_week: number
  death_cause: 'unproven'
  death_signals: { peak_frequency: number; ctr_peak_pct: number; ctr_trough_pct: number; final_month_cpa: number }
  attribution_note: string
}

export const CHAMPION_BENCHMARK: ChampionBenchmark = {
  adset_name: 'Example champion ad set',
  meta_adset_id: '100000000000000001',
  period: { start: '2025-01-01', end: '2025-06-30' },
  spend: 9000,
  bookings: 300,
  lifetime_cpa: 30,
  prime_cpa_low: 20,
  prime_cpa_high: 30,
  prime_bookings_per_week: 12,
  death_cause: 'unproven',
  death_signals: { peak_frequency: 4.5, ctr_peak_pct: 2.5, ctr_trough_pct: 1.2, final_month_cpa: 55 },
  attribution_note:
    'Meta-attributed (1d-view/7d-click era) — treat as the platform-consistent comparator for other Meta-attributed CPAs, not as outcome-source ground truth. ' +
    'ATTRIBUTION-SETTING CAVEAT: compare periods only after reading back their actual attribution settings; do not assign an unverified percentage artifact to a settings change. ' +
    'MEASUREMENT-BASIS CAVEAT: server-side CAPI may change observable coverage only for events with accepted delivery and valid deduplication lineage. Do not infer that Meta received all bookings, predict the direction or size of a CPA change, or credit any coverage discontinuity to ad performance.',
}

export type ChampionVerdict = 'beats' | 'matches' | 'worse' | 'unproven'

export interface ChampionComparison {
  verdict: ChampionVerdict
  /** candidate CPA ÷ champion lifetime CPA (lower is better). null when unproven. */
  ratio: number | null
  detail: string
  context_status: 'historical_audit_only'
  action_authority: 'none'
}

/** ±10% of the champion's lifetime CPA counts as matching. Small samples are 'unproven', never a verdict. */
export function championVerdict(cpa: number | null, bookings: number, opts?: { minBookings?: number }): ChampionComparison {
  const minBookings = opts?.minBookings ?? 3
  const c = CHAMPION_BENCHMARK
  if (cpa === null || !isFinite(cpa) || bookings < minBookings) {
    return {
      verdict: 'unproven',
      ratio: cpa !== null && isFinite(cpa) && cpa > 0 ? cpa / c.lifetime_cpa : null,
      detail: `Historical platform-modelled comparison is unproven (needs ≥${minBookings} modelled results; historical record: ${formatMoneyAmount(c.lifetime_cpa)} lifetime, ${formatMoneyAmount(c.prime_cpa_low)}–${c.prime_cpa_high} prime). No action authority.`,
      context_status: 'historical_audit_only',
      action_authority: 'none',
    }
  }
  const ratio = cpa / c.lifetime_cpa
  if (ratio <= 0.9) {
    return {
      verdict: 'beats', ratio,
      detail: `CPA ${formatMoney(cpa)} is ${Math.round((1 - ratio) * 100)}% below the ${formatMoneyAmount(c.lifetime_cpa)} historical platform-modelled record. Historical audit comparison only; no action authority.`,
      context_status: 'historical_audit_only', action_authority: 'none',
    }
  }
  if (ratio <= 1.1) {
    return {
      verdict: 'matches', ratio,
      detail: `CPA ${formatMoney(cpa)} is within ±10% of the ${formatMoneyAmount(c.lifetime_cpa)} historical platform-modelled record. Historical audit comparison only; no action authority.`,
      context_status: 'historical_audit_only', action_authority: 'none',
    }
  }
  return {
    verdict: 'worse', ratio,
    detail: `CPA ${formatMoney(cpa)} is ${Math.round((ratio - 1) * 100)}% above the ${formatMoneyAmount(c.lifetime_cpa)} historical platform-modelled record (historical prime: ${formatMoneyAmount(c.prime_cpa_low)}–${c.prime_cpa_high}). Historical audit comparison only; no action authority.`,
    context_status: 'historical_audit_only', action_authority: 'none',
  }
}
