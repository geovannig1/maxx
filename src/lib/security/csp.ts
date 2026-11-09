// The Content-Security-Policy, built once per request by src/proxy.ts (the only place it is set:
// next.config.ts no longer sends one, so a response never carries two conflicting policies).
//
// Scripts: a fresh nonce per request plus 'strict-dynamic'. Next.js reads the nonce from the request's
// CSP header while rendering and stamps it on its own scripts; the root layout passes it to the one
// inline script the app renders (next-themes). 'unsafe-inline' is never allowed for scripts;
// 'unsafe-eval' is development-only (React's dev tooling). This needs every page rendered per request,
// which the root layout guarantees by reading the request headers.
//
// Styles keep 'unsafe-inline': server-rendered React `style` attributes (and the inline <style> that
// sonner injects at runtime) cannot carry a nonce, and 'unsafe-hashes' would need a hash for every
// dynamic value. style-src therefore carries no nonce either: a nonce would make browsers ignore
// 'unsafe-inline'. Every other fetch class is restricted to enumerated origins, which is what blocks
// image/beacon exfiltration of rendered data.

/** Build-time public values whose origins the browser must reach. */
export interface CspSourceEnv {
  NEXT_PUBLIC_SUPABASE_URL?: string
  NEXT_PUBLIC_SENTRY_DSN?: string
}

export interface PageCspOptions {
  nonce: string
  isDev: boolean
  env: CspSourceEnv
}

// Meta serves creative thumbnails, images and videos from signed CDN URLs on these hosts, and the
// browser loads them directly (CreativeAsset, PlacementPreview, the performance tables).
const META_IMAGE_HOSTS = ['https://*.fbcdn.net', 'https://*.fbsbx.com', 'https://*.cdninstagram.com']
const META_MEDIA_HOSTS = ['https://*.fbcdn.net']
// `npm run preview:sample` runs `next dev` and serves fixture media from a separate loopback port.
const DEV_LOOPBACK = ['http://127.0.0.1:*', 'https://127.0.0.1:*', 'http://localhost:*']
// The form Next.js accepts (get-script-nonce-from-header.ts); anything else could break the header.
const NONCE_FORM = /^[A-Za-z0-9+/]+={0,2}$/
const NONCE_BYTES = 16

/** API responses are JSON or files, never documents: nothing may load from them or frame them. */
export const API_CONTENT_SECURITY_POLICY = "default-src 'none'; frame-ancestors 'none'"

/** A fresh, unpredictable nonce (128 bits, base64). One per request. */
export function createNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(NONCE_BYTES))
  return btoa(String.fromCharCode(...bytes))
}

/** The origin of an http(s) URL from configuration, or null when it is unset or not a web URL. */
function originOf(value: string | undefined): string | null {
  if (!value) return null
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.origin : null
  } catch {
    return null
  }
}

export function pageContentSecurityPolicy({ nonce, isDev, env }: PageCspOptions): string {
  if (!NONCE_FORM.test(nonce)) throw new Error('CSP nonce must be base64.')
  const loopback = isDev ? DEV_LOOPBACK : []
  const connect = ["'self'", originOf(env.NEXT_PUBLIC_SUPABASE_URL), originOf(env.NEXT_PUBLIC_SENTRY_DSN)]
    .filter((source): source is string => source !== null)
  const directives: [string, string[]][] = [
    ['default-src', ["'self'"]],
    ['script-src', ["'self'", `'nonce-${nonce}'`, "'strict-dynamic'", ...(isDev ? ["'unsafe-eval'"] : [])]],
    ['style-src', ["'self'", "'unsafe-inline'"]],
    ['img-src', ["'self'", 'blob:', 'data:', ...META_IMAGE_HOSTS, ...loopback]],
    ['media-src', ["'self'", 'blob:', ...META_MEDIA_HOSTS, ...loopback]],
    ['font-src', ["'self'"]],
    ['connect-src', connect],
    ['object-src', ["'none'"]],
    ['base-uri', ["'self'"]],
    ['form-action', ["'self'"]],
    ['frame-ancestors', ["'none'"]],
  ]
  const policy = directives.map(([name, sources]) => `${name} ${sources.join(' ')}`)
  if (!isDev) policy.push('upgrade-insecure-requests')
  return policy.join('; ')
}
