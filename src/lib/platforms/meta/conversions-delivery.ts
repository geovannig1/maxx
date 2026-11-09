import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import { getAdminClient } from '@/lib/supabase/admin'
import { META_GRAPH_BASE, META_API_VERSION } from '@/lib/platforms/meta/api-version'
import { fromMinorUnits, toMinorUnits } from '@/lib/utils/format-currency'

// Meta Conversions API transport shared by every conversions sender (the outcome-source example and generic
// outcomes): pixel resolution, the response acceptance contract, and the atomic delivery record.
// Moved unchanged from the reference adapter's conversion sender.

/**
 * An event value as Meta reads it: in the major units of the outcome's own currency, at that currency's
 * precision (whole yen for JPY, cents for USD, fils for KWD). Never converted between currencies.
 */
export function metaEventValue(value: number, currency: string): number {
  return fromMinorUnits(toMinorUnits(value, currency), currency)
}

export async function resolvePixelId(): Promise<string | null> {
  if (process.env.META_PIXEL_ID) return process.env.META_PIXEL_ID
  try {
    const db = getAdminClient()
    const { data } = await db.from('ad_accounts').select('pixel_id').eq('is_active', true).limit(1).maybeSingle()
    return (data?.pixel_id as string | null | undefined) ?? null
  } catch {
    return null
  }
}

// ── META RESPONSE CONTRACT ─────────────────────────────────────────────────────────────────────
// An HTTP 2xx is NOT delivery. Meta answers 200 with `{}` for a request it understood but did not
// turn into an event, and a transport/proxy can return 2xx with a non-JSON body. The previous sender
// treated "res.ok and no error key" as sent and stamped capi_sent_at from it — a false positive that
// permanently removed the booking from the retry sweep. A send counts ONLY when all four hold:
//   1. the body parses as JSON;
//   2. it is a non-null object of the expected shape;
//   3. events_received is EXACTLY 1;
//   4. no Meta error object is present.

/** Redacted failure classes. Never carries a token, signed URL, or customer value. */
export type CapiErrorClass =
  | 'http_error'
  | 'meta_error'
  | 'invalid_json'
  | 'null_response'
  | 'malformed_response'
  | 'no_events_received'
  | 'unexpected_events_received'
  | 'network_error'
  | 'config_missing'
  | 'audit_persistence_failed'
  // The persisted delivery row did not describe the event we sent.
  | 'rpc_identity_mismatch'
  | 'rpc_acceptance_disagreement'
  | 'rpc_parent_not_marked'
  // The appointment has no single recorded outcome, so a delivery could not be audited. Never sent.
  | 'outcome_unresolved'

export type CapiResponseVerdict =
  | { accepted: true; eventsReceived: 1 }
  | { accepted: false; errorClass: CapiErrorClass; message: string; eventsReceived: number | null }

/**
 * PURE: decide whether Meta actually accepted the event. `parsed` is the JSON body, or the
 * `INVALID_JSON` sentinel when the body could not be parsed at all (distinct from a literal null
 * body, which is its own failure).
 */
export const INVALID_JSON = Symbol('invalid-json')

export function interpretMetaCapiResponse(
  httpOk: boolean,
  httpStatus: number,
  parsed: unknown,
): CapiResponseVerdict {
  if (parsed === INVALID_JSON) {
    return { accepted: false, errorClass: 'invalid_json', message: `HTTP ${httpStatus}: response body was not JSON`, eventsReceived: null }
  }

  // A Meta error object is authoritative even on a 2xx, and its message is checked BEFORE the HTTP
  // status so the operator gets the real reason rather than a bare status code.
  const obj = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null
  const metaErr = obj?.error as { message?: string; code?: number; type?: string } | undefined
  if (metaErr) {
    const detail = metaErr.message ?? `code ${metaErr.code ?? '?'}`
    return { accepted: false, errorClass: 'meta_error', message: `Meta error: ${detail}`, eventsReceived: null }
  }

  if (!httpOk) {
    return { accepted: false, errorClass: 'http_error', message: `HTTP ${httpStatus}`, eventsReceived: null }
  }

  if (parsed === null || parsed === undefined) {
    return { accepted: false, errorClass: 'null_response', message: `HTTP ${httpStatus}: null response body`, eventsReceived: null }
  }
  if (!obj || Array.isArray(parsed)) {
    return { accepted: false, errorClass: 'malformed_response', message: `HTTP ${httpStatus}: response was not a JSON object`, eventsReceived: null }
  }

  const raw = obj.events_received
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    // `{}` lands here: understood but no event. Never treat it as delivered.
    return {
      accepted: false,
      errorClass: 'malformed_response',
      message: `HTTP ${httpStatus}: response has no numeric events_received`,
      eventsReceived: null,
    }
  }
  if (raw === 0) {
    return { accepted: false, errorClass: 'no_events_received', message: 'Meta accepted the request but received 0 events', eventsReceived: 0 }
  }
  if (raw !== 1) {
    // We send exactly one event. Anything else means the payload was not what we believe it was.
    return {
      accepted: false,
      errorClass: 'unexpected_events_received',
      message: `Meta reported events_received=${raw} for a single-event payload`,
      eventsReceived: raw,
    }
  }
  return { accepted: true, eventsReceived: 1 }
}

