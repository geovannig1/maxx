import { expect, it, vi } from 'vitest'
import { platformData } from './fixtures/reporting-business-platform'
import { snapshotContext, snapshotPacket } from './fixtures/reporting-snapshot'
import { buildMetaMetrics } from '@/lib/reporting/meta-metrics'
import { createReportingSnapshot, makeReportingSnapshotScope, reportingFingerprint } from '@/lib/reporting/snapshot-contract'
import { assembleSavedReportData } from '@/lib/reporting/saved-assembly'
import { deriveExpertReview } from '@/lib/reporting/review'
import { openSavedReportingReport } from '@/lib/reporting/saved-service'
import { validateSavedReportReply } from '@/lib/reporting/saved-validation'
import { SAVED_REPORT_VERSION, SAVED_REPORT_EXPORT_VERSION, type SavedReportSources } from '@/lib/reporting/saved-contract'
import type { SavedReportArtifact } from '@/lib/reporting/saved-store'

const mocks = vi.hoisted(() => ({ snapshot: vi.fn(), manifest: vi.fn() }))
vi.mock('@/lib/reporting/snapshot-store', () => ({ readReportingSnapshotById: mocks.snapshot }))
vi.mock('@/lib/reporting/saved-store', () => ({ readSavedReportManifest: mocks.manifest,
  insertSavedReportManifest: vi.fn(), listSavedReportManifests: vi.fn() }))

it('opens a fictional immutable v12 assessment and absent CPA snapshot unchanged after v14 can interpret a new cost', async () => {
  const context = { ...snapshotContext, asOf: '2026-09-20T17:00:00.000Z' }, packet = snapshotPacket(context)
  const native = (spend: number, count: number) => ({ spend: String(spend), actions: [{ action_type: 'purchase', value: String(count) }] })
  const fresh = buildMetaMetrics(context, native(100, 5), native(200, 20))
  expect(fresh.cost_per_purchase.current.value).toBe(20)
  packet.result.data!.metrics = Object.fromEntries(Object.entries(fresh).filter(([key]) => key !== 'cost_per_purchase'))
  const scope = makeReportingSnapshotScope('meta', context)
  const snapshot = createReportingSnapshot(scope, packet, '2026-09-20T17:01:00.000Z')
  const stored = { id: '00000000-0000-4000-8000-000000001511', fingerprint: reportingFingerprint(snapshot),
    createdAt: snapshot.retrieval.completedAt, snapshot }
  const missing = { state: 'missing', code: 'not_supplied', context: null } as const
  const sources: SavedReportSources = { meta: { state: 'snapshot', receipt: { id: stored.id, fingerprint: stored.fingerprint, scope,
    retrievalStartedAt: snapshot.retrieval.startedAt, retrievalCompletedAt: snapshot.retrieval.completedAt, sourceAsOf: snapshot.sourceAsOf } },
  business: missing, website: missing, measurement: missing }
  const data = assembleSavedReportData({ meta: packet }, sources), prepared = deriveExpertReview(data)
  // A fictional stored assessment is an artifact to validate, not an invitation to regenerate its wording.
  const review = { ...prepared, playbookVersion: 'maxx-diagnostic-2026-09-07.v12', findings: prepared.findings
    .filter(finding => finding.id === 'business_platform_trend').map(finding => ({ ...finding,
      observation: { text: 'Original v12 account assessment. Purchase value was unavailable in this saved report.', evidence: finding.observation.evidence } })) }
  const input = { requestId: '00000000-0000-4000-8000-000000001512', title: 'Fictional original v12',
    view: { pathname: '/reports' as const, query: { from: scope.range.from, to: scope.range.to, report: 'business' } },
    sources, reviewIdentity: reportingFingerprint(review) }
  const artifact: SavedReportArtifact = { contract: SAVED_REPORT_VERSION, input, review,
    dataIdentity: reportingFingerprint(data), notes: packet.notes, notesIdentity: reportingFingerprint(packet.notes),
    versions: { manifest: SAVED_REPORT_VERSION, review: review.contractVersion, playbook: review.playbookVersion, export: SAVED_REPORT_EXPORT_VERSION } }
  const manifest = { id: input.requestId, accountId: context.account.id, userId: '00000000-0000-4000-8000-000000001513',
    createdAt: '2026-09-20T17:02:00.000Z', artifact }
  const before = reportingFingerprint({ stored, manifest })
  mocks.snapshot.mockResolvedValue(stored); mocks.manifest.mockResolvedValue(manifest)
  const db = { from: vi.fn(), rpc: vi.fn() }
  const opened = await openSavedReportingReport(db as never, context.account, manifest.id)
  expect(opened.review).toEqual(review)
  expect(opened.saved.reviewIdentity).toBe(input.reviewIdentity)
  expect(opened.data.meta.data!.metrics).not.toHaveProperty('cost_per_purchase')
  expect(opened.review.findings[0].observation.text).not.toContain('CPA')
  expect(reportingFingerprint({ stored, manifest })).toBe(before)
  expect(db.from).not.toHaveBeenCalled(); expect(db.rpc).not.toHaveBeenCalled()
  expect(mocks.snapshot).toHaveBeenCalledWith(db, scope, stored.id)
  const transplanted = structuredClone(opened)
  transplanted.review.findings[0].observation.text = 'Purchase CPA rose from $10 to $20.'
  await expect(validateSavedReportReply(transplanted)).rejects.toMatchObject({ code: 'invalid' })
  expect(deriveExpertReview(platformData()).playbookVersion).toBe('maxx-diagnostic-2026-09-08.v16')
})
