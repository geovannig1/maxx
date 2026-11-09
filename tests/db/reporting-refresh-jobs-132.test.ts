import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { claimReportingRefresh, failReportingRefresh, finishReportingRefresh,
  publishReportingRefreshProgress, readReportingRefreshJob } from '@/lib/reporting/refresh-jobs'
import { createReportingSnapshot, ReportingSnapshotScopeSchema } from '@/lib/reporting/snapshot-contract'
import { validateReportingPacket } from '@/lib/reporting/validation'
import { readReportingSnapshotById } from '@/lib/reporting/snapshot-store'
import { runReportingRefresh } from '@/lib/reporting/refresh-worker'
import { readMetaReport } from '@/lib/platforms/meta/reporting/meta-reader'
import { clearReportingCache } from '@/lib/reporting/loader'
import { ACCOUNT, OTHER_ACCOUNT, canonical, edit, fingerprint, insertRow, rowFor } from './reporting-snapshot-fixture'
import { claim, claimedJob, expiredJob, fail, finish, jobSnapshot, prepareRefreshDb,
  progress, progressPacket, readJob, refreshTestClient, scopeFixture, type RefreshRow } from './reporting-refresh-fixture'

let db: PGlite
vi.mock('@/lib/platforms/meta/reporting/meta-reader', () => ({ readMetaReport: vi.fn() }))
vi.mock('@/lib/reporting/business-reader', () => ({ readBusinessReport: vi.fn() }))
vi.mock('@/lib/reporting/website-reader', () => ({ readWebsiteReport: vi.fn() }))
vi.mock('@/lib/reporting/measurement-reader', () => ({ readMeasurementReport: vi.fn() }))
beforeAll(async () => { db = await prepareRefreshDb() })
beforeEach(async () => { vi.resetAllMocks(); clearReportingCache(); await db.exec('BEGIN') })
afterEach(async () => { await db.exec('ROLLBACK') })
afterAll(async () => { await db.close() })

async function rejected(run: () => Promise<unknown>, code = '23514') {
  await db.exec('SAVEPOINT invalid_refresh')
  try { await expect(run()).rejects.toMatchObject({ code }) }
  finally { await db.exec('ROLLBACK TO SAVEPOINT invalid_refresh; RELEASE SAVEPOINT invalid_refresh') }
}
async function snapshotCount() {
  return (await db.query<{ count: number }>('SELECT count(*)::int count FROM public.reporting_snapshots')).rows[0].count
}

