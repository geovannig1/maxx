// Hermetic transport: the REAL Supabase SDK, with its HTTP calls translated into SQL against PGlite
// carrying the shipped schema, through the PostgREST subset shared with the demo backend
// (scripts/lib/postgrest-pglite.ts). In strict mode anything outside the subset is a 400 naming it,
// so a writer that starts using an unsupported feature fails loudly instead of being approximated.
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { PGlite } from '@electric-sql/pglite'
import { handlePostgrest } from '../../scripts/lib/postgrest-pglite'

/** A Supabase client whose every request runs as SQL against `db`. Records each request for tests. */
export function pgliteSupabase(db: PGlite, log: string[] = []): SupabaseClient {
  return createClient('http://postgrest-fixture.invalid', 'fixture-anon-placeholder', {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      fetch: async (input, init) => {
        const request = new Request(input, init)
        log.push(`${request.method} ${new URL(request.url).pathname.replace(/^\/rest\/v1\//, '')}`)
        return handlePostgrest(db, request, 'strict')
      },
    },
  })
}
