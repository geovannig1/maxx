import { createClient } from '@supabase/supabase-js'
import type { PGlite } from '@electric-sql/pglite'
import type { ReportingRefreshDatabase } from '@/lib/reporting/refresh-jobs'
import { canonical, fingerprint, prepareDb, snapshotFixture } from './reporting-snapshot-fixture'

export interface RefreshRow {
  id: string; ad_account_id: string; source: string; scope_key: string; scope_canonical: string
  status: 'running' | 'complete' | 'failed'; started_at: string; lease_expires_at: string; lease_token: string
  completed_at: string | null; failure_code: string | null; snapshot_id: string | null
  progress_canonical: string | null; progress_fingerprint: string | null; progress_at: string | null; created_at: string
}
export const scopeFixture = (source = 'meta') => snapshotFixture(source).scope
/** The shipped schema already carries the refresh lease tables and RPCs (baseline schema). */
export async function prepareRefreshDb(dataDir?: string) {
  return prepareDb(dataDir)
}
export async function claim(db: PGlite, scope: unknown = scopeFixture(), force = true) {
  return (await db.query<{ value: { claimed: boolean; job: RefreshRow | null } }>(
    'SELECT public.claim_reporting_refresh($1,$2) value', [canonical(scope), force])).rows[0].value
}
export async function claimedJob(db: PGlite, scope = scopeFixture()) {
  const result = await claim(db, scope)
  if (!result.claimed || !result.job) throw new Error('Expected a new refresh lease')
  return result.job
}
export function jobSnapshot(job: RefreshRow) {
  const started = new Date(job.started_at).toISOString()
  const snapshot = snapshotFixture(job.source, started, started)
  const scope = JSON.parse(job.scope_canonical)
  return { ...snapshot, scope, sourceAsOf: started, packet: { ...snapshot.packet,
    context: { ...snapshot.packet.context, account: { ...snapshot.packet.context.account,
      id: job.ad_account_id, metaAccountId: scope.metaAccountId }, range: scope.range,
    comparison: scope.comparison, asOf: started }, result: { ...snapshot.packet.result, asOf: started } } }
}
export function progressPacket(job: RefreshRow) {
  const packet = jobSnapshot(job).packet
  return { ...packet, result: { ...packet.result, state: 'partial', data: { ...packet.result.data, detailState: 'loading' } } }
}
export async function progress(db: PGlite, job: RefreshRow, packet: unknown = progressPacket(job)) {
  return (await db.query<{ value: boolean }>('SELECT public.publish_reporting_refresh_progress($1,$2,$3) value',
    [job.id, job.lease_token, canonical(packet)])).rows[0].value
}
export async function finish(db: PGlite, job: RefreshRow, snapshot: unknown = jobSnapshot(job)) {
  return (await db.query<{ value: { committed: boolean; snapshot_id: string | null } }>(
    'SELECT public.finish_reporting_refresh($1,$2,$3) value', [job.id, job.lease_token, canonical(snapshot)])).rows[0].value
}
export async function fail(db: PGlite, job: RefreshRow, code: string | null = 'source_unavailable') {
  return (await db.query<{ value: boolean }>('SELECT public.fail_reporting_refresh($1,$2,$3) value',
    [job.id, job.lease_token, code])).rows[0].value
}
export async function readJob(db: PGlite, id: string) {
  return (await db.query<{ value: RefreshRow }>('SELECT to_jsonb(j) value FROM public.reporting_refresh_jobs j WHERE id=$1', [id])).rows[0].value
}
// Historical fixture inserts use the PGlite postgres owner; production callers cannot set clocks.
export async function expiredJob(db: PGlite) {
  const scope = scopeFixture(), scopeText = canonical(scope)
  return (await db.query<{ value: RefreshRow }>(`WITH clock AS MATERIALIZED (
      SELECT date_trunc('milliseconds',clock_timestamp()) now
    ) INSERT INTO public.reporting_refresh_jobs
    (ad_account_id,source,scope_key,scope_canonical,started_at,lease_expires_at,created_at)
    SELECT $1,$2,$3,$4,now-interval '5 minutes',now-interval '3 minutes',now-interval '5 minutes' FROM clock
    RETURNING to_jsonb(reporting_refresh_jobs) value`, [scope.accountId, scope.source, fingerprint(scopeText), scopeText])).rows[0].value
}

// Real SDK/repository and SQL; the transport is hermetic, not a PostgREST deployment.
export function refreshTestClient(db: PGlite): ReportingRefreshDatabase {
  const signatures: Record<string, string[]> = {
    claim_reporting_refresh: ['p_scope_canonical', 'p_force'],
    publish_reporting_refresh_progress: ['p_job', 'p_token', 'p_packet_canonical'],
    finish_reporting_refresh: ['p_job', 'p_token', 'p_snapshot_canonical'],
    fail_reporting_refresh: ['p_job', 'p_token', 'p_code'],
  }
  return createClient('http://refresh-fixture.invalid', 'fictional-test-key', {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: async (input, init) => {
      const request = new Request(input, init), url = new URL(request.url)
      request.signal.throwIfAborted()
      try {
        const rpc = url.pathname.replace('/rest/v1/rpc/', '')
        if (request.method === 'POST' && Object.hasOwn(signatures, rpc)) {
          const args = await request.json(), parameters = signatures[rpc]
          const result = await db.query<{ value: unknown }>(`SELECT public.${rpc}(${parameters.map((_, i) => `$${i + 1}`).join(',')}) value`,
            parameters.map(name => args[name]))
          return Response.json(result.rows[0].value)
        }
        const table = url.pathname === '/rest/v1/reporting_snapshots' ? 'reporting_snapshots' : 'reporting_refresh_jobs'
        if (request.method !== 'GET' || url.pathname !== `/rest/v1/${table}`) throw new Error('Unexpected refresh endpoint')
        const fields = ['ad_account_id', 'source', 'scope_key', ...(url.searchParams.has('id') ? ['id'] : [])]
        const args = fields.map(key => {
          const value = url.searchParams.get(key)
          if (!value?.startsWith('eq.')) throw new Error('Missing exact refresh scope filter')
          return value.slice(3)
        })
        if (table === 'reporting_snapshots' && !fields.includes('id')) throw new Error('Exact snapshot ID required')
        if (table === 'reporting_refresh_jobs'
          && (url.searchParams.get('order') !== 'started_at.desc,id.desc' || url.searchParams.get('limit') !== '1')) {
          throw new Error('Unexpected refresh ordering or limit')
        }
        const result = await db.query<{ value: unknown }>(`SELECT to_jsonb(j) value FROM public.${table} j
          WHERE ${fields.map((key, i) => `${key}=$${i + 1}`).join(' AND ')}
          ${table === 'reporting_refresh_jobs' ? 'ORDER BY started_at DESC,id DESC LIMIT 1' : ''}`, args)
        return Response.json(result.rows.map(row => row.value))
      } catch (error) {
        const failure = error as { code?: string; message?: string }
        return Response.json({ code: failure.code ?? 'fixture_failure', message: failure.message ?? 'Fixture failed' }, { status: 400 })
      }
    } },
  })
}
