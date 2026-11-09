import {
  aggregateBusinessFacts as aggregateOutcomeBusinessFacts,
  type BusinessFacts,
  type LedgerRowLike,
} from '@/lib/outcomes/business-facts'

// The business vocabulary lives in src/lib/outcomes/business-facts.ts. This module keeps only the
// appointment-ledger key names the golden snapshots froze (tests/golden/outcome-semantics.golden.test.ts
// records `acuityRecordedAmountPaid` and `acuityRecordedRevenue`): the same numbers, field for field,
// under the historical keys. Shared code reads the neutral `observedCollectedValue` / `recordedOutcomeValue`.
export {
  classifyBusinessState, webOriginOf, businessFactsFromOutcomeFacts, ledgerRowFromBusinessOutcome,
  byNumericExternalId, EMPTY_BUSINESS_FACTS,
  type BusinessFacts, type BusinessState, type WebOriginState, type LedgerAppointmentLite, type LedgerRowLike,
  type BusinessOutcomeLedgerRow,
} from '@/lib/outcomes/business-facts'

/** The golden-pinned key names of BusinessFacts (no arithmetic, no other difference). */
export type AcuityBusinessFacts = Omit<BusinessFacts, 'observedCollectedValue' | 'recordedOutcomeValue'> & {
  acuityRecordedAmountPaid: number
  acuityRecordedRevenue: number | null
}

/** PURE. BusinessFacts under the historical appointment-ledger keys. */
export function toAcuityBusinessFacts(facts: BusinessFacts): AcuityBusinessFacts {
  const { observedCollectedValue, recordedOutcomeValue, ...rest } = facts
  return { ...rest, acuityRecordedAmountPaid: observedCollectedValue, acuityRecordedRevenue: recordedOutcomeValue }
}

/** PURE. The one aggregation (src/lib/outcomes/business-facts.ts) under the historical keys. */
export function aggregateBusinessFacts(rows: readonly LedgerRowLike[]): AcuityBusinessFacts {
  return toAcuityBusinessFacts(aggregateOutcomeBusinessFacts(rows))
}
