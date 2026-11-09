import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { applyAuthCookieCacheHeaders, hardenServerCookie } from '@/lib/supabase/cookie-options'
import { appOrigin } from '@/lib/security/app-origin'

// Every response here may carry the new session's Set-Cookie (cookies() writes are merged into the
// returned redirect), so each one gets the library's cache headers and is never CDN-cacheable.
function uncacheableRedirect(url: string, libraryHeaders: Record<string, string>): NextResponse {
  const response = NextResponse.redirect(url)
  applyAuthCookieCacheHeaders(response.headers, libraryHeaders)
  return response
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  // Behind `next start`, request.url's host is always localhost; APP_URL is the browser-facing origin.
  const origin = appOrigin(request)
  const code = searchParams.get('code')
  const flowId = searchParams.get('sb_flow_id')
  const candidateNext = searchParams.get('next')
  const next = candidateNext && candidateNext.startsWith('/') && !candidateNext.startsWith('//')
    ? candidateNext
    : '/dashboard'

  const libraryHeaders: Record<string, string> = {}
  if (code) {
    const cookieStore = await cookies()
    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: {
          getAll() {
            return cookieStore.getAll()
          },
          setAll(cookiesToSet, headers) {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, hardenServerCookie(name, options))
            )
            Object.assign(libraryHeaders, headers)
          },
        },
      }
    )

    const { error } = await supabase.auth.exchangeCodeForSession(
      code,
      flowId ? { flowId } : undefined
    )
    if (!error) {
      return uncacheableRedirect(`${origin}${next}`, libraryHeaders)
    }

    // Keep the browser response generic, but preserve the bounded provider error metadata needed to
    // distinguish an expired code from a callback/verifier configuration problem in deployment logs.
    console.error('supabase_auth_code_exchange_failed', {
      code: error.code ?? 'unknown',
      status: error.status ?? null,
      hasFlowId: Boolean(flowId),
    })
  }

  return uncacheableRedirect(`${origin}/login?error=auth`, libraryHeaders)
}
