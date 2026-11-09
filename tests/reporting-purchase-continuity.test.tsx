import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { purchasePacket } from './fixtures/reporting-purchase'
import { snapshotContext } from './fixtures/reporting-snapshot'
import { createReportingSnapshot, makeReportingSnapshotScope, reportingFingerprint } from '@/lib/reporting/snapshot-contract'
import { assembleSavedReportData } from '@/lib/reporting/saved-assembly'
import { deriveExpertReview } from '@/lib/reporting/review'
import { mediaEntityFields } from '@/lib/reporting/review/business-platform-evidence'
import { validateReportingPacket } from '@/lib/reporting/validation'
import { validateScopedReportingPacket } from '@/lib/reporting/packet-scope'
import type { ReportingData } from '@/lib/reporting/contracts'
import { metricsToExportRows } from '@/lib/reporting/export'
import { ReportMetricValue } from '@/components/reporting/MetricValue'
import { openSavedReportingReport } from '@/lib/reporting/saved-service'
import { readReportingSnapshotById } from '@/lib/reporting/snapshot-store'
import { readSavedReportManifest, type SavedReportArtifact } from '@/lib/reporting/saved-store'
import { validateSavedReportReply } from '@/lib/reporting/saved-validation'
import { SAVED_REPORT_VERSION, SAVED_REPORT_EXPORT_VERSION, type SavedReportSources } from '@/lib/reporting/saved-contract'

vi.mock('@/lib/reporting/snapshot-store', async original => ({ ...await original<typeof import('@/lib/reporting/snapshot-store')>(), readReportingSnapshotById: vi.fn() }))
vi.mock('@/lib/reporting/saved-store', async original => ({ ...await original<typeof import('@/lib/reporting/saved-store')>(), readSavedReportManifest: vi.fn() }))
const missing = { state: 'missing', code: 'not_supplied', context: null } as const
function storedLegacy() {
  const packet = purchasePacket(snapshotContext, true), scope = makeReportingSnapshotScope('meta', snapshotContext)
  const snapshot = createReportingSnapshot(scope, packet, '2026-09-05T17:00:40.000Z')
  const stored = { id: '00000000-0000-4000-8000-000000001501', fingerprint: reportingFingerprint(snapshot),
    createdAt: snapshot.retrieval.completedAt, snapshot }
  const sources: SavedReportSources = { meta: { state: 'snapshot', receipt: { id: stored.id, fingerprint: stored.fingerprint, scope,
    retrievalStartedAt: snapshot.retrieval.startedAt, retrievalCompletedAt: snapshot.retrieval.completedAt, sourceAsOf: snapshot.sourceAsOf } },
    business: missing, website: missing, measurement: missing }
  const data = assembleSavedReportData({ meta: packet }, sources), review = deriveExpertReview(data)
  const input = { requestId: '00000000-0000-4000-8000-000000001502', title: 'Original withheld Purchase report',
    view: { pathname: '/performance' as const, query: { from: scope.range.from, to: scope.range.to, level: 'ad' as const } },
    sources, reviewIdentity: reportingFingerprint(review) }
  const artifact: SavedReportArtifact = { contract: SAVED_REPORT_VERSION, input, review,
    dataIdentity: reportingFingerprint(data), notes: packet.notes, notesIdentity: reportingFingerprint(packet.notes),
    versions: { manifest: SAVED_REPORT_VERSION, review: review.contractVersion, playbook: review.playbookVersion, export: SAVED_REPORT_EXPORT_VERSION } }
  const manifest = { id: input.requestId, accountId: snapshotContext.account.id,
    userId: '00000000-0000-4000-8000-000000001503', createdAt: '2026-09-05T17:02:00.000Z', artifact }
  return { packet, stored, manifest, data, review }
}
beforeEach(() => { vi.mocked(readReportingSnapshotById).mockReset(); vi.mocked(readSavedReportManifest).mockReset() })

