import { createHmac, randomUUID } from 'node:crypto'
import {
  activeAccountErrorCode,
  activeAccountErrorStatus,
  resolveOnlyActiveAccount,
} from '@/lib/accounts/active-account'
import {
  hashPaidTouchToken,
  normalizePaidTouchCapture,
  verifyPaidTouchToken,
} from '@/lib/attribution/paid-touch-contract'
import {
  PaidEligibilityLedgerError,
  recordPaidCaptureAttempt,
  recordPaidCaptureOutcome,
  recordSchedulerTokenDelivery,
  type PaidCaptureOutcome,
} from '@/lib/attribution/paid-eligibility-ledger'
import {
  PaidTouchStoreError,
  persistPaidTouchCapture,
} from '@/lib/attribution/paid-touch-store'
import { enforceApiRateLimit } from '@/lib/security/api-rate-limit'
import { isKnownAccountAd, paidTouchGlobalLimits } from '@/lib/attribution/paid-touch-guards'
import { clientAddress } from '@/lib/security/client-address'
import { getAdminClient } from '@/lib/supabase/admin'

export const runtime = 'nodejs'

const MAX_CAPTURE_BYTES = 16 * 1024
const TOKEN_SECRET_MIN_BYTES = 32
const RATE_WINDOW_SECONDS = 3600

/**
 * Site-wide ceilings, applied after the per-client limit and only to requests that passed body,
 * schema and account validation (so invalid bodies cannot exhaust them). The per-client key comes from
 * X-Forwarded-For / X-Real-IP, which a script can rotate when the app is not behind a proxy that
 * overwrites them, so the per-client limit alone does not bound total writes. These buckets use one
 * constant actor key. Sizing: one capture per paid landing. At $5,000/day and a $1 link-click cost,
 * an account gets about 5,000 landings a day (~210 an hour), so 2,000 an hour leaves roughly 10x
 * headroom for peaks while bounding forged rows at 48,000 a day. Acknowledgements get twice that,
 * matching the 30:60 per-client ratio. Reaching the cap drops new captures for the rest of the
 * window (telemetry loss); it never touches bookings. Stored rows that never became evidence are
 * pruned after retention by the daily cron (prune_unlinked_paid_touch_rows).
 */
const GLOBAL_RATE_ACTOR = 'site'
// The defaults (2,000 captures / 4,000 acknowledgements an hour) are overridable with
// PAID_TOUCH_GLOBAL_CAPTURES_PER_HOUR / PAID_TOUCH_GLOBAL_ACKS_PER_HOUR; captures for ads not yet synced
// also spend PAID_TOUCH_UNKNOWN_AD_CAPTURES_PER_HOUR (default 200) (paid-touch-guards.ts).

/**
 * Per-token acknowledgement ceiling, keyed on the verified token id and checked before the global
 * bucket. The per-client key can be rotated through X-Forwarded-For, so without this one genuine token
 * replayed from fresh addresses could fill the global acknowledgement bucket alone. A real browser
 * needs one successful acknowledgement per token (it stores `scheduler_acknowledged`, and the ledger
 * write is idempotent per capture attempt); it re-sends only after a failure, on a later DOM or load
 * pass, or from a second open tab. Ten an hour covers those retries while bounding a replayed token
 * to 10 of the 4,000 global units.
 */
const PER_TOKEN_ACK_LIMIT_PER_HOUR = 10

interface PaidTouchRouteConfig {
  allowedOrigins: ReadonlySet<string>
  allowedLandingHosts: readonly string[]
  tokenSecret: string
}

