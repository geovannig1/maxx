import 'server-only'
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'

export const PAID_TOUCH_CONTRACT_VERSION = 1
export const PAID_TOUCH_TOKEN_VERSION = 'pt1'

const boundedText = (max: number) => z.string().trim().min(1).max(max).regex(/^[^\u0000-\u001f\u007f]+$/)
const nullableText = (max: number) => boundedText(max).nullable().optional().transform((value) => value ?? null)
const nullableMetaId = z.string().trim().regex(/^\d{1,32}$/).nullable().optional().transform((value) => value ?? null)

const captureSchema = z.object({
  capture_id: z.string().uuid(),
  source: z.literal('meta'),
  fbclid: nullableText(1024),
  meta_campaign_id: nullableMetaId,
  meta_adset_id: nullableMetaId,
  meta_ad_id: nullableMetaId,
  utm_source: z.enum(['meta', 'facebook', 'instagram']),
  utm_medium: z.literal('paid_social'),
  utm_campaign: nullableText(512),
  utm_content: nullableText(512),
  utm_term: nullableText(512),
  landing_url: boundedText(2048),
  referrer_url: nullableText(2048),
  previous_token: nullableText(512),
}).strict().superRefine((value, ctx) => {
  if (!value.fbclid && !value.meta_campaign_id && !value.meta_adset_id && !value.meta_ad_id) {
    ctx.addIssue({ code: 'custom', message: 'A Meta click id or immutable Meta entity id is required.' })
  }
})

export interface NormalizedPaidTouchCapture {
  capture_id: string
  source: 'meta'
  fbclid: string | null
  meta_campaign_id: string | null
  meta_adset_id: string | null
  meta_ad_id: string | null
  utm_source: 'meta' | 'facebook' | 'instagram'
  utm_medium: 'paid_social'
  utm_campaign: string | null
  utm_content: string | null
  utm_term: string | null
  landing_url: string
  referrer_url: string | null
  previous_token: string | null
  identity_complete: boolean
  contract_version: typeof PAID_TOUCH_CONTRACT_VERSION
}

function normalizeHttpUrl(value: string, allowedHosts?: ReadonlySet<string>): string {
  const url = new URL(value)
  if (url.protocol !== 'https:') throw new Error('Paid-touch URLs must use HTTPS.')
  if (url.username || url.password) throw new Error('Paid-touch URLs cannot contain credentials.')
  const host = url.hostname.toLowerCase()
  if (allowedHosts && !allowedHosts.has(host)) throw new Error('Paid-touch landing host is not allowed.')
  url.hostname = host
  url.port = ''
  url.search = ''
  url.hash = ''
  const normalized = url.toString()
  if (Buffer.byteLength(normalized, 'utf8') > 2048) throw new Error('Paid-touch URL is too large.')
  return normalized
}

export function normalizePaidTouchCapture(
  input: unknown,
  allowedLandingHosts: readonly string[],
): NormalizedPaidTouchCapture {
  const parsed = captureSchema.parse(input)
  const hosts = new Set(allowedLandingHosts.map((host) => host.trim().toLowerCase()).filter(Boolean))
  if (hosts.size === 0) throw new Error('No paid-touch landing host is configured.')
  const ids = [parsed.meta_campaign_id, parsed.meta_adset_id, parsed.meta_ad_id]

  return {
    ...parsed,
    landing_url: normalizeHttpUrl(parsed.landing_url, hosts),
    referrer_url: parsed.referrer_url ? normalizeHttpUrl(parsed.referrer_url) : null,
    identity_complete: ids.every((id) => id !== null),
    contract_version: PAID_TOUCH_CONTRACT_VERSION,
  }
}

function requireTokenSecret(secret: string): void {
  if (Buffer.byteLength(secret, 'utf8') < 32) {
    throw new Error('PAID_TOUCH_TOKEN_SECRET must contain at least 32 UTF-8 bytes.')
  }
}

