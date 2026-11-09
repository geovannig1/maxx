import { randomBytes } from 'node:crypto'
import { getAdminClient } from '@/lib/supabase/admin'
import { apiErrorResponse } from '@/lib/security/api-error'
import { enforceApiRateLimit } from '@/lib/security/api-rate-limit'
import { readBoundedBody } from '@/lib/security/bounded-body'
import { preAuthRateLimit } from '@/lib/security/preauth-limit'
import {
  SIGNATURE_HEADER,
  checkSignatureHeader,
  verifyOutcomeWebhookSignature,
} from '@/lib/outcomes/adapters/webhook/signature'
import { parseOutcomeWebhookPayload } from '@/lib/outcomes/adapters/webhook/payload'
import {
  claimWebhookDelivery,
  releaseWebhookDelivery,
  resolveWebhookSource,
  type ResolvedWebhookSource,
} from '@/lib/outcomes/adapters/webhook/sources'
import { OutcomeEventIdChangedError, upsertNormalizedOutcome } from '@/lib/outcomes/store'
import { linkOutcomePaidTouch } from '@/lib/outcomes/paid-touch-link'
import { sendOutcomeConversion } from '@/lib/conversions/outcome-conversions'
import { businessLocaleFromAccount } from '@/config/business-config'
import { exceedsOutcomeMoneyCeiling } from '@/lib/outcomes/money-ceiling'

export const runtime = 'nodejs'

// POST /api/outcomes/webhook/<source id> — any system pushes one outcome per delivery (ADR-058).
//
// Order matters:
//   0. a per-address, in-process limit (no database, no HMAC) so an unauthenticated flood is cheap;
//   1. size bound, then the secret-free header checks (shape, ±5-minute timestamp) — these reveal
//      nothing about whether the source exists;
//   2. source lookup and HMAC verification. An unknown, disabled or secretless source is verified
//      against a placeholder secret, and every failure at this step — including a wrong signature
//      on a real source — returns the same 404, so neither the status nor the work done reveals
//      whether a source id exists;
//   3. per-source rate limit (only signed deliveries count against it), payload validation, the money
//      ceiling (OUTCOME_MONEY_CEILING) and the account currency — all stable 4xx before any write;
//   4. replay claim BEFORE the write, so a replayed old state can never overwrite a newer one; the
//      claim is released when the write fails so the sender's retry is not refused as a replay.
//   5. paid-touch linking, on an applied write: a valid `attribution.paid_touch_token` links the
//      outcome to its ad click; an invalid, expired or foreign token is ignored with a recorded reason
//      (src/lib/outcomes/paid-touch-link.ts). Only a malformed token is an INVALID_PAYLOAD (step 3). The
//      response carries the status (`paid_touch`), never the reason; linking never fails the delivery.
//   6. conversions: only on an outcome's FIRST confirmation (new, or pending → confirmed). A
//      reschedule, any change to a confirmed outcome, a cancellation or a refund never sends; a failed
//      first send is retried by the nightly sweep. The outcome is durable before Meta is contacted, and
//      a conversion failure never fails the delivery.
// Database text never reaches the response (api-error.ts).

const MAX_BODY_BYTES = 32 * 1024
const RATE_LIMIT_PER_MINUTE = 600
/** Per client address, per server instance, checked before the source lookup (preauth-limit.ts). */
const PRE_AUTH_LIMIT_PER_MINUTE = 600
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ROUTE = 'outcomes/webhook'
// Never a real secret: random per process, so it cannot verify anything a sender could produce.
const PLACEHOLDER_SECRET = randomBytes(32).toString('hex')

async function readAccountCurrency(db: ReturnType<typeof getAdminClient>, adAccountId: string): Promise<string | null> {
  const { data, error } = await db.from('ad_accounts').select('currency').eq('id', adAccountId).maybeSingle()
  if (error) throw new Error(`ad account currency lookup failed: ${error.message}`)
  const currency = (data as { currency?: unknown } | null)?.currency
  return typeof currency === 'string' ? currency.trim() : null
}

const notFound = () => Response.json({ error: 'Not found', code: 'NOT_FOUND' }, { status: 404 })
const reject = (status: number, code: string, error: string, extra: Record<string, unknown> = {}) =>
  Response.json({ error, code, ...extra }, { status })

