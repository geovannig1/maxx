import type { CookieOptions } from '@supabase/ssr'

// One cookie policy for every Supabase client factory (proxy.ts, server.ts, auth callback, sign-out
// route, browser client). Pure: reads only process.env, so middleware, routes and the browser bundle
// can all import it.
//
// @supabase/ssr 0.12.4 writes { path: '/', sameSite: 'lax', httpOnly: false, maxAge: 400 days } and
// replaces any cookieOptions.maxAge with that 400-day default before calling setAll
// (node_modules/@supabase/ssr/dist/main/cookies.js:461-465). So the lifetime can only be bounded in
// the setAll callbacks we own: each server factory passes every cookie through hardenServerCookie().

/** Idle lifetime of a session cookie. Each token refresh rewrites it, so it slides with use. */
export const SESSION_COOKIE_MAX_AGE_SECONDS = 7 * 24 * 60 * 60

// auth-js PKCE keys all end in `-code-verifier`: `<key>-code-verifier`, `<key>-flow-<id>-code-verifier`
// and the pending-flow index `<key>-flows-code-verifier` (auth-js lib/helpers.js:297-305). The browser
// client writes and re-reads them during sign-in, and the server rewrites the index after an exchange
// (helpers.js removePKCEVerifier), so they must stay readable from document.cookie.
const PKCE_VERIFIER_COOKIE = /-code-verifier(?:\.\d+)?$/

function isProductionCookieRuntime(): boolean {
  return process.env.VERCEL_ENV === 'production' || process.env.NODE_ENV === 'production'
}

/**
 * Options for cookies the BROWSER client writes (PKCE verifiers only). HttpOnly is impossible from
 * document.cookie, and the library forces their maxAge to its default; the callback deletes them.
 */
export function browserCookieOptions(): CookieOptions {
  return { path: '/', sameSite: 'lax', secure: isProductionCookieRuntime() }
}

/**
 * Headers for a response that sets or clears auth cookies, so no CDN or shared cache stores one
 * user's Set-Cookie and serves it to another. Same values @supabase/ssr 0.12.4 passes as setAll's
 * second argument from its server write path (dist/main/cookies.js applyServerStorage); its other
 * write paths pass {}, so these are applied whatever arrives.
 */
export const AUTH_COOKIE_CACHE_HEADERS: Readonly<Record<string, string>> = {
  'Cache-Control': 'private, no-cache, no-store, must-revalidate, max-age=0',
  Expires: '0',
  Pragma: 'no-cache',
}

/** Applies the library's headers plus AUTH_COOKIE_CACHE_HEADERS, which a caller cannot weaken. */
export function applyAuthCookieCacheHeaders(target: Headers, provided: Record<string, string> = {}): void {
  for (const [name, value] of Object.entries({ ...provided, ...AUTH_COOKIE_CACHE_HEADERS })) {
    target.set(name, value)
  }
}

/**
 * Hardens one cookie the SERVER is about to write. Session cookies become HttpOnly; PKCE verifier
 * cookies stay script-readable. Secure only in production so http://localhost keeps working.
 * A removal (maxAge 0) stays a removal.
 */
export function hardenServerCookie(name: string, options: CookieOptions = {}): CookieOptions {
  const requested = options.maxAge ?? SESSION_COOKIE_MAX_AGE_SECONDS
  return {
    ...options,
    path: options.path ?? '/',
    sameSite: 'lax',
    secure: isProductionCookieRuntime(),
    httpOnly: !PKCE_VERIFIER_COOKIE.test(name),
    maxAge: requested <= 0 ? 0 : Math.min(requested, SESSION_COOKIE_MAX_AGE_SECONDS),
  }
}