export type MetaConversionResponse =
  | { httpOk: boolean; httpStatus: number; parsed: unknown }
  | { networkError: string }

/**
 * POST one single-event payload to the pixel's events endpoint. Never throws. The caller judges the
 * answer with interpretMetaCapiResponse; a network failure is its own outcome.
 */
export async function fetchMetaConversion(
  pixelId: string,
  accessToken: string,
  payload: Record<string, unknown>,
): Promise<MetaConversionResponse> {
  try {
    const res = await fetch(`${META_GRAPH_BASE}/${pixelId}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...payload, access_token: accessToken }),
    })
    let parsed: unknown
    try {
      parsed = await res.json()
    } catch {
      parsed = INVALID_JSON
    }
    return { httpOk: res.ok, httpStatus: res.status, parsed }
  } catch (err) {
    return { networkError: err instanceof Error ? err.message : String(err) }
  }
}

export interface DeliveryRecordInput {
  outcomeId: string
  eventId: string
  eventTimeSec: number
  value: number | null
  currency: string | null
  mode: 'live' | 'test'
  eventsReceived: number | null
  errorState: string | null
  errorClass: string | null
}

/** Persist delivery lineage through the atomic RPC. EVERY result is checked — a silent write failure
 *  is what let "delivered" diverge from reality in the first place. */
export async function recordDelivery(
  input: DeliveryRecordInput,
  supabase?: SupabaseClient,
): Promise<{ ok: boolean; message?: string; errorClass?: string }> {
  try {
    const db = supabase ?? getAdminClient()
    const { data, error } = await db.rpc('record_conversion_delivery', {
      p_outcome_id: input.outcomeId,
      p_event_id: input.eventId,
      p_event_time: new Date(input.eventTimeSec * 1000).toISOString(),
      p_value: input.value,
      p_currency: input.currency,
      p_send_mode: input.mode,
      p_events_received: input.eventsReceived,
      p_error_state: input.errorState,
      p_error_class: input.errorClass,
      p_api_version: META_API_VERSION,
    })
    if (error) return { ok: false, message: error.message, errorClass: 'rpc_error' }
    // A null/!object payload means the RPC did not return the state it contracts to return.
    if (!data || typeof data !== 'object') {
      return { ok: false, message: 'delivery RPC returned no state', errorClass: 'rpc_empty' }
    }

    // VALIDATE the returned identity. Trusting the RPC's word was how a cross-appointment
    // event_id could stamp the wrong parent without the sender ever noticing. The persisted row must
    // describe the event we believe we sent, for the appointment we believe we sent it for.
    const r = data as Record<string, unknown>
    if (r.event_id !== input.eventId) {
      return {
        ok: false,
        message: `delivery RPC persisted event_id ${String(r.event_id)} but the sender sent ${input.eventId}`,
        errorClass: 'rpc_identity_mismatch',
      }
    }
    if (r.outcome_id !== input.outcomeId) {
      return {
        ok: false,
        message: `delivery RPC persisted outcome ${String(r.outcome_id)} but the sender sent ${input.outcomeId}`,
        errorClass: 'rpc_identity_mismatch',
      }
    }
    // The RPC's acceptance verdict must agree with ours. A disagreement means the two sides applied
    // different rules, and neither may be trusted to have recorded delivery correctly.
    const expectedAccepted = input.errorState === null && input.errorClass === null && input.eventsReceived === 1
    if (r.accepted !== expectedAccepted) {
      return {
        ok: false,
        message: `delivery RPC reported accepted=${String(r.accepted)} where the sender computed ${expectedAccepted}`,
        errorClass: 'rpc_acceptance_disagreement',
      }
    }
    // A LIVE accepted delivery must have marked the parent. If it did not, delivery state is not
    // durable and the row must stay retryable.
    if (expectedAccepted && input.mode === 'live' && r.marked_sent !== true) {
      return {
        ok: false,
        message: 'delivery RPC accepted the event but did not mark the appointment delivered',
        errorClass: 'rpc_parent_not_marked',
      }
    }
    return { ok: true }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err), errorClass: 'rpc_threw' }
  }
}
