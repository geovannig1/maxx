import { aggregateOutcomeFacts, type OutcomeFacts } from './facts'
import { classifyOutcomeValueState, type OutcomeLite } from './model'

// THE business vocabulary. One definition, mirrored from the canonical v_business_outcomes view,
// pinned to it row-for-row by tests/db/integration/ga4-ledger-join.test.ts.
//
// A review found Maxx holding TWO conflicting definitions of a booking in the same report: one reader
// counted every active row (including $0) as a booking, while the GA reconciliation excluded active $0
// rows from its business total. Both numbers were labelled "bookings". Neither was wrong on its own;
// having both unlabelled was.
//
// The fix is not to pick one. It is to say which is which, always, in one vocabulary.

/** Deliberately NOT 'test' or 'comp'. An active appointment charging nothing may be a package
 *  redemption, a gift certificate, a staff block, a genuine comp, or a test booking — the ledger
 *  cannot distinguish them, so the state names only what is observable. */
export type BusinessState = 'active_value_bearing' | 'active_zero_value' | 'canceled'

/** Whether this appointment SHOULD have produced a GA confirmation event. Mirrors
 *  `v_business_outcomes.web_origin_state`, which mirrors the CAPI origin gate. Needed to decide COMPLETENESS: a staff or
 *  manual appointment legitimately has no GA event, a website one must have joined, and an unknown
 *  origin can be placed in neither group so it blocks exactness. */
export type WebOriginState = 'website' | 'staff_or_manual' | 'origin_unknown'

export interface LedgerAppointmentLite {
  id: number
  price: number | null
  amount_paid?: number | null
  canceled: boolean | null
  /** Supplied when the row came from v_business_outcomes; otherwise derived identically. */
  business_state?: BusinessState | null
  /** Supplied by v_business_outcomes. Absent ⇒ treated as origin_unknown,
   *  which is the conservative direction: unknown origin blocks exact attribution. */
  web_origin_state?: WebOriginState | null
}

export function webOriginOf(row: LedgerAppointmentLite): WebOriginState {
  return row.web_origin_state ?? 'origin_unknown'
}

/** Appointment-vocabulary view of the ONE classifier (src/lib/outcomes/model.ts). */
export function classifyBusinessState(row: Pick<LedgerAppointmentLite, 'price' | 'canceled'>): BusinessState {
  const state = classifyOutcomeValueState({ status: row.canceled ? 'cancelled' : 'confirmed', grossValue: row.price })
  return state === 'cancelled' ? 'canceled' : state
}

/**
 * Business facts from the outcome ledger. Every field is named for exactly what it counts, because
 * the previous single `bookings`/`revenue` pair is what let two definitions coexist unnoticed.
 */
export interface BusinessFacts {
  /** Every non-canceled appointment — value-bearing AND zero-value. The broadest honest count. */
  confirmedAppointments: number
  /** Non-canceled AND price > 0. The only class that contributes booked value. */
  valueBearingBookings: number
  /** Non-canceled AND price = 0. Real appointments. NOT called tests — see BusinessState. */
  zeroValueAppointments: number
  canceledAppointments: number
  /** sum(price) over value-bearing appointments. Scheduled price, kept separate from checkout revenue. */
  bookedValue: number
  /** Sum of the collected values the source actually supplied on ACTIVE outcomes. When coverage is
   *  incomplete this is an OBSERVED LOWER BOUND, never an exact revenue total or ROAS numerator. */
  observedCollectedValue: number
  /** The owner-declared operational revenue: the source's collected value on ACTIVE outcomes (the
   *  amount collected after discounts). Processor settlement remains the separate settlement/refund
   *  reconciliation source. NULL means at least one active outcome lacks a collected value, so the
   *  exact total is unavailable rather than a false zero. */
  recordedOutcomeValue: number | null
  /** Share of ACTIVE outcomes for which the source recorded ANY collected value (including 0).
   *  A coverage figure, not a collection rate. Stripe reconciliation remains a separate plane. */
  amountPaidCoverage: { withRecordedAmount: number; total: number }
  /** ACTIVE appointments whose `web_origin_state` is `website` — a client booked through the site, so
   *  each SHOULD have produced a GA confirmation event. This is the ONLY population a GA browser-tag
   *  health check may compare against. `confirmedAppointments` is all-source (organic,
   *  phone, staff/manual, unknown) and cannot contradict a paid or telemetry subset — an organic or
   *  manually created appointment missing from GA is not evidence of anything being broken. */
  websiteOriginAppointments: number
  /** ACTIVE appointments whose origin was never established. Reported separately because they can be
   *  placed in neither group: they are not proof of a gap, and not proof of its absence. */
  originUnknownAppointments: number
}

