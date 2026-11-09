import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  SIGNATURE_TOLERANCE_SECONDS,
  signOutcomeWebhook,
  verifyOutcomeWebhookSignature,
} from '@/lib/outcomes/adapters/webhook/signature'

// The documented contract (ADR-058): x-maxx-signature: t=<unix>,v1=<hex HMAC-SHA256(secret, t + "." + body)>.
const SECRET = 'a'.repeat(64)
const BODY = '{"external_id":"order-1"}'
const NOW_MS = Date.parse('2026-11-08T12:00:00Z')
const T = Math.floor(NOW_MS / 1000)

function header(t: number, body = BODY, secret = SECRET): string {
  const v1 = createHmac('sha256', secret).update(`${t}.${body}`, 'utf8').digest('hex')
  return `t=${t},v1=${v1}`
}

describe('outcome webhook signature', () => {
  it('accepts the documented construction computed independently of the signer (good control)', () => {
    const result = verifyOutcomeWebhookSignature({ header: header(T), rawBody: BODY, secret: SECRET, nowMs: NOW_MS })
    expect(result).toEqual({ ok: true, deliveryKey: header(T).split('v1=')[1] })
  })

  it('signs exactly what it verifies', () => {
    expect(signOutcomeWebhook(SECRET, T, BODY)).toBe(header(T))
  })

  it('rejects a signature made with another secret', () => {
    const result = verifyOutcomeWebhookSignature({ header: header(T, BODY, 'b'.repeat(64)), rawBody: BODY, secret: SECRET, nowMs: NOW_MS })
    expect(result).toEqual({ ok: false, reason: 'mismatch' })
  })

  it('rejects a body changed by one byte', () => {
    const result = verifyOutcomeWebhookSignature({ header: header(T), rawBody: `${BODY} `, secret: SECRET, nowMs: NOW_MS })
    expect(result).toEqual({ ok: false, reason: 'mismatch' })
  })

  it('rejects a timestamp changed after signing (the timestamp is inside the MAC)', () => {
    const v1 = header(T).split('v1=')[1]
    const result = verifyOutcomeWebhookSignature({ header: `t=${T + 1},v1=${v1}`, rawBody: BODY, secret: SECRET, nowMs: NOW_MS })
    expect(result).toEqual({ ok: false, reason: 'mismatch' })
  })

  it.each([
    ['five minutes old', T - SIGNATURE_TOLERANCE_SECONDS, true],
    ['five minutes ahead', T + SIGNATURE_TOLERANCE_SECONDS, true],
    ['one second past the tolerance', T - SIGNATURE_TOLERANCE_SECONDS - 1, false],
    ['one second too far ahead', T + SIGNATURE_TOLERANCE_SECONDS + 1, false],
  ])('timestamp %s: accepted=%s', (_label, t, accepted) => {
    const result = verifyOutcomeWebhookSignature({ header: header(t), rawBody: BODY, secret: SECRET, nowMs: NOW_MS })
    expect(result.ok).toBe(accepted)
    if (!accepted) expect(result).toEqual({ ok: false, reason: 'stale' })
  })

  it.each([
    [null, 'missing'],
    ['', 'missing'],
    ['v1=abc', 'malformed'],
    [`t=${T}`, 'malformed'],
    [`t=abc,v1=${'0'.repeat(64)}`, 'malformed'],
    [`t=${T},v1=${'0'.repeat(63)}`, 'malformed'],
    [`t=${T},v1=${'g'.repeat(64)}`, 'malformed'],
    [`t=${T},t=${T},v1=${'0'.repeat(64)}`, 'malformed'],
    [`t=${T},v1=${'0'.repeat(64)},v1=${'1'.repeat(64)}`, 'malformed'],
    [`t=${T},v1=${'0'.repeat(64)},v0=x`, 'malformed'],
    [`t=${T},v1=${'0'.repeat(64)}${' '.repeat(300)}`, 'malformed'],
  ])('rejects header %j as %s', (value, reason) => {
    const result = verifyOutcomeWebhookSignature({ header: value, rawBody: BODY, secret: SECRET, nowMs: NOW_MS })
    expect(result).toEqual({ ok: false, reason })
  })

  it('accepts an upper-case hex digest and keys replay protection on its canonical lower-case form', () => {
    const value = header(T).replace(/v1=([0-9a-f]+)/, (_m, hex: string) => `v1=${hex.toUpperCase()}`)
    const result = verifyOutcomeWebhookSignature({ header: value, rawBody: BODY, secret: SECRET, nowMs: NOW_MS })
    expect(result).toEqual({ ok: true, deliveryKey: header(T).split('v1=')[1] })
  })

  it('tolerates spaces around the comma-separated parts', () => {
    const value = header(T).replace(',', ', ')
    expect(verifyOutcomeWebhookSignature({ header: value, rawBody: BODY, secret: SECRET, nowMs: NOW_MS }).ok).toBe(true)
  })
})
