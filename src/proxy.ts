import { createServerClient } from '@supabase/ssr'
import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { ownerGate } from '@/lib/auth/owner'
import type { User } from '@supabase/supabase-js'
import { readReportingUser } from '@/lib/reporting/session'
import { rejectCrossOriginMutation } from '@/lib/security/same-origin'
import { appOrigin } from '@/lib/security/app-origin'
import { applyAuthCookieCacheHeaders, hardenServerCookie } from '@/lib/supabase/cookie-options'
import { setupAccessMode, supabasePublicConfigured } from '@/lib/setup/access'
import { API_CONTENT_SECURITY_POLICY, createNonce, pageContentSecurityPolicy } from '@/lib/security/csp'

const OUTCOME_WEBHOOK_PATH = /^\/api\/outcomes\/webhook\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Sets the one Content-Security-Policy (next.config.ts sends none). A page request gets a fresh script
 * nonce, written into the REQUEST's CSP header (Next.js reads it there while rendering and stamps its
 * own scripts) and into x-nonce (the root layout reads it for the next-themes script), overwriting any
 * client-sent value; every page pass-through below forwards the request headers. API responses get a
 * strict policy and no nonce.
 */
export async function proxy(request: NextRequest) {
  if (request.nextUrl.pathname.startsWith('/api/')) {
    const response = await gate(request)
    response.headers.set('Content-Security-Policy', API_CONTENT_SECURITY_POLICY)
    return response
  }
  const nonce = createNonce()
  const policy = pageContentSecurityPolicy({
    nonce,
    isDev: process.env.NODE_ENV === 'development',
    env: { NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SENTRY_DSN: process.env.NEXT_PUBLIC_SENTRY_DSN },
  })
  // Mutated in place like request.cookies below (the @supabase/ssr pattern), so the headers forwarded
  // by NextResponse.next({ request }) carry the nonce.
  request.headers.set('x-nonce', nonce)
  request.headers.set('Content-Security-Policy', policy)
  const response = await gate(request)
  response.headers.set('Content-Security-Policy', policy)
  return response
}

