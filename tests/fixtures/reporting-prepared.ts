import { snapshotContext, snapshotPacket } from './reporting-snapshot'
import { makeReportingSnapshotScope } from '../../src/lib/reporting/snapshot-scope'
import type { PreparedReportingReply } from '../../src/lib/reporting/prepared-contract'

export const preparedJobId = '00000000-0000-4000-8000-000000001321'
export const preparedSnapshotId = '00000000-0000-4000-8000-000000001322'
export const preparedKey = 'from=2026-09-02&to=2026-09-04'
export const jobStartedAt = '2026-09-05T17:02:00.000Z'
export function preparedReply(): PreparedReportingReply {
  return { kind: 'prepared-report', version: 1, scope: makeReportingSnapshotScope('meta', snapshotContext),
    packet: snapshotPacket(structuredClone(snapshotContext)), snapshot: { id: preparedSnapshotId, retrievalStartedAt: snapshotContext.asOf,
      retrievalCompletedAt: '2026-09-05T17:00:40.000Z' }, job: null, needsRefresh: true }
}
export function preparedRunning(progress = false): PreparedReportingReply {
  const reply = preparedReply()
  reply.job = { id: preparedJobId, status: 'running', startedAt: jobStartedAt,
    leaseExpiresAt: '2026-09-05T17:04:00.000Z', completedAt: null, failureCode: null, snapshotId: null }
  if (progress) {
    reply.snapshot = null
    reply.packet = snapshotPacket({ ...structuredClone(snapshotContext), asOf: jobStartedAt })
    if (reply.packet.section === 'meta') reply.packet.result.data!.detailState = 'loading'
  }
  return reply
}
export function preparedComplete(): PreparedReportingReply {
  const reply = preparedRunning()
  reply.needsRefresh = false
  reply.packet = snapshotPacket({ ...structuredClone(snapshotContext), asOf: jobStartedAt })
  reply.snapshot = { id: '00000000-0000-4000-8000-000000001323', retrievalStartedAt: jobStartedAt,
    retrievalCompletedAt: '2026-09-05T17:02:10.000Z' }
  reply.job = { ...reply.job!, status: 'complete', completedAt: reply.snapshot.retrievalCompletedAt, snapshotId: reply.snapshot.id }
  return reply
}
