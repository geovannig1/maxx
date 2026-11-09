import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import { getAdminClient } from '@/lib/supabase/admin'
import { hashEmail, hashPhone, hashName, BOOKING_PAGE_URL, type CapiUserData } from './conversion-events'
import { buildFbc } from './relay-event'
import type { AcuityAppointmentRaw } from '@/lib/outcomes/adapters/acuity/client'
import type { LinkedPaidTouchForCapi } from '@/lib/outcomes/adapters/acuity/paid-touch-link'
import { findAcuityOutcome } from '@/lib/outcomes/adapters/acuity/outcome-source'
import {
  fetchMetaConversion,
  interpretMetaCapiResponse,
  metaEventValue,
  recordDelivery,
  resolvePixelId,
  type CapiErrorClass,
  type CapiResponseVerdict,
} from '@/lib/platforms/meta/conversions-delivery'
import { exceedsOutcomeMoneyCeiling } from '@/lib/outcomes/money-ceiling'

// The Meta response contract moved to src/lib/platforms/meta/conversions-delivery.ts; re-exported unchanged.
export {
  INVALID_JSON,
  interpretMetaCapiResponse,
  type CapiErrorClass,
  type CapiResponseVerdict,
} from '@/lib/platforms/meta/conversions-delivery'

// SERVER-SIDE CAPI: Acuity webhook/sweep → Meta AppointmentConfirmed (owner-approved plan 2026-07-17).
// This is the SOLE server-side sender (2026-07-18: the public browser relay was REMOVED — no _fbp capture).
// Meta's redundant-setup best practice: the browser Meta Pixel tag and this server path share the
// DETERMINISTIC event_id `acuity-<appointmentId>`, so Meta dedups the pair; when the browser is blocked,
// the server copy is the only one and still lands — 100% booking coverage for optimization, recovering
// the bookings a blocked browser pixel would miss.
//
// Hard requirements encoded here (R1-R4):
//   R1 TRUE event_time — datetimeCreated exactly; future clock skew capped at now; older than Meta's
//      7-day window → SKIP 'expired' (a falsified time is worse than a missing event).
//   R2 test/live separation — resolveSendMode(): 'live' | 'test' | 'off'. Callers persist capi_sent_at
//      ONLY for live deliveries; test submissions are quarantined by Meta and never mark delivery.
//   R3 fbp — attached from the ledger row IF present; normally null now (the browser relay that captured
//      it was removed). fbc is reconstructed only from an immutable linked paid touch whose server
//      observation time predates this booking; a legacy intake fbclid has no trustworthy click time.
//   R4 origin gate — scheduledBy must be EXPLICITLY null (client-booked). Staff-created → 'staff_created'.
//      The list endpoint omits the field, so senders must pass a BY-ID fetch; missing key → 'origin_unknown'.
// Also: AppointmentConfirmed ONLY (Purchase/Schedule come from Acuity's own integration without
// event_ids — mirroring them cannot dedup and would double-count).

const EVENT_MAX_AGE_MS = 7 * 24 * 3600_000 // Meta acceptance window for website events

export type AcuitySendMode = 'live' | 'test' | 'off'

/** R2/R8: staged fail-closed gate. 'test' without META_TEST_EVENT_CODE degrades to 'off', never to live. */
export function resolveSendMode(env: Record<string, string | undefined> = process.env): AcuitySendMode {
  const flag = (env.ACUITY_CAPI_SEND ?? '').trim().toLowerCase()
  if (flag === 'true') return 'live'
  if (flag === 'test') return env.META_TEST_EVENT_CODE ? 'test' : 'off'
  return 'off'
}

