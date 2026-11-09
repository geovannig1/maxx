import { formatMoney } from '@/lib/utils/format-currency'
// STRUCTURED VALUE RECONCILIATION — the evidence gate behind the report's "expected timing delta"
// claim.
//
// The doctrine used to say, unconditionally, that GA4/Meta revenue sitting below Acuity is EXPECTED
// because Acuity holds final-state value while GA4/Meta hold booking-moment value. That is a real
// mechanism, but as a blanket statement it is unfalsifiable: for any given day it is
// indistinguishable from a broken tag, an undelivered CAPI event, or a modelled-attribution
// disagreement. Calling all of them "expected" is exactly the failure this work package exists to
// remove.
//
// So the claim is now earned PER APPOINTMENT, from the durable `outcome_observations` lineage:
//
//   proven_post_send_change            a recorded value/status change happened AFTER Meta accepted
//                                      the event -> and ONLY this may be called an expected timing
//                                      delta.
//   no_observed_change                 lineage exists and shows no post-send change -> the
//                                      difference is NOT explained by value timing.
//   unknown_no_lineage                 the row predates observation lineage (migration_snapshot) or
//                                      has no observations -> unknowable, never assumed benign.
//   capi_delivery_missing              no accepted delivery, or delivery failed -> the difference is
//                                      a DELIVERY problem, not a timing one.
//   modeled_attribution_disagreement   delivered, no value change, yet the planes still differ ->
//                                      modelled attribution, which can under- OR over-attribute.
//
// Everything that is not `proven_post_send_change` is reported as unexplained / not directly
// reconcilable. No PII enters this module: it works on ids and scalars only.

export type ReconciliationState =
  | 'proven_post_send_change'
  | 'no_observed_change'
  | 'unknown_no_lineage'
  | 'capi_delivery_missing'
  | 'modeled_attribution_disagreement'

export interface ObservationEvidence {
  /** 'first_observation' | 'price_change' | 'status_change' | 'price_and_status_change' */
  changeKind: string
  observedAtMs: number
  oldPrice: number | null
  newPrice: number | null
  oldCanceled: boolean | null
  newCanceled: boolean | null
}

export interface AppointmentReconciliationInput {
  appointmentId: number
  /** 'observed' = a real first observation. 'migration_snapshot' = backfilled; NOT a booking-time value. */
  initialProvenance: 'observed' | 'migration_snapshot' | null
  /** Material changes recorded for this appointment (first_observation rows may be included). */
  observations: ObservationEvidence[]
  /** When Meta accepted the server CAPI event, or null if it never did. */
  capiAcceptedAtMs: number | null
  /** True when a delivery row exists at all (an attempted-but-failed send is still evidence). */
  capiAttempted: boolean
  /** Whether the modelled plane (Meta/GA4) differs from business truth for this row. */
  modeledDiffers: boolean
}

export interface AppointmentReconciliation {
  appointmentId: number
  state: ReconciliationState
  /** Signed value movement proven to have happened after Meta accepted the event; null when unproven. */
  provenDelta: number | null
  /** Short, PII-free explanation of WHY this state was assigned. */
  reason: string
}

const PRICE_KINDS = new Set(['price_change', 'price_and_status_change'])
const STATUS_KINDS = new Set(['status_change', 'price_and_status_change'])

/**
 * PURE: classify one appointment's difference. Order matters — delivery is checked before value,
 * because an undelivered event explains the difference on its own and must never be dressed up as a
 * timing delta.
 */
export function reconcileAppointment(input: AppointmentReconciliationInput): AppointmentReconciliation {
  const { appointmentId } = input

  // 1. No accepted delivery => the difference is a delivery problem.
  if (input.capiAcceptedAtMs === null) {
    return {
      appointmentId,
      state: 'capi_delivery_missing',
      provenDelta: null,
      reason: input.capiAttempted
        ? 'server CAPI delivery was attempted but never accepted by Meta'
        : 'no server CAPI delivery was recorded for this booking',
    }
  }

  // 2. No usable lineage => unknowable. A migration_snapshot is the mutable value at migration time,
  //    NOT a booking-time value, so it can never prove a change happened after the send.
  const material = input.observations.filter((o) => PRICE_KINDS.has(o.changeKind) || STATUS_KINDS.has(o.changeKind))
  if (input.initialProvenance !== 'observed') {
    return {
      appointmentId,
      state: 'unknown_no_lineage',
      provenDelta: null,
      reason: 'no first observation was recorded before this row was already mutable (migration snapshot) — a value change cannot be proven or ruled out',
    }
  }
  if (input.observations.length === 0) {
    return {
      appointmentId,
      state: 'unknown_no_lineage',
      provenDelta: null,
      reason: 'no observation lineage exists for this booking',
    }
  }

  // 3. A material change strictly AFTER acceptance is the only thing that proves a timing delta.
  const postSend = material.filter((o) => o.observedAtMs > input.capiAcceptedAtMs!)
  if (postSend.length > 0) {
    const priceMoves = postSend.filter((o) => PRICE_KINDS.has(o.changeKind))
    const delta = priceMoves.reduce((sum, o) => sum + ((o.newPrice ?? 0) - (o.oldPrice ?? 0)), 0)
    const cancels = postSend.filter((o) => STATUS_KINDS.has(o.changeKind) && o.newCanceled === true).length
    const parts: string[] = []
    if (priceMoves.length > 0) parts.push(`${priceMoves.length} price change(s) totalling ${delta >= 0 ? '+' : ''}${delta}`)
    if (cancels > 0) parts.push(`${cancels} cancellation(s)`)
    return {
      appointmentId,
      state: 'proven_post_send_change',
      provenDelta: priceMoves.length > 0 ? delta : null,
      reason: `recorded after Meta accepted the event: ${parts.join(', ')}`,
    }
  }

  // 4. Lineage exists and shows nothing after the send. If the planes still differ, that is modelled
  //    attribution — which can under- OR over-attribute relative to business truth.
  if (input.modeledDiffers) {
    return {
      appointmentId,
      state: 'modeled_attribution_disagreement',
      provenDelta: null,
      reason: 'delivered and unchanged since the send, yet the modelled plane still differs — a modelled-attribution disagreement, not a value-timing effect',
    }
  }

  return {
    appointmentId,
    state: 'no_observed_change',
    provenDelta: null,
    reason: 'delivered, with no recorded value or status change after the send',
  }
}

