/**
 * Business-neutral outcome vocabulary (ADR-058). An outcome is one business result recorded by an
 * outcome source: a lead, a sale, a booking, a sign-up. Every adapter (CSV, signed webhook, the reference
 * scheduling example) normalizes into this shape; nothing downstream knows which system produced it.
 */

export const OUTCOME_TYPES = ['lead', 'booking', 'sale', 'signup', 'quote', 'subscription', 'custom'] as const
export type OutcomeType = (typeof OUTCOME_TYPES)[number]

export const OUTCOME_STATUSES = ['pending', 'confirmed', 'cancelled', 'refunded'] as const
export type OutcomeStatus = (typeof OUTCOME_STATUSES)[number]

/** Whether the outcome came from the business's website. Mirrors the conversions origin gate: only
 *  `website` outcomes can be sent to an ad platform, and `unknown` blocks exactness rather than
 *  being assumed either way. */
export type OutcomeOrigin = 'website' | 'staff_or_manual' | 'unknown'

/** Deliberately not "test" or "comp": an active outcome worth nothing may be a package redemption, a
 *  gift certificate, a staff block, a genuine comp or a test. The ledger cannot tell them apart, so
 *  the state names only what is observable. */
export type OutcomeValueState = 'active_value_bearing' | 'active_zero_value' | 'cancelled'

/** The minimal fields the facts aggregation needs. Values are exact decimals in the outcome's currency;
 *  NULL means not observed, 0 means observed zero. */
export interface OutcomeLite {
  id: string | number
  /** Scheduled, listed or invoiced value (e.g. a booking's price). */
  grossValue: number | null
  /** Value the source recorded as collected (e.g. amount paid at checkout). */
  collectedValue?: number | null
  status: OutcomeStatus
  origin?: OutcomeOrigin | null
  /** Supplied when the row came from the canonical database view; otherwise derived identically. */
  valueState?: OutcomeValueState | null
}

export function isActive(status: OutcomeStatus): boolean {
  return status === 'pending' || status === 'confirmed'
}

export function classifyOutcomeValueState(row: Pick<OutcomeLite, 'status' | 'grossValue'>): OutcomeValueState {
  if (!isActive(row.status)) return 'cancelled'
  return (row.grossValue ?? 0) > 0 ? 'active_value_bearing' : 'active_zero_value'
}
