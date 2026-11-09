import { createClient } from '@supabase/supabase-js'
import { PGlite } from '@electric-sql/pglite'
import type { SavedReportingDatabase } from '@/lib/reporting/saved-store'
import { prepareRefreshDb, refreshTestClient } from './reporting-refresh-fixture'

/** The shipped schema already carries the saved-report manifest (baseline schema). */
export async function prepareSavedDb(dataDir?: string): Promise<PGlite> {
  return prepareRefreshDb(dataDir)
}
/** Real Supabase SDK and SQL; only the HTTP transport is replaced with isolated PGlite. */
export function savedTestClient(db: PGlite): SavedReportingDatabase {
  const refresh = refreshTestClient(db)
  const signatures: Record<string, string[]> = {
    save_reporting_report: ['p_account', 'p_user', 'p_request', 'p_artifact_canonical'],
    read_saved_reporting_report: ['p_account', 'p_id', 'p_user', 'p_request'],
    list_saved_reporting_reports: ['p_account', 'p_before', 'p_before_id'],
  }
  const client = createClient('http://saved-fixture.invalid', 'fictional-test-key', {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: async (input, init) => {
      const request = new Request(input, init), rpc = new URL(request.url).pathname.replace('/rest/v1/rpc/', '')
      request.signal.throwIfAborted()
      if (request.method !== 'POST' || !Object.hasOwn(signatures, rpc)) throw new Error('Unexpected saved fixture endpoint')
      try {
        const args = await request.json(), names = signatures[rpc]
        const result = await db.query<{ value: unknown }>(`SELECT public.${rpc}(${names.map((_, i) => `$${i + 1}`).join(',')}) value`, names.map(name => args[name]))
        return Response.json(result.rows[0].value)
      } catch (error) {
        const failure = error as { code?: string; message?: string }
        return Response.json({ code: failure.code ?? 'fixture_failure', message: failure.message ?? 'Fixture failure' }, { status: 400 })
      }
    } },
  })
  return { from: refresh.from.bind(refresh), rpc: client.rpc.bind(client) }
}
