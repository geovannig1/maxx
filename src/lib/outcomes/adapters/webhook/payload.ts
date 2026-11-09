import { z } from 'zod'
import { listOutcomeAdapters } from '@/lib/outcomes/registry'
import type { NormalizedOutcome } from '@/lib/outcomes/adapter'
import { OUTCOME_STATUSES, OUTCOME_TYPES } from '@/lib/outcomes/model'
import { PAID_TOUCH_TOKEN_MAX_LENGTH, PAID_TOUCH_TOKEN_PATTERN } from '@/lib/attribution/paid-touch-contract'

/**
 * The generic outcome webhook body (ADR-058): one outcome per delivery, the source's full current
 * state for that outcome. Unknown keys are rejected so a misspelt field is never silently dropped.
 *
 * Money is an exact decimal STRING ("120.50"): a JSON number cannot promise exactness. An absent or
 * null value means "not observed" and is stored as NULL; "0" is an observed zero.
 */

const ISO_CURRENCIES: ReadonlySet<string> = new Set(Intl.supportedValuesOf('currency'))
const DECIMAL = /^(0|[1-9]\d{0,14})(\.\d{1,6})?$/
/** The sender's browser-pixel event id: ASCII letters, digits and . _ : -, at most 100 characters, and
 *  never a prefix Maxx derives itself (`maxx-`, or an adapter's `derivedEventIdPrefix`), so two
 *  outcomes can never share an id. The database CHECK on outcomes.conversion_event_id agrees. */
const EVENT_ID = /^[A-Za-z0-9._:-]{1,100}$/

function isReservedEventId(id: string): boolean {
  // Read at parse time, never at module load: the registry imports this adapter.
  const prefixes = ['maxx-', ...listOutcomeAdapters().flatMap((adapter) =>
    adapter.capabilities.derivedEventIdPrefix ? [adapter.capabilities.derivedEventIdPrefix] : [])]
  const lower = id.toLowerCase()
  return prefixes.some((prefix) => lower.startsWith(prefix.toLowerCase()))
}

const decimal = z.string().regex(DECIMAL)
const text = (max: number) => z.string().min(1).max(max)
const optionalText = (max: number) => text(max).nullable().optional()
const instant = z.iso.datetime({ offset: true })

const attribution = z.strictObject({
  fbclid: optionalText(512),
  fbc: optionalText(600),
  fbp: optionalText(256),
  gclid: optionalText(512),
  utm_source: optionalText(512),
  utm_medium: optionalText(512),
  utm_campaign: optionalText(512),
  utm_content: optionalText(512),
  utm_term: optionalText(512),
  landing_page: optionalText(2048),
  referrer: optionalText(2048),
  // The signed token /api/attribution/paid-touch gave the website for the ad click. Only the minted
  // shape passes here; its signature, expiry and timing are checked when the outcome is linked.
  paid_touch_token: z.string().max(PAID_TOUCH_TOKEN_MAX_LENGTH).regex(PAID_TOUCH_TOKEN_PATTERN).nullable().optional(),
})

const customer = z.strictObject({
  email: optionalText(320),
  phone: optionalText(64),
  first_name: optionalText(256),
  last_name: optionalText(256),
})

export const outcomeWebhookPayloadSchema = z.strictObject({
  external_id: z.string().min(1).max(256).refine((s) => s.trim() === s),
  outcome_type: z.enum(OUTCOME_TYPES),
  outcome_label: optionalText(256),
  status: z.enum(OUTCOME_STATUSES),
  currency: z.string().regex(/^[A-Z]{3}$/).refine((c) => ISO_CURRENCIES.has(c)),
  gross_value: decimal.nullable().optional(),
  collected_value: decimal.nullable().optional(),
  occurred_at: instant,
  fulfilment_at: instant.nullable().optional(),
  fulfilment_status: z.enum(['scheduled', 'fulfilled', 'no_show']).nullable().optional(),
  origin: z.enum(['website', 'staff_or_manual', 'unknown']),
  attribution: attribution.optional(),
  customer: customer.optional(),
  event_id: z.string().regex(EVENT_ID).refine((id) => !isReservedEventId(id)).optional(),
  updated_at: instant.optional(),
})

export type OutcomeWebhookPayload = z.infer<typeof outcomeWebhookPayloadSchema>

export type ParsedOutcomePayload =
  /** `paidTouchToken` travels beside the outcome, never inside it: the outcome (and its stored raw
   *  copy) never holds the token; the link keeps only its hash. */
  | { ok: true; outcome: NormalizedOutcome; paidTouchToken: string | null }
  | { ok: false; reason: 'invalid_json' | 'invalid_payload'; fields: string[] }

/** Parse and normalize one delivery. A rejection names the offending fields, never their values. */
export function parseOutcomeWebhookPayload(rawBody: string): ParsedOutcomePayload {
  let json: unknown
  try {
    json = JSON.parse(rawBody)
  } catch {
    return { ok: false, reason: 'invalid_json', fields: [] }
  }
  const parsed = outcomeWebhookPayloadSchema.safeParse(json)
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((issue) => issue.path.join('.')))]
    return { ok: false, reason: 'invalid_payload', fields }
  }
  return { ok: true, outcome: normalize(parsed.data), paidTouchToken: parsed.data.attribution?.paid_touch_token ?? null }
}

function normalize(p: OutcomeWebhookPayload): NormalizedOutcome {
  const a = p.attribution ?? {}
  const c = p.customer ?? {}
  return {
    externalId: p.external_id,
    outcomeType: p.outcome_type,
    outcomeLabel: p.outcome_label ?? null,
    status: p.status,
    currency: p.currency,
    grossValue: p.gross_value ?? null,
    collectedValue: p.collected_value ?? null,
    occurredAt: p.occurred_at,
    fulfilmentAt: p.fulfilment_at ?? null,
    fulfilmentStatus: p.fulfilment_status ?? null,
    origin: p.origin,
    attribution: {
      fbclid: a.fbclid ?? null,
      fbc: a.fbc ?? null,
      fbp: a.fbp ?? null,
      gclid: a.gclid ?? null,
      utmSource: a.utm_source ?? null,
      utmMedium: a.utm_medium ?? null,
      utmCampaign: a.utm_campaign ?? null,
      utmContent: a.utm_content ?? null,
      utmTerm: a.utm_term ?? null,
      landingPage: a.landing_page ?? null,
      referrer: a.referrer ?? null,
    },
    customer: {
      email: c.email ?? null,
      phone: c.phone ?? null,
      firstName: c.first_name ?? null,
      lastName: c.last_name ?? null,
    },
    conversionEventId: p.event_id ?? null,
    sourceUpdatedAt: p.updated_at ?? null,
  }
}
