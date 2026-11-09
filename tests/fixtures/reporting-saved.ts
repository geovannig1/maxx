import { randomUUID } from 'node:crypto'
import type { PGlite } from '@electric-sql/pglite'
import { snapshotContext, snapshotPacket } from './reporting-snapshot'
import { claim, finish } from '../db/reporting-refresh-fixture'
import { makeReportMetric, COMPLETE_FIELD_COVERAGE } from '@/lib/reporting/claims'
import { createReportingSnapshot, makeReportingSnapshotScope, reportingFingerprint } from '@/lib/reporting/snapshot-contract'
import type { StoredReportingSnapshot } from '@/lib/reporting/snapshot-store'
import { assembleSavedReportData } from '@/lib/reporting/saved-assembly'
import { deriveExpertReview } from '@/lib/reporting/review'
import type { SavedReportSources, SaveReportingReportInput } from '@/lib/reporting/saved-contract'

export const SAVED_USER = '00000000-0000-4000-8000-000000001403'
export const missingSource = { state: 'missing', code: 'not_supplied', context: null } as const
export async function publishSavedEvidence(db: PGlite, clicks = 0, requestedTo = snapshotContext.range.to): Promise<StoredReportingSnapshot> {
  const scope = makeReportingSnapshotScope('meta', snapshotContext, { requestedRange: { ...snapshotContext.range, to: requestedTo } }), lease = (await claim(db, scope)).job!
  const context = { ...snapshotContext, asOf: new Date(lease.started_at).toISOString() }, packet = snapshotPacket(context)
  const metric = makeReportMetric({ context, key: 'clicks', current: clicks, previous: 1, label: 'Clicks',
    definition: 'Native click count', source: 'meta', unit: 'count', coverage: COMPLETE_FIELD_COVERAGE,
    previousCoverage: COMPLETE_FIELD_COVERAGE, sourceHead: 'saved-fixture' })
  const snapshot = createReportingSnapshot(scope, { ...packet, result: { ...packet.result,
    data: { ...packet.result.data!, metrics: { ...packet.result.data!.metrics, clicks: metric } } } }, new Date().toISOString())
  const result = await finish(db, lease, snapshot)
  if (!result.committed || !result.snapshot_id) throw new Error('Fixture leased publication failed')
  return { id: result.snapshot_id, fingerprint: reportingFingerprint(snapshot), createdAt: snapshot.retrieval.completedAt, snapshot }
}
export function savedInput(stored: StoredReportingSnapshot, overrides: Partial<SavedReportSources> = {}): SaveReportingReportInput {
  const { snapshot } = stored
  const sources: SavedReportSources = { meta: { state: 'snapshot', receipt: { id: stored.id, fingerprint: stored.fingerprint,
    scope: snapshot.scope, retrievalStartedAt: snapshot.retrieval.startedAt, retrievalCompletedAt: snapshot.retrieval.completedAt,
    sourceAsOf: snapshot.sourceAsOf } }, business: missingSource, website: missingSource, measurement: missingSource, ...overrides }
  const data = assembleSavedReportData({ meta: snapshot.packet }, sources)
  return { requestId: randomUUID(), title: 'Original evidence', view: { pathname: '/dashboard', query: {
    from: snapshot.scope.requestedRange.from, to: snapshot.scope.requestedRange.to } }, sources,
  reviewIdentity: reportingFingerprint(deriveExpertReview(data)) }
}