function loadConfig(): PaidTouchRouteConfig | null {
  const tokenSecret = process.env.PAID_TOUCH_TOKEN_SECRET ?? ''
  if (Buffer.byteLength(tokenSecret, 'utf8') < TOKEN_SECRET_MIN_BYTES) return null

  const origins = new Set<string>()
  for (const raw of (process.env.PAID_TOUCH_ALLOWED_ORIGINS ?? '').split(',')) {
    const value = raw.trim()
    if (!value) continue
    try {
      const parsed = new URL(value)
      if (parsed.protocol !== 'https:' || parsed.origin !== value) return null
      origins.add(parsed.origin)
    } catch {
      return null
    }
  }
  const landingHosts = (process.env.PAID_TOUCH_ALLOWED_LANDING_HOSTS ?? '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)
  if (
    origins.size === 0
    || landingHosts.length === 0
    || landingHosts.some((host) => !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(host))
  ) return null

  return { allowedOrigins: origins, allowedLandingHosts: landingHosts, tokenSecret }
}

function allowedRequestOrigin(req: Request, config: PaidTouchRouteConfig): string | null {
  const supplied = req.headers.get('origin')
  if (!supplied) return null
  try {
    const parsed = new URL(supplied)
    if (parsed.origin !== supplied || !config.allowedOrigins.has(parsed.origin)) return null
    return parsed.origin
  } catch {
    return null
  }
}

function withPublicCaptureHeaders(response: Response, origin: string | null): Response {
  response.headers.set('Cache-Control', 'private, no-store')
  response.headers.set('Vary', 'Origin')
  if (origin) {
    response.headers.set('Access-Control-Allow-Origin', origin)
    response.headers.set('Access-Control-Allow-Methods', 'POST, PATCH, OPTIONS')
    response.headers.set('Access-Control-Allow-Headers', 'Content-Type')
  }
  return response
}

function json(
  body: Record<string, unknown>,
  status: number,
  origin: string | null,
): Response {
  return withPublicCaptureHeaders(Response.json(body, { status }), origin)
}

async function readBoundedBody(req: Request): Promise<string | null | 'too_large'> {
  const declared = req.headers.get('content-length')
  if (declared != null) {
    const size = Number(declared)
    if (!Number.isSafeInteger(size) || size < 0) return null
    if (size > MAX_CAPTURE_BYTES) return 'too_large'
  }
  if (!req.body) return null

  const reader = req.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > MAX_CAPTURE_BYTES) {
      await reader.cancel('paid-touch capture exceeds byte limit')
      return 'too_large'
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return null
  }
}

function opaqueRateLimitActor(req: Request, origin: string, secret: string): string {
  const address = clientAddress(req).slice(0, 256)
  return `sha256:${createHmac('sha256', secret).update(`${origin}\n${address}`, 'utf8').digest('hex')}`
}

function requestFingerprint(raw: string, origin: string, secret: string): string {
  return `sha256:${createHmac('sha256', secret).update(`${origin}\n${raw}`, 'utf8').digest('hex')}`
}

function browserCaptureId(input: unknown): string | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  const value = (input as Record<string, unknown>).capture_id
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    ? value.toLowerCase()
    : null
}

async function appendOutcome(args: {
  adAccountId: string
  attemptId: string
  outcome: PaidCaptureOutcome
  reasonCode: string | null
  touchId?: string | null
  tokenId?: string | null
}): Promise<void> {
  await recordPaidCaptureOutcome(getAdminClient(), {
    ...args,
    eventId: randomUUID(),
    touchId: args.touchId ?? null,
    tokenId: args.tokenId ?? null,
  })
}

export async function OPTIONS(req: Request): Promise<Response> {
  const config = loadConfig()
  if (!config) return json({ error: 'Paid-touch capture is not configured.' }, 503, null)
  const origin = allowedRequestOrigin(req, config)
  if (!origin) return json({ error: 'Origin is not allowed.' }, 403, null)
  return withPublicCaptureHeaders(new Response(null, { status: 204 }), origin)
}

