import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  claimReportingRefresh, failReportingRefresh, finishReportingRefresh,
  publishReportingRefreshProgress, readReportingRefreshJob,
} from '@/lib/reporting/refresh-jobs'
import { canonicalReportingJson, createReportingSnapshot, reportingFingerprint } from '@/lib/reporting/snapshot-contract'
import { compactReportingPacket } from '@/lib/reporting/packet-format'
import { validateReportingPacket } from '@/lib/reporting/validation'
import { snapshotPacket } from './fixtures/reporting-snapshot'
import {
  pendingPacket, refreshDatabase, refreshId, refreshJob, refreshRecord,
  refreshScope, refreshSnapshotId, refreshToken,
} from './fixtures/reporting-refresh'

afterEach(() => vi.useRealTimers())

describe('prepared refresh repository', () => {
  it('claims the canonical scope and normalizes database timestamps for the source clock', async () => {
    const fake = refreshDatabase({ ...refreshRecord(), started_at: '2026-09-05T17:00:00+00:00' })
    const claimed = await claimReportingRefresh(fake.db, refreshScope, true)
    expect(claimed).toEqual({ claimed: true, job: refreshJob() })
    expect(fake.rpc).toHaveBeenCalledWith('claim_reporting_refresh', {
      p_scope_canonical: canonicalReportingJson(refreshScope), p_force: true,
    })
    expect(fake.from).not.toHaveBeenCalled()
  })

  it('distinguishes reusable evidence, joined work, missing jobs and storage failures', async () => {
    const fake = refreshDatabase(null)
    fake.rpcResult.mockResolvedValueOnce({ data: { claimed: false, job: null }, error: null })
    expect(await claimReportingRefresh(fake.db, refreshScope, false)).toEqual({ claimed: false, job: null })
    fake.rpcResult.mockResolvedValueOnce({ data: { claimed: false, job: refreshRecord() }, error: null })
    expect((await claimReportingRefresh(fake.db, refreshScope, false)).job?.id).toBe(refreshId)
    expect(await readReportingRefreshJob(fake.db, refreshScope)).toBeNull()
    fake.query.maybeSingle.mockResolvedValue({ data: null, error: { message: 'secret-db-detail' } })
    await expect(readReportingRefreshJob(fake.db, refreshScope)).rejects.toMatchObject({ kind: 'unavailable' })
    await expect(readReportingRefreshJob(fake.db, refreshScope)).rejects.not.toThrow('secret-db-detail')
  })

  it('reads the requested attempt only inside the owner account and exact scope', async () => {
    const fake = refreshDatabase()
    expect(await readReportingRefreshJob(fake.db, refreshScope, refreshId)).toEqual(refreshJob())
    expect(fake.query.eq.mock.calls).toEqual([
      ['ad_account_id', refreshScope.accountId], ['source', 'meta'],
      ['scope_key', reportingFingerprint(refreshScope)], ['id', refreshId],
    ])
    expect(fake.rpc).not.toHaveBeenCalled()
    await expect(readReportingRefreshJob(fake.db, refreshScope, refreshToken)).rejects.toMatchObject({ kind: 'invalid' })
    await expect(readReportingRefreshJob(fake.db, refreshScope, 'invalid')).rejects.toMatchObject({ kind: 'invalid' })
  })

  it('reads the latest historical attempt without silently filtering away a failure', async () => {
    const fake = refreshDatabase({ ...refreshRecord(), status: 'failed', failure_code: 'interrupted',
      completed_at: '2026-09-05T17:02:01.000Z' })
    expect((await readReportingRefreshJob(fake.db, refreshScope))?.failureCode).toBe('interrupted')
    expect(fake.query.order).toHaveBeenCalledWith('started_at', { ascending: false })
    expect(fake.query.order).toHaveBeenCalledWith('id', { ascending: false })
    expect(fake.query.limit).toHaveBeenCalledWith(1)
    expect(fake.query.eq).not.toHaveBeenCalledWith('status', 'running')
  })

  it.each([
    { ad_account_id: refreshToken }, { source: 'website' }, { scope_key: `sha256:${'0'.repeat(64)}` },
    { scope_canonical: '{}' }, { lease_token: 'bad' }, { started_at: 'bad' },
    { lease_expires_at: '2026-09-05T16:59:59.000Z' }, { created_at: '2026-09-05T16:59:59.000Z' },
    { status: 'running', completed_at: '2026-09-05T17:00:01.000Z' },
    { status: 'complete', completed_at: '2026-09-05T17:00:01.000Z', snapshot_id: null },
    { status: 'failed', completed_at: '2026-09-05T17:00:01.000Z', failure_code: 'private detail' },
    { status: 'complete', completed_at: '2026-09-05T17:00:01.000Z', snapshot_id: refreshSnapshotId, failure_code: 'interrupted' },
  ])('rejects inconsistent persisted identity or state: %j', async mutation => {
    await expect(readReportingRefreshJob(refreshDatabase({ ...refreshRecord(), ...mutation }).db, refreshScope))
      .rejects.toMatchObject({ kind: 'invalid' })
  })

  it('validates real pending progress and rejects rehashed scope, chronology and state corruption', async () => {
    expect((await readReportingRefreshJob(refreshDatabase(refreshRecord(pendingPacket())).db, refreshScope))?.progress)
      .toEqual(pendingPacket())
    const wrongAccount = pendingPacket()
    wrongAccount.context.account.id = refreshToken
    for (const row of [
      refreshRecord(wrongAccount), refreshRecord(snapshotPacket()),
      { ...refreshRecord(pendingPacket()), progress_fingerprint: `sha256:${'0'.repeat(64)}` },
      { ...refreshRecord(pendingPacket()), progress_at: null },
      { ...refreshRecord(pendingPacket()), progress_at: '2026-09-05T16:59:59.000Z' },
    ]) await expect(readReportingRefreshJob(refreshDatabase(row).db, refreshScope)).rejects.toMatchObject({ kind: 'invalid' })
  })

  it('publishes pending Meta only through its owned lease and completes atomically', async () => {
    const fake = refreshDatabase()
    expect(await publishReportingRefreshProgress(fake.db, refreshJob(), pendingPacket())).toBe(true)
    expect(fake.rpc).toHaveBeenLastCalledWith('publish_reporting_refresh_progress', {
      p_job: refreshId, p_token: refreshToken, // Stored as v2 from the validated packet, whose key order is the schema's.
      p_packet_canonical: canonicalReportingJson(compactReportingPacket(validateReportingPacket(pendingPacket()))),
    })
    const snapshot = createReportingSnapshot(refreshScope, snapshotPacket(), '2026-09-05T17:00:30.000Z')
    expect(await finishReportingRefresh(fake.db, refreshJob(), snapshot)).toEqual({ committed: true, snapshotId: refreshSnapshotId })
    expect(fake.rpc).toHaveBeenLastCalledWith('finish_reporting_refresh', {
      p_job: refreshId, p_token: refreshToken,
      p_snapshot_canonical: canonicalReportingJson({ ...snapshot, packet: compactReportingPacket(snapshot.packet) }),
    })
    expect(fake.from).not.toHaveBeenCalled()
  })

  it('rejects invalid writes before calling storage', async () => {
    const fake = refreshDatabase()
    await expect(publishReportingRefreshProgress(fake.db, refreshJob(), snapshotPacket())).rejects.toMatchObject({ kind: 'invalid' })
    const snapshot = createReportingSnapshot(refreshScope, snapshotPacket(), '2026-09-05T17:00:30.000Z')
    await expect(finishReportingRefresh(fake.db, { ...refreshJob(), startedAt: '2026-09-05T17:00:01.000Z' }, snapshot))
      .rejects.toMatchObject({ kind: 'invalid' })
    await expect(failReportingRefresh(fake.db, refreshJob(), 'private detail' as 'interrupted')).rejects.toMatchObject({ kind: 'invalid' })
    expect(fake.rpc).not.toHaveBeenCalled()
  })

  it('rejects progress labeled available while optional details are still loading', async () => {
    const fake = refreshDatabase()
    const pending = pendingPacket()
    const mislabeled = { ...pending, result: { ...pending.result, state: 'available' as const } } as typeof pending
    await expect(publishReportingRefreshProgress(fake.db, refreshJob(), mislabeled)).rejects.toMatchObject({ kind: 'invalid' })
    await expect(readReportingRefreshJob(refreshDatabase(refreshRecord(mislabeled)).db, refreshScope)).rejects.toMatchObject({ kind: 'invalid' })
    expect(fake.rpc).not.toHaveBeenCalled()
  })

  it('preserves superseded ownership and rejects impossible completion responses', async () => {
    const fake = refreshDatabase()
    const snapshot = createReportingSnapshot(refreshScope, snapshotPacket(), '2026-09-05T17:00:30.000Z')
    fake.rpcResult.mockResolvedValueOnce({ data: { committed: false, snapshot_id: null }, error: null })
    expect(await finishReportingRefresh(fake.db, refreshJob(), snapshot)).toEqual({ committed: false, snapshotId: null })
    fake.rpcResult.mockResolvedValueOnce({ data: { committed: true, snapshot_id: null }, error: null })
    await expect(finishReportingRefresh(fake.db, refreshJob(), snapshot)).rejects.toMatchObject({ kind: 'invalid' })
    fake.rpcResult.mockResolvedValueOnce({ data: false, error: null })
    expect(await failReportingRefresh(fake.db, refreshJob(), 'interrupted')).toBe(false)
    expect(fake.rpc).toHaveBeenLastCalledWith('fail_reporting_refresh', { p_job: refreshId, p_token: refreshToken, p_code: 'interrupted' })
  })

  it('bounds non-cooperative database RPCs and forwards cancellation to reads', async () => {
    vi.useFakeTimers()
    const fake = refreshDatabase()
    fake.rpcResult.mockReturnValue(new Promise(() => {}))
    const pending = claimReportingRefresh(fake.db, refreshScope, true).catch(error => error)
    await vi.advanceTimersByTimeAsync(5_001)
    expect(await pending).toMatchObject({ kind: 'unavailable' })
    expect(fake.rpcSignals[0].aborted).toBe(true)
    const controller = new AbortController()
    fake.query.maybeSingle.mockReturnValue(new Promise(() => {}))
    const read = readReportingRefreshJob(fake.db, refreshScope, undefined, controller.signal).catch(error => error)
    await vi.advanceTimersByTimeAsync(1)
    controller.abort()
    expect(await read).toMatchObject({ kind: 'unavailable' })
    expect(fake.query.abortSignal.mock.calls[0][0].aborted).toBe(true)
  })

  it('allows a valid publication to finish beyond the short metadata RPC deadline', async () => {
    vi.useFakeTimers()
    const fake = refreshDatabase()
    fake.rpcResult.mockImplementation(() => new Promise(resolve => setTimeout(() => resolve({
      data: { committed: true, snapshot_id: refreshSnapshotId }, error: null,
    }), 9_000)))
    const snapshot = createReportingSnapshot(refreshScope, snapshotPacket(), '2026-09-05T17:00:30.000Z')
    const pending = finishReportingRefresh(fake.db, refreshJob(), snapshot).catch(error => error)
    await vi.advanceTimersByTimeAsync(9_001)
    expect(await pending).toEqual({ committed: true, snapshotId: refreshSnapshotId })
    expect(fake.rpcSignals[0].aborted).toBe(false)
  })

  it('still bounds a non-cooperative final publication', async () => {
    vi.useFakeTimers()
    const fake = refreshDatabase()
    fake.rpcResult.mockReturnValue(new Promise(() => {}))
    const snapshot = createReportingSnapshot(refreshScope, snapshotPacket(), '2026-09-05T17:00:30.000Z')
    const pending = finishReportingRefresh(fake.db, refreshJob(), snapshot).catch(error => error)
    await vi.advanceTimersByTimeAsync(24_999)
    expect(fake.rpcSignals[0].aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(2)
    expect(await pending).toMatchObject({ kind: 'unavailable' })
    expect(fake.rpcSignals[0].aborted).toBe(true)
  })
})
