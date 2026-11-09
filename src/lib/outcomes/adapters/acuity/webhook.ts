import { createHmac, timingSafeEqual } from 'crypto'

// Acuity webhook verification + parsing (pure, unit-tested). Acuity signs each delivery with
// HMAC-SHA256(base64) over the RAW request body, keyed by the account API KEY, in the
// `x-acuity-signature` header. The body is form-encoded {action, id, calendarID, appointmentTypeID};
// full booking details come from a follow-up GET /appointments/{id}.

/** base64 HMAC-SHA256 of the raw body under the API key — the value Acuity puts in x-acuity-signature. */
export function computeAcuitySignature(rawBody: string, apiKey: string): string {
  return createHmac('sha256', apiKey).update(rawBody, 'utf8').digest('base64')
}

/** Constant-time compare of the delivered signature against the expected one. False on any mismatch. */
export function verifyAcuitySignature(rawBody: string, signature: string | null | undefined, apiKey: string): boolean {
  if (!signature) return false
  const expected = Buffer.from(computeAcuitySignature(rawBody, apiKey))
  const got = Buffer.from(signature)
  if (expected.length !== got.length) return false
  return timingSafeEqual(expected, got)
}

export interface AcuityWebhookBody {
  action: string
  id: string
  calendarID?: string
  appointmentTypeID?: string
}

export function parseWebhookBody(rawBody: string): AcuityWebhookBody {
  const p = new URLSearchParams(rawBody)
  return {
    action: p.get('action') ?? '',
    id: p.get('id') ?? '',
    calendarID: p.get('calendarID') ?? undefined,
    appointmentTypeID: p.get('appointmentTypeID') ?? undefined,
  }
}

/** True for the appointment lifecycle actions we (re-)ingest. Tolerates both the bare form
 *  ("scheduled") and the dotted form ("appointment.scheduled"); excludes order.completed. */
export function isAppointmentAction(action: string): boolean {
  return /(scheduled|rescheduled|canceled|changed)$/i.test(action)
}
