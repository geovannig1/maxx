// The app's own public origin. Behind `next start`, `request.url` always has host `localhost` (Next
// builds it from the bind hostname and ignores Host/X-Forwarded-Host unless told to trust them), so it
// cannot tell the browser where the app lives. APP_URL is the operator's statement of that origin; it
// is required in production off Vercel. Client-sent Host/X-Forwarded-Host are never trusted.

type Env = Record<string, string | undefined>

function originOf(value: string | undefined, assumeHttps = false): string | null {
  const raw = value?.trim()
  if (!raw) return null
  try {
    const url = new URL(assumeHttps && !/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? `https://${raw}` : raw)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.origin : null
  } catch {
    return null
  }
}

/** APP_URL's origin (scheme, host, port), or null when unset or not an http(s) URL. */
export function configuredAppOrigin(env: Env = process.env): string | null {
  return originOf(env.APP_URL)
}

/** The origin redirects should point at: APP_URL when set, else the request's own origin (dev, Vercel). */
export function appOrigin(request: Request, env: Env = process.env): string {
  return configuredAppOrigin(env) ?? new URL(request.url).origin
}

/** Every origin a same-origin browser request may carry: APP_URL, the Vercel production and deployment
 *  hosts (set by Vercel, scheme-less), and the request's own origin. */
export function allowedAppOrigins(request: Request, env: Env = process.env): Set<string> {
  const origins = new Set<string>([new URL(request.url).origin])
  for (const origin of [
    configuredAppOrigin(env),
    env.VERCEL ? originOf(env.VERCEL_PROJECT_PRODUCTION_URL, true) : null,
    env.VERCEL ? originOf(env.VERCEL_URL, true) : null,
  ]) {
    if (origin) origins.add(origin)
  }
  return origins
}
