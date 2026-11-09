import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { canonical, fingerprint, insertRow, rowFor, snapshotFixture } from './reporting-snapshot-fixture'
import { claim, claimedJob, finish, jobSnapshot, progress, progressPacket, readJob, refreshTestClient, scopeFixture, type RefreshRow } from './reporting-refresh-fixture'
import { prepareSavedDb } from './reporting-saved-fixture'
import { canonicalReportingJson, createReportingSnapshot, reportingFingerprint, ReportingSnapshotScopeSchema } from '@/lib/reporting/snapshot-contract'
import { claimReportingRefresh, finishReportingRefresh, publishReportingRefreshProgress, readReportingRefreshJob } from '@/lib/reporting/refresh-jobs'
import { validateReportingPacket } from '@/lib/reporting/validation'
import { readReportingSnapshotById } from '@/lib/reporting/snapshot-store'
import { compactReportingPacket } from '@/lib/reporting/packet-format'

const parentScope = (level = 'campaign', id = 'parent_01-A') => ({
  ...scopeFixture(), detailIds: [], historyEntity: { level, id },
})
const parentSnapshot = (scope: ReturnType<typeof scopeFixture>) => ({ ...snapshotFixture(scope.source), scope })
const invalidSelectors: [string, unknown][] = [
  ['null', null], ['array', []], ['string', 'campaign'], ['empty', {}], ['missing id', { level: 'campaign' }],
  ['missing level', { id: '01' }], ['ad', { level: 'ad', id: '01' }], ['account', { level: 'account', id: '01' }],
  ['case', { level: 'Campaign', id: '01' }], ['level number', { level: 1, id: '01' }],
  ['id number', { level: 'campaign', id: 1 }], ['id null', { level: 'campaign', id: null }],
  ['empty id', { level: 'campaign', id: '' }], ['whitespace id', { level: 'campaign', id: ' x ' }],
  ['newline id', { level: 'campaign', id: 'x\n' }], ['slash id', { level: 'campaign', id: 'x/y' }],
  ['unicode id', { level: 'campaign', id: 'café' }], ['long id', { level: 'campaign', id: 'x'.repeat(161) }],
  ['extra key', { level: 'campaign', id: '01', extra: true }],
]