export const EMPTY_BUSINESS_FACTS: BusinessFacts = {
  confirmedAppointments: 0, valueBearingBookings: 0, zeroValueAppointments: 0,
  canceledAppointments: 0, bookedValue: 0, observedCollectedValue: 0,
  recordedOutcomeValue: 0,
  amountPaidCoverage: { withRecordedAmount: 0, total: 0 },
  websiteOriginAppointments: 0, originUnknownAppointments: 0,
}

/** Appointment row → generic outcome (ADR-058). A canceled appointment is a cancelled outcome; any other
 *  row is confirmed. The web-origin vocabulary maps 1:1, and an absent origin stays absent: the
 *  aggregation counts only an EXPLICIT unknown as unknown, exactly as before. */
/** A ledger row keyed by either a numeric source id or an outcome uuid (the facts ignore it). */
export type LedgerRowLike = Omit<LedgerAppointmentLite, 'id'> & { id: number | string }

function toOutcome(row: LedgerRowLike): OutcomeLite {
  const origin = row.web_origin_state == null ? null
    : row.web_origin_state === 'origin_unknown' ? 'unknown' : row.web_origin_state
  const valueState = row.business_state == null ? null
    : row.business_state === 'canceled' ? 'cancelled' : row.business_state
  return {
    id: row.id,
    grossValue: row.price,
    collectedValue: row.amount_paid,
    status: row.canceled ? 'cancelled' : 'confirmed',
    origin,
    valueState,
  }
}

/** PURE. The one aggregation, expressed in appointment vocabulary over the generic outcome facts. */
export function aggregateBusinessFacts(rows: readonly LedgerRowLike[]): BusinessFacts {
  return businessFactsFromOutcomeFacts(aggregateOutcomeFacts(rows.map(toOutcome)))
}

/** PURE. Generic outcome facts in the appointment vocabulary (field for field, no arithmetic). */
export function businessFactsFromOutcomeFacts(facts: OutcomeFacts): BusinessFacts {
  return {
    confirmedAppointments: facts.activeOutcomes,
    valueBearingBookings: facts.valueBearingOutcomes,
    zeroValueAppointments: facts.zeroValueOutcomes,
    canceledAppointments: facts.cancelledOutcomes,
    bookedValue: facts.grossValue,
    observedCollectedValue: facts.observedCollectedValue,
    recordedOutcomeValue: facts.collectedValue,
    amountPaidCoverage: {
      withRecordedAmount: facts.collectedValueCoverage.withRecordedValue,
      total: facts.collectedValueCoverage.total,
    },
    websiteOriginAppointments: facts.websiteOriginOutcomes,
    originUnknownAppointments: facts.originUnknownOutcomes,
  }
}

/** A v_business_outcomes row as read for the ledger vocabulary (ADR-058 read boundary). */
export interface BusinessOutcomeLedgerRow {
  id: string
  external_id: string
  gross_value: number | null
  collected_value: number | null
  status: string
  business_state: string | null
  web_origin_state: WebOriginState | null
}

/** Generic outcome row → appointment vocabulary. `id` stays the source's numeric id (external_id),
 *  `cancelled` maps back to the appointment-vocabulary `canceled`, and NULL values stay NULL. */
export function ledgerRowFromBusinessOutcome(row: BusinessOutcomeLedgerRow): LedgerAppointmentLite {
  return {
    id: Number(row.external_id),
    price: row.gross_value,
    amount_paid: row.collected_value,
    canceled: row.status === 'cancelled',
    business_state: row.business_state == null ? null
      : row.business_state === 'cancelled' ? 'canceled' : row.business_state as BusinessState,
    web_origin_state: row.web_origin_state,
  }
}

/** The order the ledger was always returned in: ascending numeric source id. Paging orders by the
 *  outcome uuid (a total order); this restores the numeric order every consumer and sum saw before. */
export function byNumericExternalId(a: { id: number }, b: { id: number }): number {
  return a.id - b.id
}