export async function POST(req: Request, { params }: { params: Promise<{ sourceId: string }> }) {
  const { sourceId } = await params
  if (!UUID.test(sourceId)) return notFound()
  // Before any lookup or HMAC: an unauthenticated flood from one address costs no query.
  const preAuth = preAuthRateLimit(req, 'outcome-webhook', PRE_AUTH_LIMIT_PER_MINUTE)
  if (preAuth) return preAuth

  const body = await readBoundedBody(req, MAX_BODY_BYTES)
  if (!body.ok) {
    return body.error === 'too_large'
      ? reject(413, 'BODY_TOO_LARGE', 'Body too large')
      : reject(400, 'BODY_UNREADABLE', 'Body unreadable')
  }
  const header = req.headers.get(SIGNATURE_HEADER)
  const shape = checkSignatureHeader(header)
  if (!shape.ok) {
    return shape.reason === 'stale'
      ? reject(401, 'SIGNATURE_STALE', 'Signature timestamp outside the allowed window')
      : reject(401, 'SIGNATURE_MALFORMED', 'Missing or malformed signature header')
  }

  const db = getAdminClient()
  let source: ResolvedWebhookSource | null
  try {
    source = await resolveWebhookSource(db, sourceId.toLowerCase())
  } catch (error) {
    return apiErrorResponse(ROUTE, 'SOURCE_LOOKUP_FAILED', error, 503)
  }
  const verified = verifyOutcomeWebhookSignature({
    header, rawBody: body.rawBody, secret: source?.secret ?? PLACEHOLDER_SECRET,
  })
  if (!source || !verified.ok) return notFound()

  const limited = await enforceApiRateLimit({
    bucket: 'outcome-webhook', actorKey: source.sourceId, limit: RATE_LIMIT_PER_MINUTE, windowSeconds: 60,
  })
  if (limited) return limited

  const parsed = parseOutcomeWebhookPayload(body.rawBody)
  if (!parsed.ok) return reject(400, 'INVALID_PAYLOAD', 'Invalid payload', { fields: parsed.fields })
  const aboveCeiling = (['gross_value', 'collected_value'] as const).filter((field) =>
    exceedsOutcomeMoneyCeiling(field === 'gross_value' ? parsed.outcome.grossValue : parsed.outcome.collectedValue))
  if (aboveCeiling.length > 0) {
    return reject(422, 'VALUE_ABOVE_CEILING', 'Value above the configured outcome money ceiling', { fields: aboveCeiling })
  }
  // One outcome in another currency would make every total for the account refuse to sum. Refuse it
  // here with a stable 4xx (the sender must fix it; a retry cannot succeed), before any claim or write.
  let accountCurrencyCode: string | null
  try {
    accountCurrencyCode = await readAccountCurrency(db, source.adAccountId)
  } catch (error) {
    return apiErrorResponse(ROUTE, 'SOURCE_LOOKUP_FAILED', error, 503)
  }
  if (accountCurrencyCode === null || parsed.outcome.currency !== accountCurrencyCode) {
    return reject(422, 'CURRENCY_NOT_ACCOUNT', 'currency must be the ad account currency', { fields: ['currency'] })
  }

  let claimed: boolean
  try {
    claimed = await claimWebhookDelivery(db, source.sourceId, verified.deliveryKey)
  } catch (error) {
    return apiErrorResponse(ROUTE, 'REPLAY_CHECK_FAILED', error, 503)
  }
  if (!claimed) return reject(409, 'REPLAY', 'This delivery was already received')

  let written: Awaited<ReturnType<typeof upsertNormalizedOutcome>>
  try {
    written = await upsertNormalizedOutcome(db, parsed.outcome, {
      adAccountId: source.adAccountId,
      sourceId: source.sourceId,
      // The account's zone, checked against configuration AFTER the signature check (so a probe
      // learns nothing): a disagreement fails the write (503, retried) rather than storing a
      // business date in the wrong zone.
      timezone: businessLocaleFromAccount({ timezone_name: source.timezone || null }).timezone,
      observationSource: 'webhook',
    })
  } catch (error) {
    try {
      await releaseWebhookDelivery(db, source.sourceId, verified.deliveryKey)
    } catch (releaseError) {
      console.error(`[api ${ROUTE}] claim release failed:`, releaseError instanceof Error ? releaseError.message : releaseError)
    }
    if (error instanceof OutcomeEventIdChangedError) {
      return reject(409, 'EVENT_ID_CHANGED', 'The conversion event id of this outcome cannot change')
    }
    return apiErrorResponse(ROUTE, 'OUTCOME_WRITE_FAILED', error, 503)
  }
  if (!written.applied) {
    // Older than the stored state (`updated_at`): accepted and recorded as seen, never applied.
    return Response.json({
      ok: true, applied: false, reason: 'older_than_stored', outcome_id: written.outcomeId,
      external_id: parsed.outcome.externalId, conversion: 'not-applicable', paid_touch: 'not-applicable',
    })
  }

  const paidTouch = await linkOutcomePaidTouch(db, {
    adAccountId: source.adAccountId, outcomeId: written.outcomeId, outcome: parsed.outcome, token: parsed.paidTouchToken,
  })
  if (!paidTouch.recorded) console.error(`[api ${ROUTE}] paid link evaluation was not recorded (${paidTouch.status})`)

  let conversion = 'not-applicable'
  const firstConfirmation = parsed.outcome.status === 'confirmed'
    && (written.previousStatus === null || written.previousStatus === 'pending')
  if (firstConfirmation) {
    const sent = await sendOutcomeConversion(db, written.outcomeId)
    conversion = sent.status === 'skipped' ? `skipped-${sent.skip}` : sent.status
  }
  return Response.json({
    ok: true, applied: true, outcome_id: written.outcomeId, external_id: parsed.outcome.externalId, conversion,
    paid_touch: paidTouch.status,
  })
}