describe('selected-parent canonical scope and fenced storage', () => {
  let db: PGlite
  let legacy: { source: string; id: string; jobId: string; row: unknown; job: unknown }[]
  beforeAll(async () => {
    db = await prepareSavedDb()
    legacy = []
    for (const source of ['meta', 'business', 'website', 'measurement']) {
      const job = await claimedJob(db, scopeFixture(source)), saved = await finish(db, job)
      const row = (await db.query('SELECT * FROM public.reporting_snapshots WHERE id=$1', [saved.snapshot_id])).rows[0]
      legacy.push({ source, id: saved.snapshot_id!, jobId: job.id, row, job: await readJob(db, job.id) })
    }
  })
  beforeEach(async () => { await db.exec('BEGIN') })
  afterEach(async () => { await db.exec('ROLLBACK') })
  afterAll(async () => { await db?.close() })
  async function rejected(run: () => Promise<unknown>, code = '23514') {
    await db.exec('SAVEPOINT invalid')
    await expect(run()).rejects.toMatchObject({ code })
    await db.exec('ROLLBACK TO SAVEPOINT invalid; RELEASE SAVEPOINT invalid')
  }
  async function count() {
    return (await db.query<{ count: number }>('SELECT count(*)::int count FROM public.reporting_snapshots')).rows[0].count
  }

  it.each(['meta', 'business', 'website', 'measurement'])('preserves old %s bytes, fingerprints and completed rows', async source => {
    const old = legacy.find(item => item.source === source)!
    expect((await db.query('SELECT * FROM public.reporting_snapshots WHERE id=$1', [old.id])).rows[0]).toEqual(old.row)
    expect(await readJob(db, old.jobId)).toEqual(old.job)
    const scope = scopeFixture(source), job = await claimedJob(db, scope)
    expect(job.scope_canonical).toBe(canonical(scope))
    expect(job.scope_key).toBe(fingerprint(canonical(scope)))
    expect(job.scope_canonical).not.toContain('historyEntity')
    expect((await finish(db, job)).committed).toBe(true)
  })

  it.each(['campaign', 'adset'])('accepts canonical %s history and exactly shares its active claim', async level => {
    const scope = parentScope(level), job = await claimedJob(db, scope)
    expect(job.scope_canonical).toBe(canonical(scope))
    expect(job.scope_key).toBe(fingerprint(canonical(scope)))
    expect(job.scope_canonical).toContain('"detailIds":[],"historyEntity":{"id":"parent_01-A","level":"' + level + '"},"metaAccountId"')
    expect(await claim(db, scope, false)).toEqual({ claimed: false, job })
    expect(await claim(db, scope, true)).toEqual({ claimed: false, job })
    const direct = parentSnapshot(scope)
    expect((await insertRow(db, rowFor(direct))).rows[0]).toMatchObject({ id: expect.any(String) })
  })

  it('keeps level, exact ID, legacy and ad detail populations separate', async () => {
    const scopes = [parentScope(), parentScope('adset'), parentScope('campaign', 'parent_01-B'),
      { ...scopeFixture(), detailIds: [] }, scopeFixture()]
    const jobs = []
    for (const scope of scopes) jobs.push(await claimedJob(db, scope))
    expect(new Set(jobs.map(job => job.id)).size).toBe(5)
    expect(new Set(jobs.map(job => job.scope_key)).size).toBe(5)
    await finish(db, jobs[0])
    expect(await claim(db, scopes[0], false)).toEqual({ claimed: false, job: null })
    expect(await claim(db, scopes[1], false)).toEqual({ claimed: false, job: jobs[1] })
  })

  it.each(invalidSelectors)('rejects malformed parent selector %s in claims and direct snapshot trigger', async (_name, selector) => {
    await claimedJob(db) // Same instrument positive legacy control before each rejection.
    const scope = { ...scopeFixture(), detailIds: [], historyEntity: selector }
    await rejected(() => claim(db, scope))
    await rejected(() => insertRow(db, rowFor(parentSnapshot(scope))))
    expect(await count()).toBe(legacy.length)
  })

  it.each(['business', 'website', 'measurement'])('rejects parent selector for %s at both storage boundaries', async source => {
    await claimedJob(db, scopeFixture(source))
    const scope = { ...parentScope(), source }, snapshot = parentSnapshot(scope)
    await rejected(() => claim(db, scope))
    await rejected(() => insertRow(db, rowFor(snapshot, scope, { source })))
  })

  it('rejects mixed parent/ad detail populations and unrelated extra keys', async () => {
    await claimedJob(db)
    for (const scope of [{ ...parentScope(), detailIds: ['ad_1'] }, { ...parentScope(), extra: 1 }]) {
      await rejected(() => claim(db, scope))
      await rejected(() => insertRow(db, rowFor(parentSnapshot(scope))))
    }
  })

  it('accepts 1 and 160 character opaque IDs without trimming, case-folding or numeric coercion', async () => {
    const scopes = ['A', 'a', '01', '1', 'x'.repeat(160)].map(id => parentScope('adset', id))
    const keys = []
    for (const scope of scopes) keys.push((await claimedJob(db, scope)).scope_key)
    expect(new Set(keys).size).toBe(scopes.length)
  })

  it('rejects alternate encodings of the same parent scope before creating duplicate leases', async () => {
    const scope = parentScope(), text = canonical(scope), job = await claimedJob(db, scope)
    const alternatives = [JSON.stringify(scope), JSON.stringify(scope, null, 2), ` ${text}`,
      text.replace('"id":"parent_01-A","level":"campaign"', '"level":"campaign","id":"parent_01-A"'),
      text.replace('parent_01-A', 'parent_01-\\u0041'), text.replace('"historyEntity":', '"historyEntity" :')]
    for (const encoding of alternatives) {
      expect(JSON.parse(encoding)).toEqual(scope)
      await rejected(() => db.query('SELECT public.claim_reporting_refresh($1,true)', [encoding]))
      await rejected(() => insertRow(db, rowFor(parentSnapshot(scope), scope, {
        scope_canonical: encoding, scope_key: fingerprint(encoding),
      })))
    }
    expect(await claim(db, scope)).toEqual({ claimed: false, job })
  })

  it('publishes pending progress without a snapshot, then commits and retries the exact selected-parent snapshot', async () => {
    const job = await claimedJob(db, parentScope())
    expect(await progress(db, job)).toBe(true)
    expect(await count()).toBe(legacy.length)
    expect((await readJob(db, job.id)).progress_fingerprint).toMatch(/^sha256:/)
    const result = await finish(db, job)
    expect(result).toEqual({ committed: true, snapshot_id: expect.any(String) })
    expect(await finish(db, job)).toEqual(result)
    const row = (await db.query<{ scope_canonical: string; snapshot_canonical: string }>(
      'SELECT scope_canonical,snapshot_canonical FROM public.reporting_snapshots WHERE id=$1', [result.snapshot_id])).rows[0]
    expect(row.scope_canonical).toBe(job.scope_canonical)
    expect(row.snapshot_canonical).toBe(canonical(jobSnapshot(job)))
    expect((await readJob(db, job.id)).snapshot_id).toBe(result.snapshot_id)
    expect(await count()).toBe(legacy.length + 1)
  })

  it('fences missing or different selector level/ID and another selected-parent lease token', async () => {
    const job = await claimedJob(db, parentScope()), other = await claimedJob(db, parentScope('adset'))
    for (const scope of [{ ...scopeFixture(), detailIds: [] }, parentScope('adset'), parentScope('campaign', 'other')]) {
      await rejected(() => finish(db, job, { ...jobSnapshot(job), scope }))
    }
    expect(await finish(db, { ...job, lease_token: other.lease_token })).toEqual({ committed: false, snapshot_id: null })
    expect(await progress(db, { ...job, lease_token: randomUUID() })).toBe(false)
    expect(await count()).toBe(legacy.length)
    expect((await readJob(db, job.id)).status).toBe('running')
    expect((await finish(db, job)).committed).toBe(true)
  })

  it('retains atomic finish rollback when a later job update fails', async () => {
    const job = await claimedJob(db, parentScope())
    await db.exec(`CREATE FUNCTION public.reject_parent_completion() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.status='complete' THEN RAISE EXCEPTION 'simulated completion failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER reject_parent_completion BEFORE UPDATE ON public.reporting_refresh_jobs
      FOR EACH ROW EXECUTE FUNCTION public.reject_parent_completion()`)
    await rejected(() => finish(db, job), 'P0001')
    expect(await count()).toBe(legacy.length)
    expect((await readJob(db, job.id)).status).toBe('running')
  })

  it('round-trips real SDK progress, publication and exact snapshot reads for both parent levels and legacy scopes', async () => {
    const client = refreshTestClient(db)
    for (const raw of [scopeFixture(), parentScope(), parentScope('adset')]) {
      const scope = ReportingSnapshotScopeSchema.parse(raw)
      const result = await claimReportingRefresh(client, scope, true)
      expect(result.claimed).toBe(true)
      expect(result.job?.scope).toEqual(scope)
      expect(result.job?.scopeKey).toBe(reportingFingerprint(scope))
      const stored = await readJob(db, result.job!.id)
      expect(stored.scope_canonical).toBe(canonicalReportingJson(scope))
      expect(await readReportingRefreshJob(client, scope, result.job!.id)).toEqual(result.job)
      const pending = validateReportingPacket(progressPacket(stored))
      expect(await publishReportingRefreshProgress(client, result.job!, pending)).toBe(true)
      expect((await readReportingRefreshJob(client, scope, result.job!.id))?.progress).toEqual(pending)
      // An empty observed parent population is allowed; this does not fabricate native history.
      const snapshot = createReportingSnapshot(scope, validateReportingPacket(jobSnapshot(stored).packet), new Date().toISOString())
      const completed = await finishReportingRefresh(client, result.job!, snapshot)
      expect(completed).toEqual({ committed: true, snapshotId: expect.any(String) })
      expect(await readReportingSnapshotById(client, scope, completed.snapshotId!)).toMatchObject({
        // New publications store the packet as v2; the fingerprint covers those stored bytes.
        id: completed.snapshotId, snapshot, fingerprint: reportingFingerprint({ ...snapshot, packet: compactReportingPacket(snapshot.packet) }),
      })
      expect(await readReportingSnapshotById(client, ReportingSnapshotScopeSchema.parse(parentScope('campaign', 'wrong')), completed.snapshotId!)).toBeNull()
      expect(await finishReportingRefresh(client, result.job!, snapshot)).toEqual(completed)
    }
  })

  it('expires the same selected-parent attempt and fences its progress/final after a new claim', async () => {
    const scope = parentScope('adset'), text = canonical(scope)
    // Only the isolated postgres owner seeds historical time; no caller-clock RPC exists.
    const old = (await db.query<{ value: RefreshRow }>(`WITH clock AS MATERIALIZED (
        SELECT date_trunc('milliseconds',clock_timestamp()) now
      ) INSERT INTO public.reporting_refresh_jobs
      (ad_account_id,source,scope_key,scope_canonical,started_at,lease_expires_at,created_at)
      SELECT $1,$2,$3,$4,now-interval '5 minutes',now-interval '3 minutes',now-interval '5 minutes' FROM clock
      RETURNING to_jsonb(reporting_refresh_jobs) value`, [scope.accountId, scope.source, fingerprint(text), text])).rows[0].value
    expect(await progress(db, old)).toBe(false)
    expect(await finish(db, old)).toEqual({ committed: false, snapshot_id: null })
    const next = await claimedJob(db, scope)
    expect(next.id).not.toBe(old.id)
    expect((await readJob(db, old.id)).status).toBe('failed')
    expect(await progress(db, old)).toBe(false)
    expect(await finish(db, old)).toEqual({ committed: false, snapshot_id: null })
    expect(await count()).toBe(legacy.length)
    expect((await finish(db, next)).committed).toBe(true)
  })

  it('does not reuse a fresh selected-parent snapshot for a different level or ID', async () => {
    const first = parentScope(), job = await claimedJob(db, first)
    await finish(db, job)
    expect(await claim(db, first, false)).toEqual({ claimed: false, job: null })
    for (const scope of [parentScope('adset'), parentScope('campaign', 'different')]) {
      expect((await claim(db, scope, false)).claimed).toBe(true)
    }
  })

  it('keeps existing account/date/currency/detail guards with a selected parent', async () => {
    await claimedJob(db, parentScope())
    for (const change of [{ accountId: 'bad' }, { metaAccountId: 'act_bad' }, { timezone: 'UTC' }, { currency: 'EUR' },
      { version: 2 }, { policyVersion: 'different' }, { detailIds: null },
      { range: { from: '2026-09-02', to: '2026-09-04' } },
      { comparison: { from: '2026-08-28', to: '2026-08-30' } },
      { requestedRange: { from: '2026-09-01', to: '2026-09-03' } }]) {
      await rejected(() => claim(db, { ...parentScope(), ...change }))
    }
    await rejected(() => db.query('SELECT public.claim_reporting_refresh($1,true)', ['{bad']))
  })

  it('preserves service-only RPCs, direct-write denial and immutable old/new snapshots', async () => {
    await db.exec('SET ROLE service_role')
    const job = await claimedJob(db, parentScope()), completed = await finish(db, job)
    await rejected(() => db.exec('INSERT INTO public.reporting_snapshots DEFAULT VALUES'), '42501')
    await rejected(() => db.exec('INSERT INTO public.reporting_refresh_jobs DEFAULT VALUES'), '42501')
    await db.exec('RESET ROLE')
    for (const id of [legacy[0].id, completed.snapshot_id]) {
      await rejected(() => db.query('UPDATE public.reporting_snapshots SET scope_key=scope_key WHERE id=$1', [id]), 'P0001')
      await rejected(() => db.query('DELETE FROM public.reporting_snapshots WHERE id=$1', [id]), 'P0001')
    }
    for (const role of ['anon', 'authenticated']) {
      await db.exec(`SET ROLE ${role}`)
      await rejected(() => claim(db, parentScope()), '42501')
      await rejected(() => db.query('SELECT public.validate_reporting_refresh_scope($1)', [canonical(parentScope())]), '42501')
      await rejected(() => db.exec('SELECT * FROM public.reporting_snapshots'), '42501')
      await db.exec('RESET ROLE')
    }
  })
})
