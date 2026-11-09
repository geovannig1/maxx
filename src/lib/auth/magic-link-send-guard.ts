/**
 * Keep the login UI inside Supabase's built-in SMTP budget. This is a usability
 * guard only; Supabase remains the authoritative, server-side rate limiter.
 */
const ONE_MINUTE_MS = 60 * 1000
const ONE_HOUR_MS = 60 * ONE_MINUTE_MS
const BUILT_IN_SMTP_HOURLY_LIMIT = 2

export type MagicLinkSendGuard = {
  canRequest: boolean
  retryAt: number | null
}

function validRequests(requests: readonly number[], now: number): number[] {
  return requests
    .filter((requestedAt) => Number.isFinite(requestedAt) && requestedAt > 0)
    .filter((requestedAt) => requestedAt > now - ONE_HOUR_MS && requestedAt <= now)
    .sort((a, b) => a - b)
}

export function getMagicLinkSendGuard(
  storedRequests: readonly number[],
  now: number,
): MagicLinkSendGuard {
  const requests = validRequests(storedRequests, now)
  const latestRequest = requests.at(-1)

  if (requests.length >= BUILT_IN_SMTP_HOURLY_LIMIT) {
    return { canRequest: false, retryAt: requests[0] + ONE_HOUR_MS }
  }

  if (latestRequest && now < latestRequest + ONE_MINUTE_MS) {
    return { canRequest: false, retryAt: latestRequest + ONE_MINUTE_MS }
  }

  return { canRequest: true, retryAt: null }
}

export function recordMagicLinkRequest(storedRequests: readonly number[], now: number): number[] {
  return [...validRequests(storedRequests, now), now]
}

export function recordMagicLinkRateLimit(now: number): number[] {
  // A provider-side rejection can have been caused by another browser. Model a
  // full exhausted hour locally so this screen does not keep generating 429s.
  return [now, now]
}

export const MAGIC_LINK_SEND_GUARD_STORAGE_KEY = 'maxx.magic-link-send-requests.v1'
