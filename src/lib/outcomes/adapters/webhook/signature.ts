import { createHmac, timingSafeEqual } from 'node:crypto'
import type { VerifyResult } from '@/lib/outcomes/adapter'

/**
 * Generic outcome webhook signature (ADR-058):
 *
 *   x-maxx-signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, t + "." + raw body)>
 *
 * The timestamp is inside the MAC, so it cannot be moved without the secret. A delivery is accepted
 * only within SIGNATURE_TOLERANCE_SECONDS of the server clock in either direction; replay inside that
 * window is stopped by the delivery ledger, keyed on the digest this function returns.
 */

export const SIGNATURE_HEADER = 'x-maxx-signature'
export const SIGNATURE_TOLERANCE_SECONDS = 5 * 60
const MAX_HEADER_LENGTH = 256
const DIGEST_HEX = /^[0-9a-f]{64}$/i
const UNIX_SECONDS = /^\d{1,12}$/

function digest(secret: string, t: string, rawBody: string): Buffer {
  return createHmac('sha256', secret).update(`${t}.${rawBody}`, 'utf8').digest()
}

/** The header value a sender puts on a delivery. Used by tests and the documentation examples. */
export function signOutcomeWebhook(secret: string, unixSeconds: number, rawBody: string): string {
  return `t=${unixSeconds},v1=${digest(secret, String(unixSeconds), rawBody).toString('hex')}`
}

function parseHeader(header: string): { t: string; v1: string } | null {
  if (header.length > MAX_HEADER_LENGTH) return null
  let t: string | null = null
  let v1: string | null = null
  for (const part of header.split(',')) {
    const eq = part.indexOf('=')
    if (eq < 0) return null
    const key = part.slice(0, eq).trim()
    const value = part.slice(eq + 1).trim()
    if (key === 't' && t === null) t = value
    else if (key === 'v1' && v1 === null) v1 = value
    else return null
  }
  if (t === null || v1 === null || !UNIX_SECONDS.test(t) || !DIGEST_HEX.test(v1)) return null
  return { t, v1: v1.toLowerCase() }
}

/**
 * Verify one delivery. The secret is compared through a fixed-length timing-safe comparison of the
 * decoded digests. Callers verify against a placeholder secret when the source is unknown, so the
 * work done does not reveal whether a source exists.
 */
export function verifyOutcomeWebhookSignature(input: {
  header: string | null | undefined
  rawBody: string
  secret: string
  nowMs?: number
}): VerifyResult {
  if (!input.header) return { ok: false, reason: 'missing' }
  const parsed = parseHeader(input.header)
  if (!parsed) return { ok: false, reason: 'malformed' }
  if (!isFresh(parsed.t, input.nowMs)) return { ok: false, reason: 'stale' }
  const expected = digest(input.secret, parsed.t, input.rawBody)
  const supplied = Buffer.from(parsed.v1, 'hex')
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    return { ok: false, reason: 'mismatch' }
  }
  return { ok: true, deliveryKey: parsed.v1 }
}

/** The pure header checks that need no secret: shape and timestamp tolerance. */
export function checkSignatureHeader(
  header: string | null | undefined,
  nowMs?: number,
): { ok: true } | { ok: false; reason: 'missing' | 'malformed' | 'stale' } {
  if (!header) return { ok: false, reason: 'missing' }
  const parsed = parseHeader(header)
  if (!parsed) return { ok: false, reason: 'malformed' }
  return isFresh(parsed.t, nowMs) ? { ok: true } : { ok: false, reason: 'stale' }
}

function isFresh(t: string, nowMs: number = Date.now()): boolean {
  return Math.abs(Math.floor(nowMs / 1000) - Number(t)) <= SIGNATURE_TOLERANCE_SECONDS
}
