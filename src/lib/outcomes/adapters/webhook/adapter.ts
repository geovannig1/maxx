import type { OutcomeSourceAdapter } from '@/lib/outcomes/adapter'
import { SIGNATURE_HEADER, verifyOutcomeWebhookSignature } from './signature'
import { parseOutcomeWebhookPayload } from './payload'

const ALLOWED_CONFIG_KEYS = new Set(['platformNativeEvents'])

/**
 * The generic signed webhook (ADR-058). Push only: the sender states origin and values on every
 * delivery. A source's non-secret `config.platformNativeEvents` lists conversion events the business
 * already sends to the ad platform for these outcomes (its own pixel or checkout integration), which
 * Maxx then never mirrors.
 */
export const webhookAdapter: OutcomeSourceAdapter = {
  kind: 'webhook',
  capabilities: {
    pull: false,
    push: true,
    backfill: false,
    // A delivery may carry `attribution.paid_touch_token`; the webhook route verifies it and links the
    // outcome to its paid touch (src/lib/outcomes/paid-touch-link.ts). A delivery without one counts
    // as not linked, never as excluded from the cohort.
    carriesToken: true,
    originKnown: true,
    collectedValue: true,
    platformNativeEvents: [],
  },
  validateConfig(_env, config) {
    const unknown = Object.keys(config).filter((key) => !ALLOWED_CONFIG_KEYS.has(key))
    if (unknown.length > 0) return { ok: false, reason: `unknown config keys: ${unknown.join(', ')}` }
    const events = config.platformNativeEvents
    if (events !== undefined && !(Array.isArray(events) && events.every((e) => typeof e === 'string' && e.length > 0))) {
      return { ok: false, reason: 'platformNativeEvents must be a list of event names' }
    }
    return { ok: true, value: undefined }
  },
  verifyPush({ rawBody, headers, secret, nowMs }) {
    return verifyOutcomeWebhookSignature({ header: headers.get(SIGNATURE_HEADER), rawBody, secret, nowMs })
  },
  parsePush(rawBody) {
    const parsed = parseOutcomeWebhookPayload(rawBody)
    return parsed.ok
      ? { ok: true, value: [{ outcome: parsed.outcome, paidTouchToken: parsed.paidTouchToken }] }
      : { ok: false, reason: parsed.reason }
  },
  async health() {
    return { configured: true, detail: 'Push only: configured per source with a signing secret.' }
  },
}
