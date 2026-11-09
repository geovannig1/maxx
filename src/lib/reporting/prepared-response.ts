import { META_DETAILS_LOADING_NOTE, type ReportingPacket } from './contracts'
import type { ReportingSnapshotScope } from './snapshot-scope'
import type { StoredReportingSnapshot } from './snapshot-store'
import type { ReportingRefreshJob } from './refresh-jobs'
import { REPORTING_PREPARED_TYPE, type PreparedReportingReply } from './prepared-contract'
import { compactReportingPacket } from './packet-format'

export function acceptsPreparedReporting(accept: string | null): boolean {
  return Boolean(accept?.split(',').some(value => {
    const [type, ...parameters] = value.trim().split(';')
    const quality = parameters.find(parameter => parameter.trim().startsWith('q='))
    return type.trim() === REPORTING_PREPARED_TYPE && (quality === undefined || Number(quality.trim().slice(2)) > 0)
  }))
}

function settledProgress(packet: ReportingPacket | null): ReportingPacket | null {
  if (packet?.section !== 'meta' || packet.result.data?.detailState !== 'loading') return packet
  return { ...packet, result: { ...packet.result, state: 'partial',
    data: { ...packet.result.data, detailState: 'unavailable' },
    notes: [...packet.result.notes.filter(note => note !== META_DETAILS_LOADING_NOTE),
      'This refresh could not finish optional Meta details. Validated totals remain available; retry to load details.'],
  } }
}

/** Repository reads have already validated scope and evidence. Project only public
 * job metadata; retain saved evidence exactly as retrieved from immutable storage. */
export function preparedReportingReply(
  scope: ReportingSnapshotScope, saved: StoredReportingSnapshot | null,
  job: ReportingRefreshJob | null, now = Date.now(),
): PreparedReportingReply {
  const expired = job?.status === 'running' && Date.parse(job.leaseExpiresAt) <= now
  const publicJob: PreparedReportingReply['job'] = job ? {
    id: job.id, status: expired ? 'failed' : job.status, startedAt: job.startedAt,
    leaseExpiresAt: job.leaseExpiresAt, completedAt: expired ? job.leaseExpiresAt : job.completedAt,
    failureCode: expired ? 'interrupted' : job.failureCode, snapshotId: job.snapshotId,
  } : null
  const progress = job?.progress ?? null
  // Saved evidence goes out exactly as stored; running progress as stored when compact; settled
  // progress is changed here, so it is re-encoded.
  const settled = publicJob?.status === 'running' ? null : settledProgress(progress)
  const packet = saved ? saved.storedPacket ?? saved.snapshot.packet
    : publicJob?.status === 'running' ? job?.storedProgress ?? (progress && compactReportingPacket(progress))
    : settled && compactReportingPacket(settled)
  return { kind: 'prepared-report', version: 1, scope, packet: packet ?? null,
    snapshot: saved ? { id: saved.id, fingerprint: saved.fingerprint, retrievalStartedAt: saved.snapshot.retrieval.startedAt,
      retrievalCompletedAt: saved.snapshot.retrieval.completedAt } : null,
    job: publicJob,
    needsRefresh: !saved || Date.parse(saved.snapshot.retrieval.completedAt) + 60_000 <= now,
  }
}
