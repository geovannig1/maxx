import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { hardenServerCookie } from './cookie-options'

export async function createClient() {
  const cookieStore = await cookies()

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll()
        },
        // @supabase/ssr also passes no-store cache headers as setAll's second argument. They cannot be
        // applied here: next/headers cookies() writes cookies but exposes no response-header API, and
        // this factory never sees the response. Server Components cannot write cookies at all (the
        // catch below); dynamic pages already get Next's `private, no-cache, no-store` Cache-Control.
        // The session refresh normally happens in src/proxy.ts, which does apply the headers. A Route
        // Handler or Server Function that can rewrite auth cookies through this client must set
        // AUTH_COOKIE_CACHE_HEADERS (./cookie-options) on its own response.
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, hardenServerCookie(name, options))
            )
          } catch {
            // Server Component context — cookie writes are no-ops
          }
        },
      },
    }
  )
}