async function gate(request: NextRequest): Promise<Response> {
  const { pathname } = request.nextUrl

  // The magic-link callback creates the session; sign-out (POST-only, same-origin, in its route) must
  // work for a signed-out, expired or non-owner session, so neither is gated or redirected here.
  if (pathname.startsWith('/auth/callback') || pathname === '/auth/signout') {
    return NextResponse.next()
  }

  const isApiRoute = pathname.startsWith('/api/')
  // Machine-authenticated endpoints enforce signed webhook/cron secrets in their route handlers.
  // Every other API is owner-only here, in addition to route-level checks, so a newly added
  // service-role route cannot accidentally expose data merely because `/api/*` bypasses page auth.
  const usesRouteLevelMachineAuth =
    pathname.startsWith('/api/cron/') ||
    pathname.startsWith('/api/webhooks/') ||
    pathname === '/api/sync/midday'
  // ADR-056 §1: the paid-touch capture endpoint is deliberately PUBLIC — anonymous visitors on the
  // marketing site call it, so an owner session can never exist. It is not unguarded: the handler
  // enforces an exact HTTPS origin allowlist, a hashed-fingerprint rate limit, byte and media-type
  // bounds, a strict schema, sole-active-account resolution, and returns 503 while unconfigured. It
  // never emits a conversion. Exact match, never a prefix, so nothing else under /api/attribution/
  // becomes public by accident. OPTIONS must reach the handler too or the browser preflight fails.
  const isPublicPaidTouchCapture = pathname === '/api/attribution/paid-touch'
  // ADR-058: the generic outcome webhook verifies a per-source HMAC signature in its handler. Exact
  // pattern (one uuid segment, nothing after it), never a prefix, so no other /api/outcomes/ route and
  // no encoded or dotted variant of this one skips the owner gate.
  const isOutcomeWebhook = OUTCOME_WEBHOOK_PATH.test(pathname)
  if (isApiRoute && (usesRouteLevelMachineAuth || isPublicPaidTouchCapture || isOutcomeWebhook)) return NextResponse.next()
  // Every remaining API route is reached with the owner's cookie session. A browser-initiated
  // mutation must come from this origin: SameSite=Lax cookies already block most cross-site writes,
  // and this check closes the rest uniformly instead of relying on each handler to remember it.
  if (isApiRoute && request.method !== 'GET' && request.method !== 'HEAD' && request.method !== 'OPTIONS') {
    const crossOrigin = rejectCrossOriginMutation(request)
    if (crossOrigin) return crossOrigin
  }

  // an unconfigured install shows the setup checklist instead of a broken dashboard. Without the
  // Supabase public values nobody can sign in: /setup (variable names only) is the one page served
  // and every API answers 503. Without OWNER_EMAIL the gate denies everyone (in development too), so /setup
  // is served without a session too (src/lib/setup/access.ts; the page shows names, never values).
  const setupEnv = {
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    OWNER_EMAIL: process.env.OWNER_EMAIL,
    NODE_ENV: process.env.NODE_ENV,
    VERCEL_ENV: process.env.VERCEL_ENV,
  }
  if (!supabasePublicConfigured(setupEnv)) {
    if (isApiRoute) return NextResponse.json({ error: 'Maxx is not configured yet. Open /setup.', code: 'SETUP_INCOMPLETE' }, { status: 503 })
    return pathname === '/setup' ? NextResponse.next({ request }) : NextResponse.redirect(new URL('/setup', appOrigin(request)))
  }
  if (pathname === '/setup' && setupAccessMode(setupEnv) === 'public') return NextResponse.next({ request })

  let response = NextResponse.next({ request })

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet, headers) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          )
          response = NextResponse.next({ request })
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, hardenServerCookie(name, options))
          )
          // A refreshed session must never be cached by a CDN and replayed to another visitor.
          applyAuthCookieCacheHeaders(response.headers, headers)
        },
      },
    }
  )

  let user: User | null
  if (pathname === '/api/reporting') {
    try { user = await readReportingUser(() => supabase.auth.getUser(), request.signal) }
    catch {
      return NextResponse.json({ error: 'Reporting session verification is temporarily unavailable. Retry this source.' }, {
        status: 503, headers: { 'Cache-Control': 'private, no-store', Vary: 'Cookie' },
      })
    }
  } else {
    const result = await supabase.auth.getUser()
    user = result.data.user
  }

  if (isApiRoute) {
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    const gate = ownerGate(user)
    if (!gate.allowed) {
      const error = gate.reason === 'unconfigured' ? 'Owner not configured.' : 'Forbidden — owner only.'
      return NextResponse.json({ error }, { status: 403 })
    }
    return response
  }

  const isAuthRoute = pathname.startsWith('/login')

  if (!user && !isAuthRoute) {
    const login = new URL('/login', appOrigin(request))
    login.searchParams.set('next', `${pathname}${request.nextUrl.search}`)
    return NextResponse.redirect(login)
  }

  if (user && isAuthRoute) {
    // Only the owner is sent on to the dashboard. A signed-in non-owner stays on /login so the
    // error can render; redirecting them would loop against the owner gate below.
    if (ownerGate(user).allowed) return NextResponse.redirect(new URL('/dashboard', appOrigin(request)))
    return response
  }

  // Owner gate — fail CLOSED in production if OWNER_EMAIL is unset. In dev, an unset
  // OWNER_EMAIL stays permissive (handled inside ownerGate).
  if (user && !isAuthRoute) {
    const gate = ownerGate(user)
    if (!gate.allowed) {
      const err = gate.reason === 'unconfigured' ? 'owner_unconfigured' : 'unauthorized'
      return NextResponse.redirect(new URL(`/login?error=${err}`, appOrigin(request)))
    }
  }

  return response
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
}
