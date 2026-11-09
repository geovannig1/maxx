import { ReportingContextSchema, ReportingPacketSchema, type ReportingPacket } from './contracts'
import { loadReportingSection } from './loader'
import {
  failReportingRefresh, finishReportingRefresh, publishReportingRefreshProgress,
  type ReportingRefreshDatabase, type ReportingRefreshFailureCode, type ReportingRefreshJob,
} from './refresh-jobs'
import { createReportingSnapshot, validateReportingPacketScope } from './snapshot-contract'

export type ReportingRefreshOutcome =
  | { status: 'complete'; snapshotId: string }
  | { status: 'failed'; failureCode: ReportingRefreshFailureCode }
  | { status: 'superseded' }

async function recordFailure(
  db: ReportingRefreshDatabase, job: ReportingRefreshJob, failureCode: ReportingRefreshFailureCode,
): Promise<ReportingRefreshOutcome> {
  try {
    if (!await failReportingRefresh(db, job, failureCode)) return { status: 'superseded' }
  } catch { /* The persisted lease remains recoverable if bounded failure storage is unavailable. */ }
  return { status: 'failed', failureCode }
}

/** Source retrieval belongs to the SQL lease, never to a browser request signal. */
export async function runReportingRefresh(
  db: ReportingRefreshDatabase, job: ReportingRefreshJob, accountName: string | null,
): Promise<ReportingRefreshOutcome> {
  if (job.status !== 'running' || Date.parse(job.leaseExpiresAt) <= Date.now()) return { status: 'superseded' }
  let acceptingProgress = true
  let progress: Promise<void> = Promise.resolve()
  const onProgress = (raw: ReportingPacket) => {
    if (!acceptingProgress) return
    try {
      const packet = validateReportingPacketScope(raw, job.scope, new Date().toISOString())
      if (packet.context.asOf !== job.startedAt || packet.section !== 'meta' || packet.result.data?.detailState !== 'loading') return
      progress = progress.then(async () => { await publishReportingRefreshProgress(db, job, packet) }).catch(() => undefined)
    } catch { /* Unvalidated progress cannot replace saved evidence. */ }
  }
  let packet: ReportingPacket
  try {
    const context = ReportingContextSchema.parse({
      account: { id: job.scope.accountId, metaAccountId: job.scope.metaAccountId, name: accountName },
      range: job.scope.range, comparison: job.scope.comparison, timezone: job.scope.timezone,
      currency: job.scope.currency, asOf: job.startedAt,
    })
    packet = await loadReportingSection(job.scope.source, context, true, [...job.scope.detailIds], onProgress, undefined, { isolateGeneration: true,
      ...(job.scope.historyEntity ? { historyEntity: job.scope.historyEntity } : {}),
    })
  } catch {
    acceptingProgress = false
    await progress
    return recordFailure(db, job, 'source_unavailable')
  }
  acceptingProgress = false
  await progress
  const parsed = ReportingPacketSchema.safeParse(packet)
  if (!parsed.success) return recordFailure(db, job, 'invalid_report')
  if (!['available', 'partial'].includes(parsed.data.result.state)) return recordFailure(db, job, 'source_unavailable')
  let snapshot
  try {
    if (packet.context.asOf !== job.startedAt) return recordFailure(db, job, 'invalid_report')
    snapshot = createReportingSnapshot(job.scope, packet, new Date().toISOString())
  } catch { return recordFailure(db, job, 'invalid_report') }
  try {
    const result = await finishReportingRefresh(db, job, snapshot)
    return result.committed && result.snapshotId ? { status: 'complete', snapshotId: result.snapshotId } : { status: 'superseded' }
  } catch { return recordFailure(db, job, 'storage_unavailable') }
}
