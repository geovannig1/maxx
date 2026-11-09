import { REC_THRESHOLDS } from './thresholds'
import { REVERSAL_CLASS, type RecommendationType, type EvidenceBasis, type NoOscillationResult } from './types'
import { formatMoney } from '@/lib/utils/format-currency'
import { outcomeWords } from '@/config/outcome-nouns'

// What this business calls its outcomes (NEXT_PUBLIC_OUTCOME_NOUN).
const OW = outcomeWords()

// No-oscillation rule.
//
// Maxx must NOT recommend reversing strategy, changing the optimization event, pausing, scaling, or
// restructuring unless ALL of:
//   - the data window is sufficient,
//   - the trend is stable,
//   - there is enough spend or conversion volume,
//   - the last major change had enough time for the plan's maturity window,
//   - the recommendation is supported by observed performance OR is clearly labeled a test hypothesis.
//
// Oscillation (flipping the same setting twice reactively) is itself the over-correction pattern the
// account was burned by, so this is a HARD gate, not advice.

export interface NoOscillationInput {
  recommendation_type: RecommendationType
  window_days: number
  spend: number
  bookings: number | null // conversions/bookings observed in the window
  /** Days since the last major change to this entity. null = no known prior change (fine to act). */
  days_since_last_change: number | null
  /** Meta delivery state, retained for compatibility and reporting; it does not decide sufficiency. */
  exited_learning: boolean | null
  /** Whether the recent trend is stable (not wild day-to-day swings). null = unknown ⇒ not stable. */
  trend_stable: boolean | null
  basis: EvidenceBasis
}

export function checkNoOscillation(input: NoOscillationInput): NoOscillationResult {
  const isReversal = REVERSAL_CLASS.has(input.recommendation_type)

  if (!isReversal) {
    return {
      is_reversal_class: false,
      allowed: true,
      reason: 'Not a reversal/scale/restructure recommendation — no-oscillation rule does not apply.',
      blocking_factors: [],
    }
  }

  const blocking: string[] = []

  // 1. Sufficient window.
  if (input.window_days < REC_THRESHOLDS.MIN_WINDOW_DAYS_REVERSAL) {
    blocking.push(
      `Window is only ${input.window_days}d (need ≥ ${REC_THRESHOLDS.MIN_WINDOW_DAYS_REVERSAL}d; ${OW.many} lag on 7-day-click attribution).`
    )
  }

  // 2. Enough spend or conversion volume.
  const hasVolume =
    input.spend >= REC_THRESHOLDS.MIN_SPEND_TO_JUDGE ||
    (input.bookings ?? 0) >= REC_THRESHOLDS.MIN_BOOKINGS_PERF_CLAIM
  if (!hasVolume) {
    blocking.push(
      `Thin volume (${formatMoney(input.spend, { maximumFractionDigits: 0 })} spend, ${input.bookings ?? 0} ${OW.many}) — below the bar to reverse a strategy.`
    )
  }

  // 3. Trend stable.
  if (input.trend_stable !== true) {
    blocking.push('Trend is not confirmed stable — could be normal learning-period volatility.')
  }

  // 4. Last change had a conservative diagnostic window. The governed CampaignPlan owns the real
  // attribution/maturity contract; Meta learning state neither proves nor vetoes the outcome.
  if (
    input.days_since_last_change !== null &&
    input.days_since_last_change < REC_THRESHOLDS.MIN_DAYS_SINCE_LAST_CHANGE
  ) {
    blocking.push(
      `Last change was ${input.days_since_last_change}d ago (diagnostic floor ≥ ${REC_THRESHOLDS.MIN_DAYS_SINCE_LAST_CHANGE}d; the CampaignPlan maturity contract still governs).`
    )
  }

  // 5. Supported by observed performance OR explicitly a test hypothesis.
  if (input.basis === 'external_best_practice') {
    blocking.push(
      'Justified only by external best practice, not this account’s observed performance — reframe as a labeled TEST, not a strategy reversal.'
    )
  }

  const allowed = blocking.length === 0
  return {
    is_reversal_class: true,
    allowed,
    reason: allowed
      ? 'Reversal clears the legacy diagnostic guard: sufficient window, stable trend, adequate volume, prior change has had time to work, and the basis is observed performance. Final authority still requires the governed maturity and evidence contract.'
      : 'Reversal blocked by the no-oscillation rule — ' + blocking.length + ' condition(s) unmet.',
    blocking_factors: blocking,
  }
}