export interface AcuityCapiBuildResult {
  ok: boolean
  /** Terminal skip label (recorded to capi_send_error): 'staff_created' | 'origin_unknown' | 'expired' | 'no_id'. */
  skip?: string
  payload?: {
    data: Array<{
      event_name: 'AppointmentConfirmed'
      event_time: number
      event_id: string
      event_source_url: string
      action_source: 'website'
      user_data: CapiUserData & { fbp?: string; fbc?: string }
      /** The value in the outcome's own currency (the ad account currency), in its major units. */
      custom_data?: { value: number; currency: string }
    }>
    test_event_code?: string
  }
}

type AcuityCapiGate =
  | { ok: false; skip: string }
  | { ok: true; id: string; createdMs: number; eventTimeSec: number }

/** PURE: the R1/R4 gates and the true event time. A skip here never needs the recorded outcome. */
function gateAcuityCapiEvent(appt: AcuityAppointmentRaw, nowMs: number): AcuityCapiGate {
  const id = String(appt.id ?? '').trim()
  if (!id) return { ok: false, skip: 'no_id' }

  // R4 — origin gate on the EXPLICIT field. Key missing (list-shaped payload) = unknown, never assumed client.
  if (!('scheduledBy' in appt)) return { ok: false, skip: 'origin_unknown' }
  if (appt.scheduledBy !== null && String(appt.scheduledBy).trim() !== '') return { ok: false, skip: 'staff_created' }

  // R1 — true booking time; cap future skew at now; expired → skip, never shift.
  const createdMs = appt.datetimeCreated ? new Date(appt.datetimeCreated).getTime() : NaN
  if (!Number.isFinite(createdMs)) return { ok: false, skip: 'expired' } // unknown time = unverifiable = skip
  if (nowMs - createdMs > EVENT_MAX_AGE_MS) return { ok: false, skip: 'expired' }
  return { ok: true, id, createdMs, eventTimeSec: Math.floor(Math.min(createdMs, nowMs) / 1000) }
}

/**
 * PURE: build the server AppointmentConfirmed for one BY-ID-fetched appointment.
 * `currency` is the recorded outcome's own currency (equal to the ad account currency); the value is
 * sent in that currency, never relabelled. `fbp` comes from the ledger row; `nowMs` injectable for tests.
 */
export function buildAcuityCapiEvent(
  appt: AcuityAppointmentRaw,
  opts: {
    currency: string
    fbp?: string | null
    paidTouch?: LinkedPaidTouchForCapi | null
    testEventCode?: string | null
    nowMs?: number
  },
): AcuityCapiBuildResult {
  const gate = gateAcuityCapiEvent(appt, opts.nowMs ?? Date.now())
  if (!gate.ok) return { ok: false, skip: gate.skip }
  const { id, createdMs, eventTimeSec } = gate

  const user_data: CapiUserData & { fbp?: string; fbc?: string } = {}
  const em = hashEmail(appt.email)
  const ph = hashPhone(appt.phone)
  const fn = hashName(appt.firstName)
  const ln = hashName(appt.lastName)
  if (em) user_data.em = [em]
  if (ph) user_data.ph = [ph]
  if (fn) user_data.fn = [fn]
  if (ln) user_data.ln = [ln]
  // Stable person key. Acuity returns no client id on any appointment (verified across the ledger),
  // so the normalized email hash is the only identifier stable across a client's bookings, and returning
  // renters can be a large share of the book.
  if (em) user_data.external_id = [em]
  // R3 — device identifiers when captured. Acuity's server IP/UA are deliberately NEVER attached
  // (not the client). A raw appointment fbclid is diagnostic only because it carries no proven click
  // time; fbc is created solely from the immutable paid-touch link.
  const fbp = (opts.fbp ?? '').trim()
  if (fbp) user_data.fbp = fbp
  const paidTouchMs = opts.paidTouch?.observedAt
    ? new Date(opts.paidTouch.observedAt).getTime()
    : NaN
  const fbc = Number.isFinite(paidTouchMs) && paidTouchMs <= createdMs
    ? buildFbc(opts.paidTouch?.fbclid, paidTouchMs)
    : null
  if (fbc) user_data.fbc = fbc

  const price = typeof appt.price === 'number' ? appt.price : parseFloat(String(appt.price ?? ''))
  // Above OUTCOME_MONEY_CEILING the event is sent without a value, never with an implausible one.
  const value = Number.isFinite(price) && price > 0 && !exceedsOutcomeMoneyCeiling(price) ? price : null

  const event = {
    event_name: 'AppointmentConfirmed' as const,
    event_time: eventTimeSec,
    event_id: `acuity-${id}`,
    event_source_url: BOOKING_PAGE_URL,
    action_source: 'website' as const,
    user_data,
    ...(value !== null ? { custom_data: { value: metaEventValue(value, opts.currency), currency: opts.currency } } : {}),
  }
  const payload: NonNullable<AcuityCapiBuildResult['payload']> = { data: [event] }
  if (opts.testEventCode) payload.test_event_code = opts.testEventCode
  return { ok: true, payload }
}