describe('native Purchase reading and saved continuity', () => {
  it('carries valid own-input ROAS through strict interpretation, visible source disclosure and export', () => {
    const packet = purchasePacket()
    expect(() => validateReportingPacket(packet)).not.toThrow()
    expect(() => validateScopedReportingPacket(packet, makeReportingSnapshotScope('meta', packet.context), packet.context.asOf)).not.toThrow()
    const unavailable = { state: 'unavailable' as const, data: null, asOf: packet.context.asOf, notes: ['Fictional source not supplied.'] }
    const live: ReportingData = { context: packet.context, meta: packet.result,
      business: unavailable, website: unavailable, measurement: unavailable }
    const index = live.meta.data!.entities.findIndex(entity => entity.id === '301')
    const entity = live.meta.data!.entities[index], metric = entity.metrics.purchase_roas
    expect(metric.current.value).toBe(4)
    expect(metric.previous?.value).toBe(1.25)
    expect(mediaEntityFields(live, index).purchase_roas.current?.value).toBe(4)
    const html = renderToStaticMarkup(<ReportMetricValue metric={metric} compact />)
    expect(html).toContain('4.00×'); expect(html).toContain('1.25×')
    expect(html).toContain('Purchase'); expect(html).toContain('Meta')
    const exported = metricsToExportRows({ purchase_roas: metric }, entity.id, packet.context)[0]
    expect(exported).toMatchObject({ value: 4, previous_value: 1.25, source: 'meta', event: 'Purchase', availability: 'available' })
    expect(exported.claim_id).toBe(metric.current.claimId)
    expect(JSON.parse(exported.input_claim_ids!)).toEqual(metric.current.inputClaimIds)
    const unknown = live.meta.data!.entities.find(row => row.id === '302')!.metrics.purchase_roas
    expect(metricsToExportRows({ purchase_roas: unknown }, '302', packet.context)[0].value).toBeNull()
    expect(renderToStaticMarkup(<ReportMetricValue metric={unknown} />)).toContain('Unavailable')
  })

  it('reopens the original withheld report unchanged after a new native read can supply the ratio', async () => {
    const old = storedLegacy(), before = reportingFingerprint({ stored: old.stored, manifest: old.manifest })
    vi.mocked(readReportingSnapshotById).mockResolvedValue(old.stored)
    vi.mocked(readSavedReportManifest).mockResolvedValue(old.manifest)
    const fresh = purchasePacket({ ...snapshotContext, asOf: '2026-09-05T18:00:00.000Z' })
    expect(fresh.result.data!.entities.find(entity => entity.id === '301')!.metrics.purchase_roas.current.value).toBe(4)
    const db = { from: vi.fn(), rpc: vi.fn() }
    const reopened = await openSavedReportingReport(db as never, snapshotContext.account, old.manifest.id)
    expect(reopened.data).toEqual(old.data)
    expect(reopened.review).toEqual(old.review)
    expect(reopened.saved.dataIdentity).toBe(old.manifest.artifact.dataIdentity)
    expect(reopened.saved.reviewIdentity).toBe(old.manifest.artifact.input.reviewIdentity)
    const original = reopened.data.meta.data!.entities.find(entity => entity.id === '301')!.metrics.purchase_roas
    expect(original.current.value).toBeNull()
    expect(original.current.availability.blockerCodes).toEqual(['meta_outcome_hierarchy_unreconciled'])
    expect(readReportingSnapshotById).toHaveBeenCalledWith(db, old.stored.snapshot.scope, old.stored.id)
    expect(reportingFingerprint({ stored: old.stored, manifest: old.manifest })).toBe(before)
    expect(db.from).not.toHaveBeenCalled(); expect(db.rpc).not.toHaveBeenCalled()

    const transplanted = structuredClone(reopened)
    const ratio = transplanted.data.meta.data!.entities.find(entity => entity.id === '301')!.metrics.purchase_roas
    ratio.current.value = 4
    ratio.current.availability = { state: 'available', blockerCodes: [] }
    ratio.current.coverage = { state: 'complete', numerator: 1, denominator: 1 }
    await expect(validateSavedReportReply(transplanted)).rejects.toMatchObject({ code: 'invalid' })
  })
})
