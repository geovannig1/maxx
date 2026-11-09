/**
 * Rejects browser-initiated mutations that do not come from this application's own origin.
 *
 * Session cookies are SameSite=Lax, which already blocks most cross-site POST/PATCH, but the routes
 * that approve or execute a live Meta change deserve a second, explicit check: a cross-site or
 * same-site (sibling subdomain) Sec-Fetch-Site or a mismatching Origin header is refused before any
 * state is read. src/proxy.ts applies this to every cookie-session API mutation, after the
 * machine-authenticated routes (cron Bearer, signed webhooks, public paid-touch) have been exempted.
 *
 * A request with NEITHER header is refused in production: every current browser sends Sec-Fetch-Site,
 * and sends Origin on POST/PATCH/DELETE, so a header-less cookie request is not this app's UI. Outside
 * production it passes, so local tooling and tests can still call the API.
 *
 * Origin is compared with the app's own origins (src/lib/security/app-origin.ts): APP_URL, Vercel's
 * hosts and request.url. Behind `next start` request.url is always localhost, so a self-hosted
 * deployment must set APP_URL; client-sent Host/X-Forwarded-Host are never trusted.
 */
import { allowedAppOrigins } from './app-origin'

function isProductionRuntime(): boolean {
  // Inlined rather than imported from @/lib/auth/owner: many suites mock that module wholesale.
  return process.env.VERCEL_ENV === 'production' || process.env.NODE_ENV === 'production'
}

function forbidden(): Response {
  return Response.json({ error: 'Cross-origin mutation is forbidden.' }, { status: 403 })
}

export function rejectCrossOriginMutation(req: Request): Response | null {
  const fetchSite = req.headers.get('sec-fetch-site')
  if (fetchSite === 'cross-site' || fetchSite === 'same-site') return forbidden()
  const origin = req.headers.get('origin')
  if (origin) {
    try {
      if (!allowedAppOrigins(req).has(new URL(origin).origin)) return forbidden()
    } catch {
      return forbidden()
    }
  }
  if (!fetchSite && !origin && isProductionRuntime()) return forbidden()
  return null
}
