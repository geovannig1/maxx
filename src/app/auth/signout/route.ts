import { createServerClient } from '@supabase/ssr'
import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { rejectCrossOriginMutation } from '@/lib/security/same-origin'
import { appOrigin } from '@/lib/security/app-origin'
import { applyAuthCookieCacheHeaders, hardenServerCookie } from '@/lib/supabase/cookie-options'

// Session cookies are HttpOnly (src/lib/supabase/cookie-options.ts), so the browser can neither read
// the session to revoke it nor delete the cookies; sign-out happens here. POST only: Next.js answers
// any other method with 405, so a link, prefetch or <img> cannot sign the owner out. src/proxy.ts
// passes this path straight through, so a signed-out, expired or non-owner session can still use it.

// Every cookie auth-js stores under the default `sb-<project-ref>-auth-token` key: the session and its
// `.N` chunks, `-user`, and the PKCE `-code-verifier` / `-flow-<id>-code-verifier` / `-flows-…` keys.
const SUPABASE_AUTH_COOKIE = /^sb-.+-auth-token/

export async function POST(request: NextRequest) {
  const crossOrigin = rejectCrossOriginMutation(request)
  if (crossOrigin) return crossOrigin

  // 303 turns the form POST into a GET of /login.
  const response = NextResponse.redirect(new URL('/login', appOrigin(request)), 303)
  // The response clears auth cookies; it must never be stored by a CDN or shared cache.
  applyAuthCookieCacheHeaders(response.headers)

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet, headers) {
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, hardenServerCookie(name, options))
          )
          applyAuthCookieCacheHeaders(response.headers, headers)
        },
      },
    }
  )

  // Revoke the refresh token at Supabase (default scope: global, as the browser sign-out did).
  try {
    const { error } = await supabase.auth.signOut()
    if (error) {
      console.error('supabase_sign_out_failed', { code: error.code ?? 'unknown', status: error.status ?? null })
    }
  } catch {
    console.error('supabase_sign_out_failed', { code: 'exception', status: null })
  }

  // Clear the cookies whether or not revocation succeeded: an expired or unreachable session must
  // still end in the browser, and auth-js skips removal when it cannot load the session.
  for (const { name } of request.cookies.getAll()) {
    if (SUPABASE_AUTH_COOKIE.test(name)) {
      response.cookies.set(name, '', hardenServerCookie(name, { path: '/', maxAge: 0 }))
    }
  }
  return response
}