function tokenMessage(tokenId: string): string {
  const id = z.string().uuid().parse(tokenId)
  return `${PAID_TOUCH_TOKEN_VERSION}.${id}`
}

export function issuePaidTouchToken(tokenId: string, secret: string): string {
  requireTokenSecret(secret)
  const message = tokenMessage(tokenId)
  const signature = createHmac('sha256', secret).update(message, 'utf8').digest('base64url')
  return `${message}.${signature}`
}

/** The exact shape `issuePaidTouchToken` mints: `pt1.<uuid>.<43-character base64url HMAC>`. */
export const PAID_TOUCH_TOKEN_PATTERN = /^pt1\.([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.([A-Za-z0-9_-]{43})$/i
export const PAID_TOUCH_TOKEN_MAX_LENGTH = 84

export type PaidTouchTokenVerification =
  | { ok: true; tokenId: string }
  | { ok: false; reason: 'malformed' | 'invalid_signature' | 'secret_invalid' }

/** The longest rotation grace window for the replaced paid-touch secret, ahead of now. */
export const PAID_TOUCH_PREVIOUS_SECRET_MAX_GRACE_MS = 7 * 86_400_000
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/

/**
 * The replaced PAID_TOUCH_TOKEN_SECRET while its rotation grace window is open, else null. It only
 * VERIFIES tokens minted before the switch; nothing is signed with it. The window ends at
 * PAID_TOUCH_TOKEN_PREVIOUS_SECRET_UNTIL and may reach at most 7 days ahead: a missing, unreadable or
 * farther end, or a secret under 32 bytes, turns it off (fail closed).
 */
export function paidTouchPreviousSecret(
  env: Record<string, string | undefined> = process.env,
  nowMs: number = Date.now(),
): string | null {
  const secret = env.PAID_TOUCH_TOKEN_PREVIOUS_SECRET ?? ''
  const until = env.PAID_TOUCH_TOKEN_PREVIOUS_SECRET_UNTIL?.trim() ?? ''
  if (Buffer.byteLength(secret, 'utf8') < 32 || !ISO_INSTANT.test(until)) return null
  const untilMs = Date.parse(until)
  if (!Number.isFinite(untilMs) || untilMs <= nowMs || untilMs - nowMs > PAID_TOUCH_PREVIOUS_SECRET_MAX_GRACE_MS) return null
  return secret
}

function signatureMatches(secret: string, message: string, supplied: Buffer): boolean {
  const expected = createHmac('sha256', secret).update(message, 'utf8').digest()
  return supplied.length === expected.length && timingSafeEqual(supplied, expected)
}

/**
 * Verify a token against the current secret and, during a rotation grace window, the replaced one
 * (`previousSecret`, by default read from the environment: paidTouchPreviousSecret). Both comparisons
 * are constant-time over fixed-length digests.
 */
export function verifyPaidTouchToken(
  token: string,
  secret: string,
  previousSecret: string | null = paidTouchPreviousSecret(),
): PaidTouchTokenVerification {
  try {
    requireTokenSecret(secret)
  } catch {
    return { ok: false, reason: 'secret_invalid' }
  }
  const match = PAID_TOUCH_TOKEN_PATTERN.exec(token)
  if (!match) return { ok: false, reason: 'malformed' }
  const tokenId = match[1].toLowerCase()
  const message = `${PAID_TOUCH_TOKEN_VERSION}.${tokenId}`
  let supplied: Buffer
  try {
    supplied = Buffer.from(match[2], 'base64url')
  } catch {
    return { ok: false, reason: 'malformed' }
  }
  const current = signatureMatches(secret, message, supplied)
  const previous = previousSecret !== null && previousSecret !== secret
    && Buffer.byteLength(previousSecret, 'utf8') >= 32 && signatureMatches(previousSecret, message, supplied)
  if (!current && !previous) return { ok: false, reason: 'invalid_signature' }
  return { ok: true, tokenId }
}

export function hashPaidTouchToken(token: string): string {
  return `sha256:${createHash('sha256').update(token, 'utf8').digest('hex')}`
}

