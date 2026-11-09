// Hermetic transport adapter: real Supabase SDK/repository, actual PostgreSQL
// statements. This is not a running PostgREST server or a multi-connection test.
import { createClient } from '@supabase/supabase-js'
import type { PGlite } from '@electric-sql/pglite'
import type { SnapshotDatabase } from '../../src/lib/reporting/snapshot-store'

const fields = ['ad_account_id', 'source', 'scope_key', 'scope_canonical', 'evidence_fingerprint',
  'snapshot_canonical', 'retrieval_started_at', 'retrieval_completed_at'] as const

export function snapshotTestClient(db: PGlite): SnapshotDatabase {
  return createClient('http://snapshot-fixture.invalid', 'fictional-test-key', {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: async (input, init) => {
      const request = new Request(input, init), url = new URL(request.url)
      if (url.pathname !== '/rest/v1/reporting_snapshots') throw new Error('Unexpected test endpoint')
      request.signal.throwIfAborted()
      try {
        if (request.method === 'POST') {
          const row = await request.json()
          const result = await db.query(`INSERT INTO public.reporting_snapshots (${fields.join(',')})
            VALUES (${fields.map((_, i) => `$${i + 1}`).join(',')}) RETURNING *`, fields.map(key => row[key]))
          return Response.json(result.rows[0], { status: 201 })
        }
        if (request.method !== 'GET') throw new Error('Unexpected test method')
        const selected = ['ad_account_id', 'source', 'scope_key', 'evidence_fingerprint'].filter(key => url.searchParams.has(key))
        const values = selected.map(key => {
          const filter = url.searchParams.get(key)!
          if (!filter.startsWith('eq.')) throw new Error('Unexpected test filter')
          return filter.slice(3)
        })
        const order = url.searchParams.get('order')?.split(',').map(term => {
          const match = /^(retrieval_started_at|retrieval_completed_at|id)\.(asc|desc)$/.exec(term)
          if (!match) throw new Error('Unexpected test ordering')
          return `${match[1]} ${match[2]}`
        }).join(', ')
        const limit = url.searchParams.get('limit')
        if (limit !== null && limit !== '1') throw new Error('Unexpected test limit')
        const result = await db.query(`SELECT * FROM public.reporting_snapshots WHERE
          ${selected.map((key, i) => `${key} = $${i + 1}`).join(' AND ')}
          ${order ? `ORDER BY ${order}` : ''} ${limit ? 'LIMIT 1' : ''}`, values)
        return Response.json(result.rows)
      } catch (error) {
        const failure = error as { code?: string; message?: string }
        return Response.json({ code: failure.code ?? 'fixture_failure', message: failure.message ?? 'Fixture failed' }, { status: 400 })
      }
    } },
  })
}
