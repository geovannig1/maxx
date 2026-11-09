import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { validateReportingPacket } from '@/lib/reporting/validation'
import { ACCOUNT, OTHER_ACCOUNT, SCHEMA_EXTENSIONS, STARTED, canonical, edit, fingerprint, insertRow,
  prepareDb, rowFor, snapshotFixture } from './reporting-snapshot-fixture'

let db: PGlite
beforeAll(async () => { db = await prepareDb() })
beforeEach(async () => { await db.exec('BEGIN') })
afterEach(async () => { await db.exec('ROLLBACK') })
afterAll(async () => { await db.close() })

async function rejected(row: ReturnType<typeof rowFor>, code = '23514') {
  await db.exec('SAVEPOINT rejected_snapshot')
  try { await expect(insertRow(db, row)).rejects.toMatchObject({ code }) }
  finally { await db.exec('ROLLBACK TO SAVEPOINT rejected_snapshot; RELEASE SAVEPOINT rejected_snapshot') }
}

describe('prepared reporting snapshots', () => {
  it('installs an account-bound table with row-level security', async () => {
    const found = await db.query(`SELECT relrowsecurity FROM pg_catalog.pg_class
      WHERE oid = pg_catalog.to_regclass('public.reporting_snapshots')`)
    expect(found.rows).toEqual([{ relrowsecurity: true }])
  })

  it.each(['meta', 'business', 'website', 'measurement'])('persists terminal %s evidence byte for byte', async source => {
    const snapshot = snapshotFixture(source)
    expect(validateReportingPacket(snapshot.packet)).toEqual(snapshot.packet)
    const row = rowFor(snapshot, snapshot.scope, { source })
    const inserted = (await insertRow(db, row)).rows[0]
    expect(inserted.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(inserted.created_at).toBeInstanceOf(Date)
    expect(inserted.snapshot_canonical).toBe(canonical(snapshot))
    await rejected({ ...row, evidence_fingerprint: `sha256:${'0'.repeat(64)}` })
  })

  const invalidBindings: [string, unknown][] = [
    ['contract', 'other_contract'], ['version', 2], ['version', '1'], ['scope.version', 2], ['scope.version', '1'],
    ['scope.policyVersion', 'reporting-v2'], ['scope.accountId', OTHER_ACCOUNT], ['scope.source', 'business'],
    ['scope.metaAccountId', 'act_unknown'], ['scope.timezone', 'UTC'], ['scope.currency', 'EUR'],
    ['scope.detailIds', ['ad_2', 'ad_1']], ['scope.detailIds', ['ad_1', 'ad_1']],
    ['scope.detailIds', ['ad_1', 'ad_2', 'ad_3']], ['scope.detailIds', ['bad/id']], ['scope.detailIds', [123]],
    ['scope.detailIds', ['a'.repeat(161)]], ['packet.result.data.detailState', null],
    ['scope.requestedRange.from', '2026-08-31'], ['scope.requestedRange.to', '2026-09-03'],
    ['scope.range.from', '2026-09-02'], ['scope.range.to', '2026-09-03'],
    ['scope.range.to', '2026-02-30'], ['scope.range.to', '2026-9-04'],
    ['scope.comparison.from', '2026-08-27'], ['scope.comparison.to', '2026-08-30'],
    ['packet.section', 'business'], ['packet.context.account.id', OTHER_ACCOUNT],
    ['packet.context.account.metaAccountId', 'act_456'], ['packet.context.range.to', '2026-09-03'],
    ['packet.context.comparison.from', '2026-08-27'], ['packet.context.timezone', 'UTC'],
    ['packet.context.currency', 'EUR'], ['packet.result.state', 'loading'],
    ['packet.result.state', 'unavailable'], ['packet.result.data.detailState', 'loading'],
    ['packet.result.data.detailState', 'unavailable'], ['sourceAsOf', '2026-09-05T11:46:00.000Z'],
    ['packet.context.asOf', '2026-09-05T12:00:01.000Z'], ['retrieval.startedAt', '2026-09-05T12:00:01.000Z'],
    ['packet.context.asOf', '2026-09-05T08:00:00.000-04:00'],
    ['retrieval.completedAt', '2026-09-05T12:01:01.000Z'],
  ]

  it.each(invalidBindings)('rejects a rehashed invalid binding: %s = %j', async (key, value) => {
    await insertRow(db)
    const snapshot = edit(snapshotFixture(), key.split('.'), value)
    const scope = (snapshot as ReturnType<typeof snapshotFixture>).scope
    await rejected(rowFor(snapshot, scope))
    expect((await db.query('SELECT count(*)::int count FROM public.reporting_snapshots')).rows).toEqual([{ count: 1 }])
  })

  const required = ['contract', 'version', 'scope', 'scope.version', 'scope.policyVersion', 'scope.accountId',
    'scope.source', 'scope.metaAccountId', 'scope.requestedRange', 'scope.requestedRange.from', 'scope.requestedRange.to',
    'scope.range', 'scope.range.from', 'scope.range.to', 'scope.comparison', 'scope.comparison.from', 'scope.comparison.to',
    'scope.timezone', 'scope.currency', 'scope.detailIds', 'packet', 'packet.context', 'packet.context.account',
    'packet.context.account.id', 'packet.context.account.metaAccountId', 'packet.context.range', 'packet.context.range.from',
    'packet.context.range.to', 'packet.context.comparison', 'packet.context.comparison.from', 'packet.context.comparison.to',
    'packet.context.timezone', 'packet.context.currency', 'packet.context.asOf', 'packet.section', 'packet.result',
    'packet.result.state', 'packet.result.data', 'retrieval', 'retrieval.startedAt', 'retrieval.completedAt']

  it.each(required)('rejects omitted and null required field %s without SQL-null bypass', async key => {
    await insertRow(db)
    for (const value of [undefined, null]) {
      const snapshot = edit(snapshotFixture(), key.split('.'), value)
      const scope = key === 'scope' ? null : (snapshot as ReturnType<typeof snapshotFixture>).scope
      await rejected(rowFor(snapshot, scope))
    }
  })

  it('allows explicit unknown source times and terminal partial evidence but rejects missing timestamps', async () => {
    const snapshot = snapshotFixture()
    const partial = { ...snapshot, sourceAsOf: null, packet: { ...snapshot.packet,
      result: { ...snapshot.packet.result, state: 'partial', asOf: null } } }
    await insertRow(db, rowFor(partial))
    for (const key of ['sourceAsOf', 'packet.result.asOf']) {
      await rejected(rowFor(edit(partial, key.split('.'), undefined)))
    }
    await rejected(rowFor(edit(partial, ['packet', 'result', 'data'], null)))
    await insertRow(db, rowFor(edit(snapshot, ['packet', 'result', 'data', 'detailState'], undefined)))
  })

  it('accepts a null display name but requires the account-name field', async () => {
    await insertRow(db, rowFor(edit(snapshotFixture(), ['packet', 'context', 'account', 'name'], null)))
    await rejected(rowFor(edit(snapshotFixture(), ['packet', 'context', 'account', 'name'], undefined)))
  })

  it('preserves a requested future end separately from the clamped reporting end', async () => {
    const snapshot = edit(snapshotFixture(), ['scope', 'requestedRange', 'to'], '2026-09-10') as ReturnType<typeof snapshotFixture>
    await insertRow(db, rowFor(snapshot, snapshot.scope))
    const business = snapshotFixture('business')
    await rejected(rowFor({ ...business, scope: { ...business.scope, detailIds: ['ad_1'] } },
      { ...business.scope, detailIds: ['ad_1'] }, { source: 'business' }))
  })

  it('binds the envelope scope to the independently hashed scope column', async () => {
    await insertRow(db)
    const scope = { ...snapshotFixture().scope, detailIds: [] }
    await rejected(rowFor(snapshotFixture(), scope))
    await rejected({ ...rowFor(), scope_key: `sha256:${'f'.repeat(64)}` })
    await rejected({ ...rowFor(), source: 'website' })
    await rejected({ ...rowFor(), ad_account_id: OTHER_ACCOUNT })
  })

  it('rejects malformed canonical JSON even when its hash matches', async () => {
    await insertRow(db)
    for (const key of ['snapshot', 'scope'] as const) {
      const malformed = '{invalid JSON'
      await rejected({ ...rowFor(), [`${key}_canonical`]: malformed,
        [key === 'snapshot' ? 'evidence_fingerprint' : 'scope_key']: fingerprint(malformed) })
    }
  })

  it.each(['snapshot_canonical', 'scope_canonical'])('bounds %s by UTF-8 bytes before JSON parsing', async column => {
    await insertRow(db)
    const row = rowFor(), columns = Object.keys(row), parameters = columns.filter(key => key !== column)
    await expect(db.query(`INSERT INTO public.reporting_snapshots(${columns.join(',')})
      VALUES (${columns.map(key => key === column ? "repeat('é', 33554433)" : `$${parameters.indexOf(key) + 1}`).join(',')})`,
    Object.entries(row).filter(([key]) => key !== column).map(([, value]) => value))).rejects.toThrow(/canonical payload limit/)
  })

  it('rejects chronology inversions, infinity, and fabricated source watermarks', async () => {
    await insertRow(db)
    const earlier = snapshotFixture('meta', STARTED, '2026-09-05T11:59:00.000Z')
    await rejected(rowFor(earlier, earlier.scope, { retrieval_completed_at: earlier.retrieval.completedAt }))
    const infinity = snapshotFixture('meta', 'infinity', 'infinity')
    await rejected(rowFor(infinity, infinity.scope, { retrieval_started_at: 'infinity', retrieval_completed_at: 'infinity' }))
    const base = snapshotFixture(), later = '2026-09-05T12:02:00.000Z'
    const future = { ...base, sourceAsOf: later, packet: { ...base.packet, result: { ...base.packet.result, asOf: later } } }
    await rejected(rowFor(future))
  })

  it('enforces immutable unique evidence for identical retries and transaction rollback', async () => {
    const inserted = (await insertRow(db)).rows[0]
    await rejected(rowFor(), '23505')
    await db.exec('SAVEPOINT uncommitted')
    const other = snapshotFixture('business')
    await insertRow(db, rowFor(other, other.scope, { source: 'business' }))
    await db.exec('ROLLBACK TO SAVEPOINT uncommitted; RELEASE SAVEPOINT uncommitted')
    expect((await db.query('SELECT id, snapshot_canonical FROM public.reporting_snapshots')).rows)
      .toEqual([{ id: inserted.id, snapshot_canonical: canonical(snapshotFixture()) }])
  })

  it('orders latest retrieval starts ahead of slow older insertions and breaks ties deterministically', async () => {
    const fresh = snapshotFixture('meta', '2026-09-05T12:02:00.000Z', '2026-09-05T12:03:00.000Z')
    const newRow = (await insertRow(db, rowFor(fresh, fresh.scope, {
      retrieval_started_at: fresh.retrieval.startedAt, retrieval_completed_at: fresh.retrieval.completedAt }))).rows[0]
    const slow = snapshotFixture('meta', STARTED, '2026-09-05T12:04:00.000Z')
    const oldRow = (await insertRow(db, rowFor(slow, slow.scope, { retrieval_completed_at: slow.retrieval.completedAt }))).rows[0]
    const latest = await db.query<{ id: string }>(`SELECT id FROM public.reporting_snapshots
      WHERE ad_account_id=$1 AND source='meta' AND scope_key=$2
      ORDER BY retrieval_started_at DESC, retrieval_completed_at DESC, id DESC`, [ACCOUNT, rowFor().scope_key])
    expect(latest.rows.map(row => row.id)).toEqual([newRow.id, oldRow.id])
    const tiebreak = snapshotFixture('meta', fresh.retrieval.startedAt, '2026-09-05T12:06:00.000Z')
    const tied = await insertRow(db, rowFor(tiebreak, tiebreak.scope, {
      id: '00000000-0000-4000-8000-000000001313',
      retrieval_started_at: tiebreak.retrieval.startedAt, retrieval_completed_at: tiebreak.retrieval.completedAt }))
    expect((await db.query('SELECT id FROM public.reporting_snapshots ORDER BY retrieval_started_at DESC, retrieval_completed_at DESC, id DESC LIMIT 1')).rows)
      .toEqual([{ id: tied.rows[0].id }])
    const sameTime = { ...tiebreak, packet: { ...tiebreak.packet, notes: ['Independent same-time observation'] } }
    await insertRow(db, rowFor(sameTime, sameTime.scope, {
      id: '00000000-0000-4000-8000-000000001314',
      retrieval_started_at: sameTime.retrieval.startedAt, retrieval_completed_at: sameTime.retrieval.completedAt }))
    expect((await db.query('SELECT id FROM public.reporting_snapshots ORDER BY retrieval_started_at DESC, retrieval_completed_at DESC, id DESC LIMIT 1')).rows)
      .toEqual([{ id: '00000000-0000-4000-8000-000000001314' }])
  })

  // service_role holds no INSERT on reporting_snapshots, so evidence is published only
  // through the leased finish_reporting_refresh RPC. The shipped schema is the post-133 state.
  it('gives service_role only SELECT and denies browser roles and PUBLIC', async () => {
    await insertRow(db)
    for (const role of ['anon', 'authenticated', 'service_role']) {
      const privileges = await db.query<{ privilege_type: string }>(`SELECT privilege_type
        FROM information_schema.role_table_grants WHERE table_schema='public'
          AND table_name='reporting_snapshots' AND grantee=$1 ORDER BY privilege_type`, [role])
      expect(privileges.rows.map(row => row.privilege_type)).toEqual(role === 'service_role' ? ['SELECT'] : [])
    }
    expect((await db.query(`SELECT privilege_type FROM information_schema.table_privileges
      WHERE table_name='reporting_snapshots' AND grantee='PUBLIC'`)).rows).toEqual([])
    await db.exec('SET LOCAL ROLE service_role')
    expect((await db.query('SELECT count(*)::int count FROM public.reporting_snapshots')).rows).toEqual([{ count: 1 }])
    const business = snapshotFixture('business')
    await rejected(rowFor(business, business.scope, { source: 'business' }), '42501')
    await db.exec('RESET ROLE; SET LOCAL ROLE authenticated; SAVEPOINT access_denied')
    await expect(db.query('SELECT * FROM public.reporting_snapshots')).rejects.toMatchObject({ code: '42501' })
    await db.exec('ROLLBACK TO SAVEPOINT access_denied; RESET ROLE')
  })

  // Later reporting tables reference snapshots, so a plain TRUNCATE now stops at their foreign keys first;
  // CASCADE reaches past them, and the snapshot guard must still refuse it.
  it.each(['UPDATE public.reporting_snapshots SET source=source', 'DELETE FROM public.reporting_snapshots',
    'TRUNCATE public.reporting_snapshots CASCADE'])('blocks elevated ordinary SQL mutation: %s', async statement => {
    await insertRow(db)
    await db.exec('SAVEPOINT immutable')
    await expect(db.exec(statement)).rejects.toThrow(/immutable|append.only/i)
    await db.exec('ROLLBACK TO SAVEPOINT immutable')
    expect((await db.query('SELECT count(*)::int count FROM public.reporting_snapshots')).rows).toEqual([{ count: 1 }])
  })

  it('prevents account deletion from erasing snapshot history', async () => {
    const inserted = (await insertRow(db)).rows[0]
    expect((await db.query('SELECT id FROM public.reporting_snapshots')).rows).toEqual([{ id: inserted.id }])
    await expect(db.query('DELETE FROM public.ad_accounts WHERE id=$1', [ACCOUNT])).rejects.toMatchObject({ code: '23001' })
  })

  it('survives file-backed close/reopen with its bytes and uniqueness intact', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'maxx-reporting-snapshot-'))
    let disk: PGlite | undefined
    try {
      disk = await prepareDb(directory)
      const inserted = (await insertRow(disk)).rows[0]
      await disk.close()
      disk = new PGlite(directory, { extensions: SCHEMA_EXTENSIONS })
      expect((await disk.query('SELECT id, snapshot_canonical FROM public.reporting_snapshots')).rows)
        .toEqual([{ id: inserted.id, snapshot_canonical: canonical(snapshotFixture()) }])
      await expect(insertRow(disk)).rejects.toMatchObject({ code: '23505' })
    } finally {
      await disk?.close()
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })
})