export interface AcuitySendOutcome {
  mode: AcuitySendMode
  /**
   * 'sent'                 Meta accepted AND the local audit row is durable.
   * 'accepted_unrecorded'  CRITICAL/RETRYABLE — Meta accepted but audit persistence failed. Delivery
   *                        state was NOT stamped, so the sweep retries; the deterministic event_id
   *                        makes that retry safe (Meta dedups it), so no double-count can occur.
   * 'skipped'              terminal skip label in `skip`.
   * 'error' / 'off'        as before.
   */
  status: 'sent' | 'skipped' | 'error' | 'off' | 'accepted_unrecorded'
  skip?: string
  error?: string
  errorClass?: CapiErrorClass
  eventsReceived?: number | null
  eventId?: string
  /** True ONLY when Meta accepted and record_conversion_delivery persisted the lineage row. */
  deliveryRecorded?: boolean
}

/**
 * Send one appointment's server event per the gates. Never throws.
 *
 * Delivery state is no longer the caller's job: record_conversion_delivery() writes the lineage row
 * and (live + accepted only — R2) stamps outcomes.conversion_sent_at in ONE transaction, so "Meta accepted" and
 * "we recorded it" cannot disagree. Every database result is checked.
 */
export async function sendAcuityCapiEvent(
  appt: AcuityAppointmentRaw,
  fbp: string | null | undefined,
  supabase?: SupabaseClient,
  paidTouch?: LinkedPaidTouchForCapi | null,
): Promise<AcuitySendOutcome> {
  const mode = resolveSendMode()
  if (mode === 'off') return { mode, status: 'off' }

  // The pure gates first: a skipped booking never needs the recorded outcome.
  const gate = gateAcuityCapiEvent(appt, Date.now())
  if (!gate.ok) return { mode, status: 'skipped', skip: gate.skip }
  const expectedEventId = `acuity-${Number(appt.id)}`

  const pixelId = await resolvePixelId()
  const accessToken = process.env.META_CAPI_ACCESS_TOKEN ?? process.env.META_ACCESS_TOKEN
  if (!pixelId || !accessToken) {
    return { mode, status: 'error', error: 'pixel id / access token unavailable', errorClass: 'config_missing', eventId: expectedEventId }
  }

  // The delivery audit row is keyed by the outcome uuid, and the value is sent in the outcome's own
  // currency. Resolve it BEFORE contacting Meta: an event whose delivery cannot be recorded must never
  // be sent (it could never be marked delivered).
  const outcome = await resolveDeliveryOutcome(appt, supabase)
  if (!outcome.ok) {
    console.error(`[Acuity CAPI] refusing to send ${expectedEventId}: ${outcome.message}`)
    return {
      mode,
      status: 'error',
      error: outcome.message,
      errorClass: 'outcome_unresolved',
      eventId: expectedEventId,
      deliveryRecorded: false,
    }
  }

  const built = buildAcuityCapiEvent(appt, {
    currency: outcome.currency,
    fbp,
    paidTouch,
    testEventCode: mode === 'test' ? process.env.META_TEST_EVENT_CODE : null,
  })
  if (!built.ok || !built.payload) return { mode, status: 'skipped', skip: built.skip }

  const event = built.payload.data[0]
  const eventId = event.event_id
  // event_id is DERIVED, and the database enforces the same rule. Assert it here so a build
  // change that breaks the derivation fails at the sender rather than at the constraint.
  if (eventId !== expectedEventId) {
    console.error(`[Acuity CAPI] refusing to send: derived event_id ${eventId} != ${expectedEventId}`)
    return { mode, status: 'error', error: 'derived event_id mismatch', errorClass: 'config_missing', eventId }
  }

  const response = await fetchMetaConversion(pixelId, accessToken, built.payload)
  const verdict: CapiResponseVerdict = 'networkError' in response
    ? { accepted: false, errorClass: 'network_error', message: response.networkError, eventsReceived: null }
    : interpretMetaCapiResponse(response.httpOk, response.httpStatus, response.parsed)

  const errorState = verdict.accepted ? null : verdict.errorClass
  const recorded = await recordDelivery(
    {
      outcomeId: outcome.outcomeId,
      eventId,
      eventTimeSec: event.event_time,
      value: event.custom_data?.value ?? null,
      currency: event.custom_data?.currency ?? null,
      mode,
      eventsReceived: verdict.accepted ? 1 : verdict.eventsReceived,
      errorState,
      errorClass: errorState,
    },
    supabase,
  )

  if (!verdict.accepted) {
    // Log the redacted class + message only — never the payload, token, or customer values.
    console.error(`[Acuity CAPI] ${eventId} not delivered (${verdict.errorClass}): ${verdict.message}`)
    return {
      mode,
      status: 'error',
      error: verdict.message,
      errorClass: verdict.errorClass,
      eventsReceived: verdict.eventsReceived,
      eventId,
      deliveryRecorded: recorded.ok,
    }
  }

  if (!recorded.ok) {
    // Meta HAS the event; we could not write the audit row. Delivery state is deliberately left
    // unset so the sweep retries. Retrying the same deterministic event_id is dedup-safe.
    console.error(
      `[Acuity CAPI] CRITICAL: ${eventId} was ACCEPTED by Meta but audit persistence failed ` +
      `(${recorded.errorClass}). conversion_sent_at NOT stamped; the sweep will retry the same event_id.`,
    )
    return {
      mode,
      status: 'accepted_unrecorded',
      error: recorded.message,
      errorClass: 'audit_persistence_failed',
      eventsReceived: 1,
      eventId,
      deliveryRecorded: false,
    }
  }

  console.log(`[Acuity CAPI] ${eventId} accepted ${mode === 'live' ? 'LIVE' : '(test)'}${fbp ? ' +fbp' : ''}`)
  return { mode, status: 'sent', eventsReceived: 1, eventId, deliveryRecorded: true }
}

/** The single recorded outcome for this appointment. A lookup failure is unresolved, not a throw. */
async function resolveDeliveryOutcome(
  appt: AcuityAppointmentRaw,
  supabase?: SupabaseClient,
): Promise<{ ok: true; outcomeId: string; currency: string } | { ok: false; message: string }> {
  try {
    const outcome = await findAcuityOutcome(supabase ?? getAdminClient(), Number(appt.id))
    if (!outcome) return { ok: false, message: 'no single recorded outcome for the appointment' }
    if (!/^[A-Z]{3}$/.test(outcome.currency)) return { ok: false, message: 'the recorded outcome has no valid currency' }
    return { ok: true, outcomeId: outcome.id, currency: outcome.currency }
  } catch (err) {
    return { ok: false, message: `outcome lookup failed: ${err instanceof Error ? err.message : String(err)}` }
  }
}