export async function POST(req: Request): Promise<Response> {
  const config = loadConfig()
  if (!config) return json({ error: 'Paid-touch capture is not configured.' }, 503, null)
  const origin = allowedRequestOrigin(req, config)
  if (!origin) return json({ error: 'Origin is not allowed.' }, 403, null)

  const mediaType = req.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
  if (mediaType !== 'application/json') {
    return json({ error: 'Content-Type must be application/json.' }, 415, origin)
  }

  const limited = await enforceApiRateLimit({
    bucket: 'paid_touch_capture',
    actorKey: opaqueRateLimitActor(req, origin, config.tokenSecret),
    limit: 30,
    windowSeconds: RATE_WINDOW_SECONDS,
  })
  if (limited) return withPublicCaptureHeaders(limited, origin)

  const active = await resolveOnlyActiveAccount(getAdminClient())
  if (!active.ok) {
    return json({
      error: 'Paid-touch capture requires exactly one active ad account.',
      code: activeAccountErrorCode(active.reason),
    }, activeAccountErrorStatus(active.reason), origin)
  }

  const raw = await readBoundedBody(req)
  if (raw === 'too_large') return json({ error: 'Paid-touch capture is too large.' }, 413, origin)
  if (raw == null) return json({ error: 'Invalid paid-touch capture.' }, 400, origin)
  let input: unknown
  try {
    input = JSON.parse(raw)
  } catch {
    input = null
  }
  if (input === null) {
    return json({ error: 'Invalid paid-touch capture.' }, 400, origin)
  }

  let capture
  try {
    capture = normalizePaidTouchCapture(input, config.allowedLandingHosts)
  } catch {
    return json({ error: 'Invalid paid-touch capture.' }, 400, origin)
  }

  // An ad id the account has not synced is either a new launch (since the last sync) or forged. It is
  // kept, so a new ad's first landings are not lost, but first spends a separate smaller bucket before
  // any write, so forged ids cannot fill the main capture budget.
  if (capture.meta_ad_id) {
    let known: boolean
    try {
      known = await isKnownAccountAd(getAdminClient(), active.account.id, capture.meta_ad_id)
    } catch {
      console.error('[paid-touch] known-ad lookup failed')
      return json({ error: 'Paid-touch capture failed.', code: 'PAID_TOUCH_UNAVAILABLE' }, 503, origin)
    }
    if (!known) {
      const unknownAdLimited = await enforceApiRateLimit({
        bucket: 'paid_touch_capture_unknown_ad',
        actorKey: GLOBAL_RATE_ACTOR,
        limit: paidTouchGlobalLimits().unknownAdCaptures,
        windowSeconds: RATE_WINDOW_SECONDS,
      })
      if (unknownAdLimited) return withPublicCaptureHeaders(unknownAdLimited, origin)
    }
  }

  // The site-wide budget is spent only by requests that passed body, schema and account checks, so
  // malformed bodies from rotating addresses cannot fill it and lock out real visitors.
  const globallyLimited = await enforceApiRateLimit({
    bucket: 'paid_touch_capture_global',
    actorKey: GLOBAL_RATE_ACTOR,
    limit: paidTouchGlobalLimits().captures,
    windowSeconds: RATE_WINDOW_SECONDS,
  })
  if (globallyLimited) return withPublicCaptureHeaders(globallyLimited, origin)

  // This is an audit trail of structurally valid public submissions, not an exhaustive paid-landing
  // denominator. A browser may forge a valid-looking body; policy-v3 remains blocked until a
  // separately authenticated source can enumerate every eligible landing.
  let attemptId: string
  try {
    const attempt = await recordPaidCaptureAttempt(getAdminClient(), {
      adAccountId: active.account.id,
      attemptId: randomUUID(),
      browserCaptureId: browserCaptureId(input),
      requestFingerprint: requestFingerprint(raw, origin, config.tokenSecret),
    })
    attemptId = attempt.attemptId
  } catch {
    console.error('[paid-touch] capture audit write failed')
    return json({ error: 'Paid-touch capture failed.', code: 'PAID_ELIGIBILITY_LEDGER_UNAVAILABLE' }, 503, origin)
  }

  try {
    const stored = await persistPaidTouchCapture(
      getAdminClient(), active.account.id, capture, config.tokenSecret,
    )
    await appendOutcome({
      adAccountId: active.account.id,
      attemptId,
      outcome: 'touch_persisted',
      reasonCode: null,
      touchId: stored.touchId,
      tokenId: stored.tokenId,
    })
    await appendOutcome({
      adAccountId: active.account.id,
      attemptId,
      outcome: 'token_response_issued',
      reasonCode: null,
      touchId: stored.touchId,
      tokenId: stored.tokenId,
    })
    return json({
      data: {
        token: stored.token,
        expires_at: stored.expiresAt,
        identity_complete: stored.identityComplete,
      },
      conversion_sent: false,
    }, 200, origin)
  } catch (error) {
    if (error instanceof PaidTouchStoreError) {
      console.error('[paid-touch] governed capture rejected', { code: error.code })
      const outcome: PaidCaptureOutcome = error.code === 'PREVIOUS_TOKEN_INVALID'
        ? 'rejected_previous_token'
        : error.code === 'CAPTURE_CONFLICT' ? 'capture_conflict' : 'storage_failed'
      try {
        await appendOutcome({
          adAccountId: active.account.id,
          attemptId,
          outcome,
          reasonCode: error.code.toLowerCase(),
        })
      } catch {
        return json({ error: 'Paid-touch capture failed.', code: 'PAID_ELIGIBILITY_LEDGER_UNAVAILABLE' }, 503, origin)
      }
      return json({ error: 'Paid-touch capture was rejected.', code: error.code }, error.status, origin)
    }
    if (error instanceof PaidEligibilityLedgerError) {
      console.error('[paid-touch] eligibility evidence write failed')
      return json({ error: 'Paid-touch capture failed.', code: 'PAID_ELIGIBILITY_LEDGER_UNAVAILABLE' }, 503, origin)
    }
    try {
      await appendOutcome({
        adAccountId: active.account.id, attemptId, outcome: 'storage_failed', reasonCode: 'unexpected_failure',
      })
    } catch {
      // The missing terminal event is itself visible to the manifest as an unresolved attempt.
    }
    console.error('[paid-touch] unexpected capture failure')
    return json({ error: 'Paid-touch capture failed.', code: 'PAID_TOUCH_UNAVAILABLE' }, 503, origin)
  }
}

