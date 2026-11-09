import { classifyOutcomeValueState, type OutcomeLite, type OutcomeValueState } from './model'

/**
 * Business facts over outcomes. Every field is named for exactly what it counts: an earlier single
 * "bookings"/"revenue" pair let two definitions of a booking coexist unnoticed in one report.
 */
export interface OutcomeFacts {
  /** Every active outcome, value-bearing and zero-value. The broadest honest count. */
  activeOutcomes: number
  /** Active and gross value > 0. The only class that contributes gross value. */
  valueBearingOutcomes: number
  /** Active and gross value = 0 (or unknown). Real outcomes, not "tests". */
  zeroValueOutcomes: number
  cancelledOutcomes: number
  /** Sum of gross value over value-bearing outcomes. Kept separate from collected value. */
  grossValue: number
  /** Sum of the collected values the source actually recorded on ACTIVE outcomes. When coverage is
   *  incomplete this is an observed lower bound, never an exact revenue total or ROAS numerator. */
  observedCollectedValue: number
  /** The exact collected total, or NULL when at least one active outcome has no recorded collected
   *  value: an incomplete total is unavailable, never a false zero. */
  collectedValue: number | null
  /** Share of active outcomes with ANY recorded collected value (including 0). Coverage, not a rate. */
  collectedValueCoverage: { withRecordedValue: number; total: number }
  /** Active outcomes from the website: the only population a web-analytics completeness check may use. */
  websiteOriginOutcomes: number
  /** Active outcomes whose origin was explicitly recorded as unknown. They belong to neither group. */
  originUnknownOutcomes: number
}

export const EMPTY_OUTCOME_FACTS: OutcomeFacts = {
  activeOutcomes: 0, valueBearingOutcomes: 0, zeroValueOutcomes: 0, cancelledOutcomes: 0,
  grossValue: 0, observedCollectedValue: 0, collectedValue: 0,
  collectedValueCoverage: { withRecordedValue: 0, total: 0 },
  websiteOriginOutcomes: 0, originUnknownOutcomes: 0,
}

/** PURE. The one aggregation over outcomes. */
export function aggregateOutcomeFacts(rows: readonly OutcomeLite[]): OutcomeFacts {
  const stateOf = (r: OutcomeLite): OutcomeValueState => r.valueState ?? classifyOutcomeValueState(r)
  const valueBearing = rows.filter((r) => stateOf(r) === 'active_value_bearing')
  const zeroValue = rows.filter((r) => stateOf(r) === 'active_zero_value')
  const cancelled = rows.filter((r) => stateOf(r) === 'cancelled')
  const active = [...valueBearing, ...zeroValue]
  const observed = active.filter((r): r is OutcomeLite & { collectedValue: number } => r.collectedValue != null)
  const observedCollectedValue = observed.reduce((sum, r) => sum + r.collectedValue, 0)
  const complete = observed.length === active.length
  return {
    activeOutcomes: active.length,
    valueBearingOutcomes: valueBearing.length,
    zeroValueOutcomes: zeroValue.length,
    cancelledOutcomes: cancelled.length,
    grossValue: valueBearing.reduce((sum, r) => sum + (r.grossValue ?? 0), 0),
    // Over ACTIVE outcomes only: a cancelled outcome's recorded payment is not an active business
    // fact, and whether it was refunded is not visible here.
    observedCollectedValue,
    collectedValue: complete ? observedCollectedValue : null,
    collectedValueCoverage: { withRecordedValue: observed.length, total: active.length },
    // Over ACTIVE outcomes only: a cancelled outcome never had a live website session to compare.
    websiteOriginOutcomes: active.filter((r) => r.origin === 'website').length,
    originUnknownOutcomes: active.filter((r) => r.origin === 'unknown').length,
  }
}
