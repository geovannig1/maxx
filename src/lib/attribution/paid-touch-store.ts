import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { getAdminClient } from '@/lib/supabase/admin'
import {
  PAID_TOUCH_CONTRACT_VERSION,
  hashPaidTouchToken,
  issuePaidTouchToken,
  verifyPaidTouchToken,
  type NormalizedPaidTouchCapture,
} from './paid-touch-contract'

const PAID_TOUCH_POLICY_VERSION = 1

const rpcResultSchema = z.object({
  touch_id: z.string().uuid(),
  token_id: z.string().uuid(),
  first_touch_id: z.string().uuid(),
  last_touch_id: z.string().uuid(),
  observed_at: z.string().datetime({ offset: true }),
  expires_at: z.string().datetime({ offset: true }),
  identity_complete: z.boolean(),
  contract_version: z.literal(PAID_TOUCH_CONTRACT_VERSION),
  policy_version: z.literal(PAID_TOUCH_POLICY_VERSION),
}).strict()

export type PaidTouchStoreErrorCode =
  | 'PREVIOUS_TOKEN_INVALID'
  | 'CAPTURE_CONFLICT'
  | 'PAID_TOUCH_UNAVAILABLE'
  | 'TOKEN_CONFIGURATION_INVALID'

export class PaidTouchStoreError extends Error {
  constructor(
    public readonly code: PaidTouchStoreErrorCode,
    public readonly status: 400 | 409 | 503,
    message: string,
  ) {
    super(message)
    this.name = 'PaidTouchStoreError'
  }
}

export interface PersistedPaidTouch {
  touchId: string
  tokenId: string
  firstTouchId: string
  lastTouchId: string
  observedAt: string
  expiresAt: string
  identityComplete: boolean
  token: string
}

function captureFingerprint(
  capture: NormalizedPaidTouchCapture,
  previousTokenId: string | null,
): string {
  const canonical = JSON.stringify({
    capture_id: capture.capture_id,
    source: capture.source,
    fbclid: capture.fbclid,
    meta_campaign_id: capture.meta_campaign_id,
    meta_adset_id: capture.meta_adset_id,
    meta_ad_id: capture.meta_ad_id,
    utm_source: capture.utm_source,
    utm_medium: capture.utm_medium,
    utm_campaign: capture.utm_campaign,
    utm_content: capture.utm_content,
    utm_term: capture.utm_term,
    landing_url: capture.landing_url,
    referrer_url: capture.referrer_url,
    previous_token_id: previousTokenId,
    contract_version: capture.contract_version,
    policy_version: PAID_TOUCH_POLICY_VERSION,
  })
  return `sha256:${createHash('sha256').update(canonical, 'utf8').digest('hex')}`
}

function mapRpcError(message: string): PaidTouchStoreError {
  if (/capture collision/i.test(message)) {
    return new PaidTouchStoreError('CAPTURE_CONFLICT', 409, 'The capture id is already bound to different evidence.')
  }
  if (/previous token|token invalid|token expired/i.test(message)) {
    return new PaidTouchStoreError('PREVIOUS_TOKEN_INVALID', 400, 'The previous paid-touch token is invalid.')
  }
  return new PaidTouchStoreError('PAID_TOUCH_UNAVAILABLE', 503, 'Paid-touch storage is unavailable.')
}

export async function persistPaidTouchCapture(
  db: ReturnType<typeof getAdminClient>,
  adAccountId: string,
  capture: NormalizedPaidTouchCapture,
  tokenSecret: string,
): Promise<PersistedPaidTouch> {
  let previousTokenId: string | null = null
  let previousTokenHash: string | null = null
  if (capture.previous_token) {
    const verified = verifyPaidTouchToken(capture.previous_token, tokenSecret)
    if (!verified.ok) {
      throw new PaidTouchStoreError('PREVIOUS_TOKEN_INVALID', 400, 'The previous paid-touch token is invalid.')
    }
    previousTokenId = verified.tokenId
    previousTokenHash = hashPaidTouchToken(capture.previous_token)
  }

  const touchId = randomUUID()
  const tokenId = randomUUID()
  let issuedToken: string
  try {
    issuedToken = issuePaidTouchToken(tokenId, tokenSecret)
  } catch {
    throw new PaidTouchStoreError(
      'TOKEN_CONFIGURATION_INVALID', 503, 'Paid-touch token signing is unavailable.',
    )
  }

  const { data, error } = await db.rpc('capture_paid_touch', {
    p_ad_account_id: adAccountId,
    p_touch_id: touchId,
    p_token_id: tokenId,
    p_capture_id: capture.capture_id,
    p_capture_fingerprint: captureFingerprint(capture, previousTokenId),
    p_token_hash: hashPaidTouchToken(issuedToken),
    p_previous_token_id: previousTokenId,
    p_previous_token_hash: previousTokenHash,
    p_source: capture.source,
    p_fbclid: capture.fbclid,
    p_meta_campaign_id: capture.meta_campaign_id,
    p_meta_adset_id: capture.meta_adset_id,
    p_meta_ad_id: capture.meta_ad_id,
    p_utm_source: capture.utm_source,
    p_utm_medium: capture.utm_medium,
    p_utm_campaign: capture.utm_campaign,
    p_utm_content: capture.utm_content,
    p_utm_term: capture.utm_term,
    p_landing_url: capture.landing_url,
    p_referrer_url: capture.referrer_url,
    p_contract_version: capture.contract_version,
    p_policy_version: PAID_TOUCH_POLICY_VERSION,
  })
  if (error) throw mapRpcError(error.message ?? '')

  const parsed = rpcResultSchema.safeParse(Array.isArray(data) ? data[0] : data)
  if (!parsed.success) {
    throw new PaidTouchStoreError('PAID_TOUCH_UNAVAILABLE', 503, 'Paid-touch storage returned an invalid result.')
  }

  // An exact retry returns the already-committed token id. HMAC issuance is deterministic, so the
  // raw bearer token can be regenerated without ever persisting it in Postgres.
  let committedToken: string
  try {
    committedToken = issuePaidTouchToken(parsed.data.token_id, tokenSecret)
  } catch {
    throw new PaidTouchStoreError(
      'TOKEN_CONFIGURATION_INVALID', 503, 'Paid-touch token signing is unavailable.',
    )
  }
  return {
    touchId: parsed.data.touch_id,
    tokenId: parsed.data.token_id,
    firstTouchId: parsed.data.first_touch_id,
    lastTouchId: parsed.data.last_touch_id,
    observedAt: parsed.data.observed_at,
    expiresAt: parsed.data.expires_at,
    identityComplete: parsed.data.identity_complete,
    token: committedToken,
  }
}