export async function PATCH(req: Request): Promise<Response> {
  const config = loadConfig()
  if (!config) return json({ error: 'Paid-touch capture is not configured.' }, 503, null)
  const origin = allowedRequestOrigin(req, config)
  if (!origin) return json({ error: 'Origin is not allowed.' }, 403, null)
  const mediaType = req.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
  if (mediaType !== 'application/json') {
    return json({ error: 'Content-Type must be application/json.' }, 415, origin)
  }

  const limited = await enforceApiRateLimit({
    bucket: 'paid_touch_delivery_ack',
    actorKey: opaqueRateLimitActor(req, origin, config.tokenSecret),
    limit: 60,
    windowSeconds: RATE_WINDOW_SECONDS,
  })
  if (limited) return withPublicCaptureHeaders(limited, origin)
  const active = await resolveOnlyActiveAccount(getAdminClient())
  if (!active.ok) return json({ error: 'Paid-touch delivery acknowledgement is unavailable.' }, 503, origin)
  const raw = await readBoundedBody(req)
  if (raw === 'too_large') return json({ error: 'Paid-touch acknowledgement is too large.' }, 413, origin)
  if (!raw) return json({ error: 'Invalid paid-touch acknowledgement.' }, 400, origin)
  let input: unknown
  try { input = JSON.parse(raw) } catch { return json({ error: 'Invalid paid-touch acknowledgement.' }, 400, origin) }
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return json({ error: 'Invalid paid-touch acknowledgement.' }, 400, origin)
  }
  const body = input as Record<string, unknown>
  const captureId = browserCaptureId({ capture_id: body.capture_id })
  const token = typeof body.token === 'string' ? body.token : ''
  const verified = verifyPaidTouchToken(token, config.tokenSecret)
  if (!captureId || body.delivery_status !== 'scheduler_decorated' || !verified.ok) {
    return json({ error: 'Invalid paid-touch acknowledgement.' }, 400, origin)
  }
  // Runs after verification (forged tokens cannot reach it) and before the site-wide bucket, so a
  // replayed token stops spending global units once it hits its own limit.
  const tokenLimited = await enforceApiRateLimit({
    bucket: 'paid_touch_delivery_ack_token',
    actorKey: verified.tokenId,
    limit: PER_TOKEN_ACK_LIMIT_PER_HOUR,
    windowSeconds: RATE_WINDOW_SECONDS,
  })
  if (tokenLimited) return withPublicCaptureHeaders(tokenLimited, origin)
  // As for captures, only a validated acknowledgement spends the site-wide budget.
  const globallyLimited = await enforceApiRateLimit({
    bucket: 'paid_touch_delivery_ack_global',
    actorKey: GLOBAL_RATE_ACTOR,
    limit: paidTouchGlobalLimits().acks,
    windowSeconds: RATE_WINDOW_SECONDS,
  })
  if (globallyLimited) return withPublicCaptureHeaders(globallyLimited, origin)
  try {
    await recordSchedulerTokenDelivery(getAdminClient(), {
      adAccountId: active.account.id,
      eventId: randomUUID(),
      browserCaptureId: captureId,
      tokenId: verified.tokenId,
      tokenHash: hashPaidTouchToken(token),
      deliveryStatus: 'scheduler_decorated',
    })
    return json({ ok: true }, 200, origin)
  } catch {
    return json({ error: 'Paid-touch acknowledgement failed.' }, 503, origin)
  }
}
