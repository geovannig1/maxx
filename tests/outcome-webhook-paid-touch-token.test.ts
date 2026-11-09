import { describe, expect, it } from 'vitest'
import { parseOutcomeWebhookPayload } from '@/lib/outcomes/adapters/webhook/payload'
import { getOutcomeAdapter } from '@/lib/outcomes/registry'
import {
  PAID_TOUCH_TOKEN_MAX_LENGTH,
  issuePaidTouchToken,
  verifyPaidTouchToken,
} from '@/lib/attribution/paid-touch-contract'

// a webhook delivery may carry the signed paid-touch token the website received from
// /api/attribution/paid-touch, so a webhook outcome can be linked to its ad click like an Acuity
// booking. The field is strictly the format the contract mints; a malformed value is a normal
// INVALID_PAYLOAD (field named, value never echoed). The token is never stored with the outcome.

const KEY = 'k'.repeat(64)
const TOKEN = issuePaidTouchToken('6f1c2a5e-1b2c-4d3e-8f40-0a1b2c3d4e5f', KEY)
const BASE = {
  external_id: 'order-1', outcome_type: 'sale', status: 'confirmed', currency: 'EUR',
  occurred_at: '2026-11-08T11:58:00Z', origin: 'website',
}
const withToken = (token: unknown) => JSON.stringify({ ...BASE, attribution: { utm_source: 'facebook', paid_touch_token: token } })

describe('webhook paid_touch_token field', () => {
  it('accepts a minted token and returns it beside the outcome, never inside it', () => {
    const parsed = parseOutcomeWebhookPayload(withToken(TOKEN))
    expect(parsed).toMatchObject({ ok: true, paidTouchToken: TOKEN })
    expect(parsed.ok && JSON.stringify(parsed.outcome)).not.toContain(TOKEN)
    expect(parsed.ok && parsed.outcome.attribution.utmSource).toBe('facebook')
  })

  it('treats an absent or null token as no token', () => {
    expect(parseOutcomeWebhookPayload(JSON.stringify(BASE))).toMatchObject({ ok: true, paidTouchToken: null })
    expect(parseOutcomeWebhookPayload(withToken(null))).toMatchObject({ ok: true, paidTouchToken: null })
  })

  it('accepts a well-formed token with a wrong signature: signature checks happen at linking, not here', () => {
    const forged = issuePaidTouchToken('6f1c2a5e-1b2c-4d3e-8f40-0a1b2c3d4e5f', 'x'.repeat(64))
    expect(verifyPaidTouchToken(forged, KEY)).toMatchObject({ ok: false, reason: 'invalid_signature' })
    expect(parseOutcomeWebhookPayload(withToken(forged))).toMatchObject({ ok: true, paidTouchToken: forged })
  })

  it('refuses anything that is not the minted format, naming only the field', () => {
    const bad = [
      '', 'forged', `${TOKEN} `, ` ${TOKEN}`, TOKEN.replace('pt1.', 'pt2.'), `${TOKEN}A`, TOKEN.slice(0, -1),
      TOKEN.replace(/\.[^.]+$/, '.' + '+'.repeat(43)),
      // version nibble 0 is not a uuid the contract mints
      issuePaidTouchToken('6f1c2a5e-1b2c-4d3e-8f40-0a1b2c3d4e5f', KEY).replace('-4d3e-', '-0d3e-'),
      'x'.repeat(PAID_TOUCH_TOKEN_MAX_LENGTH + 1), 12345, { token: TOKEN },
    ]
    for (const value of bad) {
      const parsed = parseOutcomeWebhookPayload(withToken(value))
      expect(parsed, String(value)).toEqual({ ok: false, reason: 'invalid_payload', fields: ['attribution.paid_touch_token'] })
    }
  })

  it('bounds the token length at the minted length', () => {
    expect(TOKEN.length).toBe(PAID_TOUCH_TOKEN_MAX_LENGTH)
  })

  it('the webhook adapter carries the token and declares that it can', () => {
    const webhook = getOutcomeAdapter('webhook')!
    expect(webhook.capabilities.carriesToken).toBe(true)
    expect(webhook.parsePush!(withToken(TOKEN))).toMatchObject({ ok: true, value: [{ paidTouchToken: TOKEN }] })
    expect(webhook.parsePush!(JSON.stringify(BASE))).toMatchObject({ ok: true, value: [{ paidTouchToken: null }] })
  })

  it('control: CSV still cannot carry a token', () => {
    expect(getOutcomeAdapter('csv')!.capabilities.carriesToken).toBe(false)
  })
})
