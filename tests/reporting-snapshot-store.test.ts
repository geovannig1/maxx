import { afterEach, describe, expect, it, vi } from 'vitest'
import { snapshotContext, snapshotPacket } from './fixtures/reporting-snapshot'
import { canonicalReportingJson, createReportingSnapshot, makeReportingSnapshotScope, reportingFingerprint } from '@/lib/reporting/snapshot-contract'
import { readLatestReportingSnapshot, readReportingSnapshotById, type SnapshotDatabase } from '@/lib/reporting/snapshot-store'

const scope = makeReportingSnapshotScope('meta', snapshotContext)
const snapshot = () => createReportingSnapshot(scope, snapshotPacket(), '2026-09-05T17:00:40.000Z')
function record() {
  const value = snapshot()
  return {
    id: '00000000-0000-4000-8000-000000001313', ad_account_id: scope.accountId, source: scope.source,
    scope_key: reportingFingerprint(scope), scope_canonical: canonicalReportingJson(scope),
    evidence_fingerprint: reportingFingerprint(value), snapshot_canonical: canonicalReportingJson(value),
    retrieval_started_at: value.retrieval.startedAt, retrieval_completed_at: value.retrieval.completedAt,
    created_at: '2026-09-05T17:00:41.000Z',
  }
}
function database(row: unknown = record()) {
  const query = { insert: vi.fn(), select: vi.fn(), eq: vi.fn(), order: vi.fn(), limit: vi.fn(), abortSignal: vi.fn(),
    single: vi.fn().mockResolvedValue({ data: row, error: null }), maybeSingle: vi.fn().mockResolvedValue({ data: row, error: null }) }
  for (const method of ['insert', 'select', 'eq', 'order', 'limit', 'abortSignal'] as const) query[method].mockReturnValue(query)
  const from = vi.fn().mockReturnValue(query)
  return { db: { from } as unknown as SnapshotDatabase, from, query }
}
afterEach(() => vi.useRealTimers())

describe('durable reporting snapshot repository', () => {
  it('reads an exact job publication within scope and rejects a different returned snapshot ID', async () => {
    const { db, query } = database()
    expect((await readReportingSnapshotById(db, scope, record().id))?.id).toBe(record().id)
    expect(query.eq.mock.calls).toEqual([
      ['ad_account_id', scope.accountId], ['source', 'meta'], ['scope_key', reportingFingerprint(scope)], ['id', record().id],
    ])
    await expect(readReportingSnapshotById(db, scope, '00000000-0000-4000-8000-000000009999')).rejects.toMatchObject({ kind: 'invalid' })
    expect(await readReportingSnapshotById(database(null).db, scope, record().id)).toBeNull()
    const invalid = database()
    await expect(readReportingSnapshotById(invalid.db, scope, 'not-a-uuid')).rejects.toMatchObject({ kind: 'invalid' })
    expect(invalid.from).not.toHaveBeenCalled()
  })
  it('selects only exact scope, ordered by observation start before insert timing', async () => {
    const { db, query } = database()
    expect((await readLatestReportingSnapshot(db, scope))?.snapshot).toEqual(snapshot())
    expect(query.eq.mock.calls).toEqual([
      ['ad_account_id', scope.accountId], ['source', 'meta'], ['scope_key', reportingFingerprint(scope)],
    ])
    expect(query.order.mock.calls).toEqual([
      ['retrieval_started_at', { ascending: false }], ['retrieval_completed_at', { ascending: false }], ['id', { ascending: false }],
    ])
    expect(query.limit).toHaveBeenCalledWith(1)
    expect(query.insert).not.toHaveBeenCalled()
  })
  it('distinguishes a missing snapshot from a failed storage read', async () => {
    const { db, query } = database(null)
    expect(await readLatestReportingSnapshot(db, scope)).toBeNull()
    query.maybeSingle.mockResolvedValue({ data: null, error: { message: 'private-token' } })
    await expect(readLatestReportingSnapshot(db, scope)).rejects.toMatchObject({ kind: 'unavailable' })
    await expect(readLatestReportingSnapshot(db, scope)).rejects.not.toThrow('private-token')
  })
  it.each(['ad_account_id', 'scope_key', 'evidence_fingerprint', 'retrieval_started_at', 'source'] as const)('rejects corrupted row %s', async key => {
    const row = { ...record(), [key]: 'incorrect' }
    await expect(readLatestReportingSnapshot(database(row).db, scope)).rejects.toMatchObject({ kind: 'invalid' })
  })
  it('rejects changed content, mismatched canonical scope and semantically invalid rehashed packets', async () => {
    const row = record()
    await expect(readLatestReportingSnapshot(database({ ...row, snapshot_canonical: row.snapshot_canonical.replace('Studio', 'Changed') }).db, scope)).rejects.toMatchObject({ kind: 'invalid' })
    const altered = JSON.parse(row.snapshot_canonical)
    altered.packet.result.data.metrics.clicks.current.entity.id = 'wrong'
    await expect(readLatestReportingSnapshot(database({ ...row, snapshot_canonical: canonicalReportingJson(altered),
      evidence_fingerprint: reportingFingerprint(altered) }).db, scope)).rejects.toMatchObject({ kind: 'invalid' })
    const wrongScope = { ...scope, detailIds: ['another-ad'] }
    await expect(readLatestReportingSnapshot(database({ ...row, scope_canonical: canonicalReportingJson(wrongScope),
      scope_key: reportingFingerprint(wrongScope) }).db, scope)).rejects.toMatchObject({ kind: 'invalid' })
  })
  it('bounds stalled storage and aborts its query signal', async () => {
    vi.useFakeTimers()
    const { db, query } = database()
    query.maybeSingle.mockReturnValue(new Promise(() => {}))
    const result = readLatestReportingSnapshot(db, scope).catch(error => error)
    await vi.advanceTimersByTimeAsync(5_001)
    expect(await result).toMatchObject({ kind: 'unavailable' })
    expect(query.abortSignal.mock.calls[0][0].aborted).toBe(true)
  })
})
