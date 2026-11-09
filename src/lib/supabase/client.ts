import { createBrowserClient } from '@supabase/ssr'
import { browserCookieOptions } from './cookie-options'

export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      // Only PKCE verifier cookies are written from the browser. Session cookies are written by the
      // server as HttpOnly, so browser code never reads the session (sign-out is POST /auth/signout).
      cookieOptions: browserCookieOptions(),
      auth: {
        experimental: {
          // Email links can be requested from more than one tab. Carry Supabase's flow ID through
          // the callback so it selects the matching PKCE verifier instead of whichever flow ran last.
          appendPkceFlowIdToRedirects: true,
        },
      },
    }
  )
}
