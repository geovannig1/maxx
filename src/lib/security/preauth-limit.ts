import { clientAddress } from './client-address'

// A cheap, in-process, per-address limiter for public webhook endpoints, checked BEFORE any database
// lookup or signature work, so an unauthenticated flood costs neither a query nor an HMAC. It is
// per server instance (not shared), which is enough for its job: the signed, database-backed limits
// after authentication remain the real bounds. The map is capped; when full it is cleared.

const WINDOW_MS = 60_000
const MAX_TRACKED = 10_000
const windows = new Map<string, { start: number; count: number }>()

export function preAuthRateLimit(req: Request, bucket: string, limitPerMinute: number, now = Date.now()): Response | null {
  const key = `${bucket}|${clientAddress(req)}`
  let window = windows.get(key)
  if (!window || now - window.start >= WINDOW_MS) {
    if (!window && windows.size >= MAX_TRACKED) windows.clear()
    window = { start: now, count: 0 }
    windows.set(key, window)
  }
  window.count += 1
  if (window.count <= limitPerMinute) return null
  const retryAfter = Math.max(1, Math.ceil((window.start + WINDOW_MS - now) / 1000))
  return Response.json(
    { error: 'Too many requests. Try again later.', code: 'RATE_LIMITED' },
    { status: 429, headers: { 'Retry-After': String(retryAfter) } },
  )
}

/** Tests only: forget every window. */
export function resetPreAuthRateLimit(): void {
  windows.clear()
}
