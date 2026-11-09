import { readReportingHistoryEntity } from './snapshot-scope'
import { PreparedReportingReplySchema, type ValidatedPreparedReportingReply } from './prepared-contract'
import { expandPacket, isCompactReportingPacket, type CompactReportingPacket } from './packet-format'
import { validateScopedReportingPacket } from './packet-scope'
import { previousReportingRange, resolveReportingRange } from './range'
import type { ReportingPacket, ReportingSectionName } from './contracts'
import { ReportingRequestError } from './request-error'
import { hasPendingBusinessIntelligence } from './business-progress'

export const invalidPreparedReport = () => new ReportingRequestError('This source returned an invalid prepared report. Retry this source.', 'invalid')
const time = (value: string) => Date.parse(value)

/** Account identity is server-resolved and pinned by the first reply. The URL
 * fixes source, requested/effective dates and detail scope; names are display only.
 * A v2 packet is expanded and validated exactly as a v1 packet; its stored form is kept for the
 * snapshot fingerprint. */
export function validatePreparedReportingReply(
  raw: unknown, section: ReportingSectionName, key: string, prior?: ValidatedPreparedReportingReply,
): ValidatedPreparedReportingReply {
  try {
    const parsed = PreparedReportingReplySchema.parse(raw)
    const storedPacket = parsed.packet && isCompactReportingPacket(parsed.packet) ? parsed.packet as CompactReportingPacket : null
    const expanded = storedPacket ? expandPacket(storedPacket) as ReportingPacket : parsed.packet as ReportingPacket | null
    const { scope, snapshot, job } = parsed
    let packet = expanded
    const params = new URLSearchParams(key)
    const from = params.get('from') ?? '', to = params.get('to') ?? ''
    const range = resolveReportingRange({ from, to })
    const details = section === 'meta' ? [...new Set((params.get('details') ?? '').split(',').filter(Boolean))].sort() : []
    const historyEntity = readReportingHistoryEntity(params, section, details)
    if (JSON.stringify(scope.historyEntity) !== JSON.stringify(historyEntity)
      || scope.source !== section || scope.requestedRange.from !== from || scope.requestedRange.to !== to
      || scope.range.from !== range.from || scope.range.to !== range.to
      || JSON.stringify(scope.comparison) !== JSON.stringify(previousReportingRange({ from: range.from, to: range.to }))
      || JSON.stringify(scope.detailIds) !== JSON.stringify(details)
      || (prior && JSON.stringify(scope) !== JSON.stringify(prior.scope))) throw invalidPreparedReport()
    if (job) {
      if (time(job.leaseExpiresAt) - time(job.startedAt) !== 120_000
        || (job.completedAt && time(job.completedAt) < time(job.startedAt))
        || (job.status === 'running' && (job.completedAt !== null || job.failureCode !== null || job.snapshotId !== null))
        || (job.status === 'failed' && (!job.completedAt || !job.failureCode || job.snapshotId !== null))
        || (job.status === 'complete' && (!job.completedAt || time(job.completedAt) >= time(job.leaseExpiresAt)
          || job.failureCode !== null || !job.snapshotId))) throw invalidPreparedReport()
    }
    if (prior?.job?.status === 'running' && (!job || job.id !== prior.job.id
      || time(job.startedAt) !== time(prior.job.startedAt) || time(job.leaseExpiresAt) !== time(prior.job.leaseExpiresAt))) throw invalidPreparedReport()
    if (snapshot) {
      if (!packet || time(snapshot.retrievalStartedAt) !== time(packet.context.asOf)
        || time(snapshot.retrievalCompletedAt) < time(snapshot.retrievalStartedAt)
        || (packet.section === 'meta' && ![undefined, 'complete'].includes(packet.result.data?.detailState))
        || (packet.section === 'business' && hasPendingBusinessIntelligence(packet.result.data))) throw invalidPreparedReport()
      packet = validateScopedReportingPacket(packet, scope, snapshot.retrievalCompletedAt)
    } else if (packet) {
      if (!job || packet.section !== 'meta' || packet.result.state !== 'partial'
        || packet.result.data?.detailState !== (job.status === 'running' ? 'loading' : 'unavailable')
        || time(packet.context.asOf) !== time(job.startedAt)) throw invalidPreparedReport()
      packet = validateScopedReportingPacket(packet, scope, job.leaseExpiresAt)
    }
    if (job?.status === 'complete' && (!snapshot || job.snapshotId !== snapshot.id
      || time(job.startedAt) !== time(snapshot.retrievalStartedAt)
      || time(snapshot.retrievalCompletedAt) > time(job.completedAt!))) throw invalidPreparedReport()
    if (!job && !packet && !parsed.needsRefresh) throw invalidPreparedReport()
    // A v1 packet keeps the parsed reply's value, as before; a v2 packet's meaning is its validated expansion.
    return storedPacket ? { ...parsed, packet, storedPacket } : { ...parsed, packet: expanded }
  } catch { throw invalidPreparedReport() }
}
