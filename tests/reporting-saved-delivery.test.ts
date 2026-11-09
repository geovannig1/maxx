import { describe, expect, it } from 'vitest'
import { preparedReportingReply } from '@/lib/reporting/prepared-response'
import { createReportingSnapshot, makeReportingSnapshotScope, reportingFingerprint } from '@/lib/reporting/snapshot-contract'
import { snapshotContext, snapshotPacket } from './fixtures/reporting-snapshot'

describe('exact displayed prepared evidence', () => {
  it('returns the immutable fingerprint with the exact snapshot publication being displayed', () => {
    const scope = makeReportingSnapshotScope('meta', snapshotContext)
    const snapshot = createReportingSnapshot(scope, snapshotPacket(), '2026-09-05T17:00:40.000Z')
    const saved = { id: '00000000-0000-4000-8000-000000001401', fingerprint: reportingFingerprint(snapshot), createdAt: snapshot.retrieval.completedAt, snapshot }
    const reply = preparedReportingReply(scope, saved, null)
    expect(reply.packet).toEqual(snapshot.packet)
    expect(reply.snapshot).toMatchObject({ id: saved.id, fingerprint: saved.fingerprint })
  })
})