export interface ReconciliationSummary {
  total: number
  byState: Record<ReconciliationState, number>
  /** Sum of value movement PROVEN to have occurred after the send. The only figure that may be
   *  described as an expected timing delta. */
  provenTimingDelta: number
  /** Count of rows whose difference is NOT explained by proven value timing. */
  unexplainedCount: number
  /** True when nothing at all is proven — the report must then not claim a timing explanation. */
  noProvenEvidence: boolean
}

const EMPTY_BY_STATE = (): Record<ReconciliationState, number> => ({
  proven_post_send_change: 0,
  no_observed_change: 0,
  unknown_no_lineage: 0,
  capi_delivery_missing: 0,
  modeled_attribution_disagreement: 0,
})

/** PURE: roll per-appointment verdicts into the figures the report is allowed to state. */
export function summarizeReconciliation(rows: AppointmentReconciliation[]): ReconciliationSummary {
  const byState = EMPTY_BY_STATE()
  let provenTimingDelta = 0
  for (const r of rows) {
    byState[r.state] += 1
    if (r.state === 'proven_post_send_change' && r.provenDelta !== null) provenTimingDelta += r.provenDelta
  }
  const proven = byState.proven_post_send_change
  return {
    total: rows.length,
    byState,
    provenTimingDelta,
    unexplainedCount: rows.length - proven,
    noProvenEvidence: proven === 0,
  }
}

/**
 * PURE: the exact prose the report may use. Deliberately conservative — when nothing is proven it
 * says so instead of reaching for the timing explanation, and it never claims Meta "under-counts":
 * modelled attribution can under- OR over-attribute relative to business truth.
 */
export function renderReconciliationBlock(
  s: ReconciliationSummary,
  opts: { modeledEvaluated?: boolean } = {},
): string[] {
  if (s.total === 0) {
    return ['=== VALUE RECONCILIATION ===', '  No bookings in range to reconcile.', '']
  }
  const lines = [
    '=== VALUE RECONCILIATION (row-level evidence — do NOT generalise beyond it) ===',
    `  Bookings examined: ${s.total}`,
    `  PROVEN post-send value/status change: ${s.byState.proven_post_send_change}` +
      (s.byState.proven_post_send_change > 0
        ? ` (net ${s.provenTimingDelta >= 0 ? '+' : ''}${formatMoney(s.provenTimingDelta)}) — this subset, and ONLY this subset, is an expected value-timing delta.`
        : ' — nothing is proven, so NO part of the difference may be called an expected timing delta.'),
    `  Delivered, no recorded change since the send: ${s.byState.no_observed_change} — UNEXPLAINED by value timing.`,
    `  No usable lineage (pre-instrumentation / migration snapshot): ${s.byState.unknown_no_lineage} — NOT directly reconcilable; unknown, not benign.`,
    `  Server CAPI delivery missing or failed: ${s.byState.capi_delivery_missing} — a DELIVERY gap, not a timing effect.`,
    // This state is NOT EVALUATED in production — Meta attributes at entity level, not
    // per appointment, so no row can be shown to disagree. Printing "0" would present an unmeasured
    // state as a measured one.
    opts.modeledEvaluated === false
      ? '  Modelled-attribution disagreement: NOT EVALUATED — per-row modelled linkage does not exist, so this state is UNAVAILABLE, not zero. Do not report it as "no disagreements".'
      : `  Modelled-attribution disagreement: ${s.byState.modeled_attribution_disagreement} — modelled attribution can under- OR over-attribute relative to business truth.`,
    `  UNEXPLAINED / not directly reconcilable total: ${s.unexplainedCount} of ${s.total}.`,
  ]
  if (s.noProvenEvidence) {
    lines.push(
      '  RULE: with zero proven post-send changes, state the difference as UNEXPLAINED. Do not assert',
      '  that it is expected, and do not describe it as normal final-state-vs-booking-moment timing.',
    )
  }
  lines.push('')
  return lines
}
