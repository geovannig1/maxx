import type { PGlite } from '@electric-sql/pglite'
import { handlePostgrest } from '../lib/postgrest-pglite'

// The demo backend's REST: the PostgREST subset shared with the DB tests (scripts/lib/postgrest-pglite.ts),
// so the app's real Supabase client reads the sample database. In demo mode an unsupported query answers
// an empty result (header x-demo-unsupported) instead of an error, so a page shows its empty state. The
// database is in memory and thrown away on exit.

/** Answer one `/rest/v1/...` request against the sample database. */
export function handleRest(db: PGlite, request: Request): Promise<Response> {
  return handlePostgrest(db, request, 'demo')
}
