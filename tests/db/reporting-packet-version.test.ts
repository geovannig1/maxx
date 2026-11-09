import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { prepareSavedDb, savedTestClient } from './reporting-saved-fixture'
import { refreshTestClient } from './reporting-refresh-fixture'
import { publishSavedEvidence, savedInput, SAVED_USER } from '../fixtures/reporting-saved'
import { snapshotContext, snapshotPacket } from '../fixtures/reporting-snapshot'
import type { ReportingPacket } from '@/lib/reporting/contracts'
import {
  claimReportingRefresh, finishReportingRefresh, publishReportingRefreshProgress, readReportingRefreshJob,
} from '@/lib/reporting/refresh-jobs'
import { canonicalReportingJson, createReportingSnapshot, makeReportingSnapshotScope, reportingFingerprint } from '@/lib/reporting/snapshot-contract'
import { readReportingSnapshotById } from '@/lib/reporting/snapshot-store'
import { openSavedReportingReport, saveReportingReport } from '@/lib/reporting/saved-service'
import { expandPacket } from '@/lib/reporting/packet-format'

// Real SQL triggers and the real repository: stored v1 evidence keeps loading, unchanged, and new
// writes are v2 documents that the storage triggers accept and the repository reads back.
let db: PGlite
beforeAll(async () => { db = await prepareSavedDb() })
afterAll(async () => { await db?.close() })

async function storedRow(id: string) {
  return (await db.query<{ snapshot_canonical: string; evidence_fingerprint: string }>(
    'SELECT snapshot_canonical, evidence_fingerprint FROM public.reporting_snapshots WHERE id=$1', [id])).rows[0]
}

describe('report packet versions through the real repository', () => {
  it('loads a stored v1 snapshot and a saved report bound to it, and never rewrites the stored bytes', async () => {
    const client = savedTestClient(db)
    // The fixture publishes canonical v1 bytes through SQL, exactly as stored before packetVersion 2.
    const a = await publishSavedEvidence(db, 3)
    const before = await storedRow(a.id)
    expect(JSON.parse(before.snapshot_canonical).packet.packetVersion).toBeUndefined()
    const read = await readReportingSnapshotById(client, a.snapshot.scope, a.id)
    expect(read?.snapshot).toEqual(a.snapshot)
    expect(read?.storedPacket).toBeUndefined()
    const saved = await saveReportingReport(client, snapshotContext.account, SAVED_USER, savedInput(a))
    const reopened = await openSavedReportingReport(client, snapshotContext.account, saved.saved.id)
    expect(reopened).toEqual(saved)
    expect(reopened.data.meta.data?.metrics.clicks.current.value).toBe(3)
    expect(await storedRow(a.id)).toEqual(before)
  })

  it('writes progress and the final snapshot as v2, which the triggers accept and the repository reads and saves', async () => {
    const client = savedTestClient(db), refresh = refreshTestClient(db)
    const scope = makeReportingSnapshotScope('meta', snapshotContext)
    const { job } = await claimReportingRefresh(refresh, scope, true)
    if (!job) throw new Error('Expected a refresh lease')
    const context = { ...snapshotContext, asOf: job.startedAt }
    const complete = snapshotPacket(context)
    const pending: ReportingPacket = { ...complete, result: { ...complete.result, state: 'partial',
      data: { ...complete.result.data!, detailState: 'loading' } } }
    expect(await publishReportingRefreshProgress(refresh, job, pending)).toBe(true)
    const progress = (await db.query<{ progress_canonical: string; progress_fingerprint: string }>(
      'SELECT progress_canonical, progress_fingerprint FROM public.reporting_refresh_jobs WHERE id=$1', [job.id])).rows[0]
    expect(JSON.parse(progress.progress_canonical).packetVersion).toBe(2)
    expect(progress.progress_fingerprint).toBe(reportingFingerprint(JSON.parse(progress.progress_canonical)))
    expect((await readReportingRefreshJob(refresh, scope, job.id))?.progress).toEqual(pending)

    const snapshot = createReportingSnapshot(scope, complete, new Date().toISOString())
    const result = await finishReportingRefresh(refresh, job, snapshot)
    expect(result.committed).toBe(true)
    const stored = await storedRow(result.snapshotId!)
    const document = JSON.parse(stored.snapshot_canonical)
    expect(document.packet.packetVersion).toBe(2)
    expect(stored.evidence_fingerprint).toBe(reportingFingerprint(document))
    expect(canonicalReportingJson(expandPacket(document.packet))).toBe(canonicalReportingJson(snapshot.packet))
    const read = await readReportingSnapshotById(client, scope, result.snapshotId!)
    expect(read?.snapshot).toEqual(snapshot)
    expect(read?.fingerprint).toBe(stored.evidence_fingerprint)
    const saved = await saveReportingReport(client, snapshotContext.account, SAVED_USER, savedInput(read!))
    expect(saved.data.meta.data?.metrics).toEqual(complete.result.data?.metrics)
    expect(await openSavedReportingReport(client, snapshotContext.account, saved.saved.id)).toEqual(saved)
  })
})