describe('durable reporting refresh leases and publication', () => {
  it('installs the refresh table with row-level security', async () => {
    const result = await db.query(`SELECT relrowsecurity FROM pg_class WHERE oid=to_regclass('public.reporting_refresh_jobs')`)
    expect(result.rows).toEqual([{ relrowsecurity: true }])
  })

  it.each(['meta', 'business', 'website', 'measurement'])('claims and atomically publishes exact %s scope', async source => {
    const scope = scopeFixture(source), job = await claimedJob(db, scope)
    expect(job).toMatchObject({ ad_account_id: ACCOUNT, source, status: 'running', scope_canonical: canonical(scope),
      scope_key: fingerprint(canonical(scope)), failure_code: null, snapshot_id: null, completed_at: null,
      progress_canonical: null, progress_fingerprint: null, progress_at: null })
    expect(job.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(job.lease_token).toMatch(/^[0-9a-f-]{36}$/)
    expect(Date.parse(job.lease_expires_at) - Date.parse(job.started_at)).toBe(120_000)
    expect(job.created_at).toBe(job.started_at)
    const result = await finish(db, job)
    expect(result).toMatchObject({ committed: true, snapshot_id: expect.any(String) })
    expect(await readJob(db, job.id)).toMatchObject({ status: 'complete', snapshot_id: result.snapshot_id })
    const stored = (await db.query<{ snapshot_canonical: string; evidence_fingerprint: string }>(
      'SELECT snapshot_canonical,evidence_fingerprint FROM public.reporting_snapshots WHERE id=$1', [result.snapshot_id])).rows[0]
    expect(stored).toEqual({ snapshot_canonical: canonical(jobSnapshot(job)), evidence_fingerprint: fingerprint(canonical(jobSnapshot(job))) })
  })

  const invalidScopes: [string, unknown][] = [
    ['version', 2], ['version', '1'], ['policyVersion', 'reporting-v2'], ['accountId', 'bad'], ['source', 'other'],
    ['metaAccountId', 'act_bad'], ['timezone', 'UTC'], ['currency', 'EUR'], ['detailIds', ['ad_2', 'ad_1']],
    ['detailIds', ['ad_1', 'ad_1']], ['detailIds', ['ad_1', 'ad_2', 'ad_3']], ['detailIds', [123]],
    ['detailIds', ['bad/id']], ['detailIds', ['a'.repeat(161)]], ['requestedRange.from', '2026-08-31'],
    ['requestedRange.to', '2026-09-03'], ['range.to', '2026-09-03'], ['range.to', '2026-02-30'],
    ['range.to', '2026-9-04'], ['comparison.from', '2026-08-27'], ['comparison.to', '2026-08-30'],
  ]
  it.each(invalidScopes)('rejects invalid claim scope %s=%j', async (key, value) => {
    await claimedJob(db)
    await rejected(() => claim(db, edit(scopeFixture(), key.split('.'), value)))
  })

  it.each(['version', 'policyVersion', 'source', 'accountId', 'metaAccountId', 'timezone', 'currency', 'detailIds',
    'requestedRange', 'requestedRange.from', 'requestedRange.to', 'range', 'range.from', 'range.to',
    'comparison', 'comparison.from', 'comparison.to'])('rejects missing/null claim scope field %s', async key => {
    await claimedJob(db)
    for (const value of [undefined, null]) await rejected(() => claim(db, edit(scopeFixture(), key.split('.'), value)))
  })

  it('rejects extra scope/range keys, non-Meta details, malformed JSON, null force and noncanonical dates', async () => {
    await claimedJob(db)
    await rejected(() => claim(db, { ...scopeFixture(), extra: true }))
    await rejected(() => claim(db, { ...scopeFixture(), range: { ...scopeFixture().range, extra: true } }))
    await rejected(() => claim(db, { ...scopeFixture('business'), detailIds: ['ad_1'] }))
    await rejected(() => db.query('SELECT public.claim_reporting_refresh($1,true)', ['{bad']))
    await rejected(() => db.query('SELECT public.claim_reporting_refresh($1,$2)', [canonical(scopeFixture()), null]))
    await rejected(() => claim(db, edit(scopeFixture(), ['comparison', 'from'], '0000-08-28')))
  })

  it('shares an active lease even for forced refresh and independently scopes other accounts/details', async () => {
    const first = await claimedJob(db)
    expect(await claim(db, scopeFixture(), false)).toEqual({ claimed: false, job: first })
    expect(await claim(db)).toEqual({ claimed: false, job: first })
    expect((await claimedJob(db, { ...scopeFixture(), accountId: OTHER_ACCOUNT })).id).not.toBe(first.id)
    expect((await claimedJob(db, { ...scopeFixture(), detailIds: [] })).id).not.toBe(first.id)
    await rejected(() => db.query(`INSERT INTO public.reporting_refresh_jobs
      (ad_account_id,source,scope_key,scope_canonical,started_at,lease_expires_at,created_at)
      SELECT ad_account_id,source,scope_key,scope_canonical,started_at,lease_expires_at,created_at
      FROM public.reporting_refresh_jobs WHERE id=$1`, [first.id]), '23505')
  })

  it('rejects equivalent noncanonical scope encodings instead of creating parallel leases', async () => {
    const job = await claimedJob(db), scope = scopeFixture()
    for (const text of [JSON.stringify(scope), JSON.stringify(scope, null, 2), ` ${canonical(scope)}`,
      canonical(scope).replace('act_123', 'act_\\u003123')]) {
      await rejected(() => db.query('SELECT public.claim_reporting_refresh($1,true)', [text]))
    }
    expect((await claim(db)).job?.id).toBe(job.id)
    expect((await db.query('SELECT count(*)::int count FROM public.reporting_refresh_jobs')).rows).toEqual([{ count: 1 }])
  })

  it('reuses recent last-good evidence for normal opens and permits a forced refresh', async () => {
    const job = await claimedJob(db), result = await finish(db, job)
    expect(await claim(db, scopeFixture(), false)).toEqual({ claimed: false, job: null })
    expect((await claimedJob(db)).id).not.toBe(job.id)
    expect(await snapshotCount()).toBe(1)
    expect((await readJob(db, job.id)).snapshot_id).toBe(result.snapshot_id)
  })

  it.each([[59, false], [61, true]] as const)('reuses evidence completed %i seconds ago only within 60 seconds', async (age, claimed) => {
    const historical = await expiredJob(db)
    const observed = (await db.query<{ value: string }>(`SELECT to_jsonb(date_trunc('milliseconds',clock_timestamp())-$1::interval) value`,
      [`${age} seconds`])).rows[0].value
    const snapshot = jobSnapshot({ ...historical, started_at: observed })
    await insertRow(db, rowFor(snapshot, snapshot.scope, { retrieval_started_at: observed, retrieval_completed_at: observed }))
    expect(await claim(db, scopeFixture(), false)).toMatchObject({ claimed, job: claimed ? expect.any(Object) : null })
  })

  it('orders reuse by retrieval start before completion, rather than newest insertion', async () => {
    const historical = await expiredJob(db), snapshot = jobSnapshot(historical)
    const olderStart = new Date(Date.parse(historical.started_at) - 60_000).toISOString()
    const recentCompletion = new Date().toISOString()
    const olderSlow = { ...snapshot, retrieval: { startedAt: olderStart, completedAt: recentCompletion },
      packet: { ...snapshot.packet, context: { ...snapshot.packet.context, asOf: olderStart } } }
    await insertRow(db, rowFor(snapshot, snapshot.scope, { retrieval_started_at: snapshot.retrieval.startedAt,
      retrieval_completed_at: snapshot.retrieval.completedAt }))
    await insertRow(db, rowFor(olderSlow, olderSlow.scope, { retrieval_started_at: olderStart, retrieval_completed_at: recentCompletion }))
    expect((await claim(db, scopeFixture(), false)).claimed).toBe(true)
  })

  it('fails expired attempts before reclaim and fences old progress/completion/failure', async () => {
    const old = await expiredJob(db)
    expect(await progress(db, old)).toBe(false)
    expect(await finish(db, old)).toEqual({ committed: false, snapshot_id: null })
    const current = await claimedJob(db)
    expect(current.id).not.toBe(old.id)
    expect(current.lease_token).not.toBe(old.lease_token)
    expect(await readJob(db, old.id)).toMatchObject({ status: 'failed', failure_code: 'interrupted', completed_at: expect.any(String) })
    expect(await progress(db, old)).toBe(false)
    expect(await finish(db, old)).toEqual({ committed: false, snapshot_id: null })
    expect(await fail(db, old)).toBe(false)
    expect(await snapshotCount()).toBe(0)
    expect((await finish(db, current)).committed).toBe(true)
  })

  it('publishes one leased Meta progress packet without creating a snapshot', async () => {
    const job = await claimedJob(db), packet = progressPacket(job), encoded = canonical(packet)
    expect(await progress(db, job, packet)).toBe(true)
    const stored = await readJob(db, job.id)
    expect(stored).toMatchObject({ status: 'running', progress_canonical: encoded,
      progress_fingerprint: fingerprint(encoded), progress_at: expect.any(String), snapshot_id: null })
    expect(await snapshotCount()).toBe(0)
    expect(await progress(db, job, packet)).toBe(true)
    expect(await readJob(db, job.id)).toEqual(stored)
    expect(await progress(db, job, { ...packet, notes: ['different packet'] })).toBe(false)
    expect((await finish(db, job)).committed).toBe(true)
    expect(await progress(db, job, packet)).toBe(false)
    expect((await readJob(db, job.id)).progress_canonical).toBe(encoded)
  })

  const invalidProgress: [string, unknown][] = [
    ['section', 'business'], ['context.account.id', OTHER_ACCOUNT], ['context.account.metaAccountId', 'act_456'],
    ['context.range.to', '2026-09-03'], ['context.comparison.from', '2026-08-27'], ['context.timezone', 'UTC'],
    ['context.currency', 'EUR'], ['context.asOf', 'infinity'], ['context.asOf', '2001-01-01T00:00:00.000Z'],
    ['result.state', 'available'], ['result.state', 'loading'], ['result.data.detailState', 'complete'],
    ['result.data.detailState', null], ['result.data', null], ['result.asOf', 'infinity'],
  ]
  it.each(invalidProgress)('rejects mismatched/nonpending progress %s=%j', async (key, value) => {
    const job = await claimedJob(db)
    await rejected(() => progress(db, job, edit(progressPacket(job), key.split('.'), value)))
    expect((await readJob(db, job.id)).progress_canonical).toBeNull()
  })

  it.each(['context', 'context.account', 'context.account.id', 'context.account.name', 'context.account.metaAccountId',
    'context.range', 'context.comparison', 'context.timezone', 'context.currency', 'context.asOf', 'section',
    'result', 'result.state', 'result.data', 'result.data.detailState', 'result.asOf'])('rejects omitted progress field %s', async key => {
    const job = await claimedJob(db)
    await rejected(() => progress(db, job, edit(progressPacket(job), key.split('.'), undefined)))
  })

  it('refuses progressive publication for non-Meta jobs', async () => {
    const job = await claimedJob(db, scopeFixture('business'))
    await rejected(() => progress(db, job))
    expect(await snapshotCount()).toBe(0)
  })

  it.each(['accountId', 'metaAccountId', 'source', 'range', 'comparison', 'requestedRange', 'detailIds', 'timezone', 'currency', 'version', 'policyVersion'])
  ('requires final snapshot scope to equal the claimed scope: %s', async key => {
    const job = await claimedJob(db), snapshot = jobSnapshot(job)
    const values: Record<string, unknown> = { accountId: OTHER_ACCOUNT, metaAccountId: 'act_456', source: 'business',
      range: { from: '2026-09-01', to: '2026-09-03' }, comparison: { from: '2026-08-29', to: '2026-08-31' },
      requestedRange: { from: '2026-09-01', to: '2026-09-10' }, detailIds: [], timezone: 'UTC', currency: 'EUR', version: 2, policyVersion: 'other' }
    await rejected(() => finish(db, job, edit(snapshot, ['scope', key], values[key])))
    expect(await snapshotCount()).toBe(0)
    expect((await readJob(db, job.id)).status).toBe('running')
  })

  it('binds completion to the database start instant and applies existing terminal/source chronology guards', async () => {
    const job = await claimedJob(db), snapshot = jobSnapshot(job)
    for (const [key, value] of [['retrieval.startedAt', '2001-01-01T00:00:00.000Z'],
      ['packet.context.asOf', '2001-01-01T00:00:00.000Z'], ['packet.result.data.detailState', 'loading'],
      ['packet.result.state', 'unavailable'], ['retrieval.completedAt', '2001-01-01T00:00:00.000Z'],
      ['sourceAsOf', '2099-01-01T00:00:00.000Z']] as const) {
      await rejected(() => finish(db, job, edit(snapshot, key.split('.'), value)))
    }
    expect(await snapshotCount()).toBe(0)
    expect((await finish(db, job)).committed).toBe(true)
  })

  it('rejects final source retrieval that finishes after the database publication clock', async () => {
    const job = await claimedJob(db), snapshot = jobSnapshot(job)
    const future = { ...snapshot, retrieval: { ...snapshot.retrieval, completedAt: new Date(Date.now() + 60_000).toISOString() } }
    await rejected(() => finish(db, job, future))
    expect(await snapshotCount()).toBe(0)
    expect((await readJob(db, job.id)).status).toBe('running')
    expect((await finish(db, job)).committed).toBe(true)
  })

  it('fences wrong/missing tokens and unknown IDs before any publication or failure', async () => {
    const job = await claimedJob(db)
    for (const invalid of [{ ...job, lease_token: randomUUID() }, { ...job, id: randomUUID() }]) {
      expect(await progress(db, invalid)).toBe(false)
      expect(await finish(db, invalid)).toEqual({ committed: false, snapshot_id: null })
      expect(await fail(db, invalid)).toBe(false)
    }
    const missing = await db.query(`SELECT public.publish_reporting_refresh_progress($1,NULL,$2) progress,
      public.finish_reporting_refresh($1,NULL,$3) finish,public.fail_reporting_refresh($1,NULL,'interrupted') fail`,
    [job.id, canonical(progressPacket(job)), canonical(jobSnapshot(job))])
    expect(missing.rows).toEqual([{ progress: false, finish: { committed: false, snapshot_id: null }, fail: false }])
    expect(await snapshotCount()).toBe(0)
    expect((await readJob(db, job.id)).status).toBe('running')
  })

  it('rolls back the inserted snapshot if marking the job complete fails', async () => {
    const job = await claimedJob(db)
    await db.exec(`CREATE FUNCTION public.reject_refresh_completion() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.status='complete' THEN RAISE EXCEPTION 'simulated completion write failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER reject_refresh_completion BEFORE UPDATE ON public.reporting_refresh_jobs
      FOR EACH ROW EXECUTE FUNCTION public.reject_refresh_completion();`)
    await rejected(() => finish(db, job), 'P0001')
    expect(await snapshotCount()).toBe(0)
    expect((await readJob(db, job.id)).status).toBe('running')
    await db.exec('DROP TRIGGER reject_refresh_completion ON public.reporting_refresh_jobs')
    expect((await finish(db, job)).committed).toBe(true)
  })

  it('returns the original snapshot for identical completion retries and refuses different evidence', async () => {
    const job = await claimedJob(db), result = await finish(db, job)
    expect(await finish(db, job)).toEqual(result)
    expect(await finish(db, job, { ...jobSnapshot(job), sourceAsOf: null })).toEqual({ committed: false, snapshot_id: null })
    expect(await finish(db, { ...job, lease_token: randomUUID() })).toEqual({ committed: false, snapshot_id: null })
    expect(await fail(db, job)).toBe(false)
    expect(await snapshotCount()).toBe(1)
  })

  it('accepts identical completed retries after expiry without reopening the lease', async () => {
    const historical = await expiredJob(db), snapshot = jobSnapshot(historical)
    const stored = (await insertRow(db, rowFor(snapshot, snapshot.scope, {
      retrieval_started_at: snapshot.retrieval.startedAt, retrieval_completed_at: snapshot.retrieval.completedAt }))).rows[0]
    // Seed a distinct historical completed attempt; no clocks or identities are rewritten.
    const completed = (await db.query<{ value: RefreshRow }>(`INSERT INTO public.reporting_refresh_jobs
      (ad_account_id,source,scope_key,scope_canonical,status,started_at,lease_expires_at,lease_token,completed_at,snapshot_id,created_at)
      SELECT ad_account_id,source,scope_key,scope_canonical,'complete',started_at,lease_expires_at,
        lease_token,started_at+interval '1 second',$2,created_at FROM public.reporting_refresh_jobs WHERE id=$1
      RETURNING to_jsonb(reporting_refresh_jobs) value`, [historical.id, stored.id])).rows[0].value
    expect(await finish(db, completed, snapshot)).toEqual({ committed: true, snapshot_id: stored.id })
    expect(await snapshotCount()).toBe(1)
  })

  it.each(['source_unavailable', 'invalid_report', 'storage_unavailable', 'interrupted'])('fails an owned attempt with %s and keeps last-good evidence', async code => {
    const good = await claimedJob(db), saved = await finish(db, good), refresh = await claimedJob(db)
    expect(await progress(db, refresh)).toBe(true)
    expect(await fail(db, refresh, code)).toBe(true)
    expect(await readJob(db, refresh.id)).toMatchObject({ status: 'failed', failure_code: code,
      completed_at: expect.any(String), snapshot_id: null, progress_canonical: expect.any(String) })
    expect(await finish(db, refresh)).toEqual({ committed: false, snapshot_id: null })
    expect(await progress(db, refresh)).toBe(false)
    expect(await fail(db, refresh)).toBe(false)
    expect((await readJob(db, good.id)).snapshot_id).toBe(saved.snapshot_id)
    expect(await snapshotCount()).toBe(1)
  })

  it('rejects arbitrary failure text instead of persisting source exceptions', async () => {
    const job = await claimedJob(db)
    for (const code of ['private upstream error', '', null]) await rejected(() => fail(db, job, code))
    expect((await readJob(db, job.id)).status).toBe('running')
  })

  it('binds source time to recorded progress time and completion after progress', async () => {
    const job = await expiredJob(db), packet = progressPacket(job)
    const futureSource = { ...packet, result: { ...packet.result, asOf: new Date().toISOString() } }
    const write = (value: unknown) => db.query(`UPDATE public.reporting_refresh_jobs
      SET progress_canonical=$2,progress_fingerprint=$3,progress_at=started_at+interval '1 second' WHERE id=$1`,
    [job.id, canonical(value), fingerprint(canonical(value))])
    await rejected(() => write(futureSource))
    await write(packet)
    await rejected(() => db.exec(`UPDATE public.reporting_refresh_jobs SET status='failed',
      failure_code='interrupted',completed_at=started_at`))
    expect(await fail(db, job, 'interrupted')).toBe(true)
  })

  it('denies browser reads/calls and grants only service SELECT and narrow refresh functions', async () => {
    const job = await claimedJob(db)
    for (const role of ['anon', 'authenticated']) {
      await db.exec(`SET LOCAL ROLE ${role}`)
      await rejected(() => db.query('SELECT * FROM public.reporting_refresh_jobs'), '42501')
      await rejected(() => claim(db), '42501')
      await rejected(() => progress(db, job), '42501')
      await rejected(() => finish(db, job), '42501')
      await rejected(() => fail(db, job), '42501')
      await db.exec('RESET ROLE')
    }
    await db.exec('SET LOCAL ROLE service_role')
    expect((await readJob(db, job.id)).id).toBe(job.id)
    expect((await claim(db)).job?.id).toBe(job.id)
    const snapshot = jobSnapshot(job)
    await rejected(() => insertRow(db, rowFor(snapshot, snapshot.scope, {
      retrieval_started_at: snapshot.retrieval.startedAt, retrieval_completed_at: snapshot.retrieval.completedAt })), '42501')
    for (const sql of ["INSERT INTO public.reporting_refresh_jobs DEFAULT VALUES", "UPDATE public.reporting_refresh_jobs SET status='failed'",
      'DELETE FROM public.reporting_refresh_jobs', 'TRUNCATE public.reporting_refresh_jobs']) await rejected(() => db.exec(sql), '42501')
    expect(await progress(db, job)).toBe(true)
    expect((await finish(db, job)).committed).toBe(true)
    const next = await claimedJob(db)
    expect(await fail(db, next)).toBe(true)
    await db.exec('RESET ROLE')
    const functions = (await db.query<{ proname: string; prosecdef: boolean; proconfig: string[] }>(`SELECT proname,prosecdef,proconfig
      FROM pg_proc WHERE proname IN ('claim_reporting_refresh','publish_reporting_refresh_progress','finish_reporting_refresh','fail_reporting_refresh')`)).rows
    expect(functions).toHaveLength(4)
    expect(functions.every(fn => fn.prosecdef && fn.proconfig.includes('search_path=pg_catalog, pg_temp'))).toBe(true)
  })

  it('round-trips real RPC/row serialization through the SDK and refresh repository', async () => {
    const client = refreshTestClient(db), scope = ReportingSnapshotScopeSchema.parse(scopeFixture())
    await db.exec('SET LOCAL ROLE service_role')
    const initial = await claimReportingRefresh(client, scope, false)
    expect(initial.claimed).toBe(true)
    const job = initial.job!
    const raw = await readJob(db, job.id), packet = validateReportingPacket(progressPacket(raw))
    expect(job.startedAt).toBe(new Date(raw.started_at).toISOString())
    expect(await readReportingRefreshJob(client, scope, job.id)).toEqual(job)
    expect(await publishReportingRefreshProgress(client, job, packet)).toBe(true)
    expect((await readReportingRefreshJob(client, scope))?.progress).toEqual(packet)
    const snapshot = createReportingSnapshot(scope, validateReportingPacket(jobSnapshot(raw).packet), new Date().toISOString())
    const completed = await finishReportingRefresh(client, job, snapshot)
    expect(completed).toEqual({ committed: true, snapshotId: expect.any(String) })
    expect(await readReportingSnapshotById(client, scope, completed.snapshotId!)).toMatchObject({ id: completed.snapshotId, snapshot })
    expect(await readReportingRefreshJob(client, scope, job.id)).toMatchObject({ status: 'complete', snapshotId: completed.snapshotId, progress: packet })
    expect(await claimReportingRefresh(client, scope, false)).toEqual({ claimed: false, job: null })
    const next = (await claimReportingRefresh(client, scope, true)).job!
    expect(await failReportingRefresh(client, next, 'source_unavailable')).toBe(true)
    expect(await readReportingRefreshJob(client, scope, next.id)).toMatchObject({ status: 'failed', failureCode: 'source_unavailable' })
    expect(await readReportingRefreshJob(client, { ...scope, accountId: OTHER_ACCOUNT }, next.id)).toBeNull()
    await db.exec('RESET ROLE')
  })

  it('runs the real worker and loader through pending progress, publication and failure with only source readers mocked', async () => {
    const client = refreshTestClient(db), scope = ReportingSnapshotScopeSchema.parse(scopeFixture())
    await db.exec('SET LOCAL ROLE service_role')
    const job = (await claimReportingRefresh(client, scope, true)).job!
    const raw = await readJob(db, job.id), pending = validateReportingPacket(progressPacket(raw))
    const terminal = validateReportingPacket(jobSnapshot(raw).packet)
    if (pending.section !== 'meta' || terminal.section !== 'meta') throw new Error('Expected Meta fixtures')
    let completeSource: ((value: Awaited<ReturnType<typeof readMetaReport>>) => void) | undefined
    vi.mocked(readMetaReport).mockImplementation(async (_context, options) => {
      options?.onProgress?.(pending.result)
      return new Promise(resolve => { completeSource = resolve })
    })
    const running = runReportingRefresh(client, job, 'Synthetic studio')
    try {
      await vi.waitFor(async () => {
        expect(await readReportingRefreshJob(client, scope, job.id)).toMatchObject({ status: 'running', progress: pending, snapshotId: null })
      }, { timeout: 2000, interval: 10 })
      expect(await snapshotCount()).toBe(0)
    } finally { completeSource?.(terminal.result) }
    const result = await running
    expect(result).toEqual({ status: 'complete', snapshotId: expect.any(String) })
    if (result.status !== 'complete') throw new Error('Expected committed worker result')
    const saved = await readReportingSnapshotById(client, scope, result.snapshotId)
    expect(saved).toMatchObject({ id: result.snapshotId, snapshot: { packet: terminal, scope } })
    const next = (await claimReportingRefresh(client, scope, true)).job!
    vi.mocked(readMetaReport).mockRejectedValueOnce(new Error('Synthetic source unavailable'))
    expect(await runReportingRefresh(client, next, 'Synthetic studio')).toEqual({ status: 'failed', failureCode: 'source_unavailable' })
    expect(await readReportingRefreshJob(client, scope, next.id)).toMatchObject({ status: 'failed', snapshotId: null })
    expect(await readReportingSnapshotById(client, scope, result.snapshotId)).toEqual(saved)
    expect(await snapshotCount()).toBe(1)
    await db.exec('RESET ROLE')
  })

  it('retains a leased progress packet across database close and reopen before final publication', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'reporting-refresh-132-'))
    let persisted: PGlite | undefined
    try {
      persisted = await prepareRefreshDb(directory)
      const job = await claimedJob(persisted)
      expect(await progress(persisted, job)).toBe(true)
      const before = await readJob(persisted, job.id)
      await persisted.close()
      persisted = new PGlite(directory)
      expect(await readJob(persisted, job.id)).toEqual(before)
      expect((await claim(persisted)).job?.id).toBe(job.id)
      expect((await finish(persisted, job)).committed).toBe(true)
      expect((await readJob(persisted, job.id)).status).toBe('complete')
    } finally {
      await persisted?.close()
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  it('guards immutable attempt identity, progress, terminal history, deletion and truncation even for the owner', async () => {
    const job = await claimedJob(db)
    for (const assignment of ["id=gen_random_uuid()", `ad_account_id='${OTHER_ACCOUNT}'`, "source='business'",
      "scope_key='sha256:'||repeat('0',64)", "scope_canonical='{}'", "started_at=started_at-interval '1 second'",
      "lease_expires_at=lease_expires_at+interval '1 second'", 'lease_token=gen_random_uuid()', "created_at=created_at-interval '1 second'"]) {
      await rejected(() => db.exec(`UPDATE public.reporting_refresh_jobs SET ${assignment}`), '23514')
    }
    await progress(db, job)
    await rejected(() => db.exec('UPDATE public.reporting_refresh_jobs SET progress_canonical=NULL,progress_fingerprint=NULL,progress_at=NULL'), '23514')
    await finish(db, job)
    await rejected(() => db.exec("UPDATE public.reporting_refresh_jobs SET status='running',completed_at=NULL,snapshot_id=NULL"), '23514')
    await rejected(() => db.exec('DELETE FROM public.reporting_refresh_jobs'), '23514')
    await rejected(() => db.exec('TRUNCATE public.reporting_refresh_jobs'), '23514')
    expect(await snapshotCount()).toBe(1)
  })

  it.each(['scope', 'progress', 'snapshot'])('bounds %s canonical UTF-8 payload before JSON parsing', async kind => {
    const job = await claimedJob(db)
    const sql = kind === 'scope' ? "SELECT public.claim_reporting_refresh(repeat('é',33554433),true)"
      : `SELECT public.${kind === 'progress' ? 'publish_reporting_refresh_progress' : 'finish_reporting_refresh'}($1,$2,repeat('é',33554433))`
    await rejected(() => db.query(sql, kind === 'scope' ? [] : [job.id, job.lease_token]))
    expect(await snapshotCount()).toBe(0)
  })
})
