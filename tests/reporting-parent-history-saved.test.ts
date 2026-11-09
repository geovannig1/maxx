import { beforeEach, describe, expect, it, vi } from 'vitest'
import { snapshotContext, snapshotPacket } from './fixtures/reporting-snapshot'
import { createReportingSnapshot, makeReportingSnapshotScope, reportingFingerprint } from '@/lib/reporting/snapshot-contract'
import { deriveExpertReview } from '@/lib/reporting/review'
import { assembleSavedReportData } from '@/lib/reporting/saved-assembly'
import { saveReportingReport, openSavedReportingReport } from '@/lib/reporting/saved-service'
import { SAVED_REPORT_VERSION, SAVED_REPORT_EXPORT_VERSION, type SaveReportingReportInput } from '@/lib/reporting/saved-contract'
import type { StoredSavedReport, SavedReportArtifact } from '@/lib/reporting/saved-store'
import type { ReportingHistoryEntity } from '@/lib/reporting/snapshot-scope'

const mocks = vi.hoisted(() => ({ read: vi.fn(), insert: vi.fn(), snapshot: vi.fn() }))
vi.mock('@/lib/reporting/snapshot-store', () => ({ readReportingSnapshotById: mocks.snapshot }))
vi.mock('@/lib/reporting/saved-store', () => ({ readSavedReportManifest: mocks.read,
  insertSavedReportManifest: mocks.insert, listSavedReportManifests: vi.fn() }))
const id = '00000000-0000-4000-8000-000000001402', userId = '00000000-0000-4000-8000-000000001403'
const parent: ReportingHistoryEntity = { level: 'campaign', id: 'campaign-1' }
const missing = { state: 'missing', code: 'not_supplied', context: null } as const

function evidence(historyEntity?: ReportingHistoryEntity) {
  const packet = snapshotPacket(), scope = makeReportingSnapshotScope('meta', snapshotContext, { historyEntity })
  const snapshot = createReportingSnapshot(scope, packet, '2026-09-05T17:00:40.000Z')
  const stored = { id: '00000000-0000-4000-8000-000000001401', snapshot, fingerprint: reportingFingerprint(snapshot), createdAt: snapshot.retrieval.completedAt }
  const sources = { meta: { state: 'snapshot' as const, receipt: { id: stored.id, fingerprint: stored.fingerprint, scope,
    retrievalStartedAt: snapshot.retrieval.startedAt, retrievalCompletedAt: snapshot.retrieval.completedAt, sourceAsOf: snapshot.sourceAsOf } },
  business: missing, website: missing, measurement: missing }
  const data = assembleSavedReportData({ meta: packet }, sources), review = deriveExpertReview(data)
  const input: SaveReportingReportInput = { requestId: id, title: 'Parent investigation',
    view: { pathname: '/performance', query: { from: scope.range.from, to: scope.range.to, view: 'detail',
      level: parent.level, campaign: parent.id } }, sources, reviewIdentity: reportingFingerprint(review) }
  const artifact: SavedReportArtifact = { contract: SAVED_REPORT_VERSION, input, review, dataIdentity: reportingFingerprint(data),
    notes: packet.notes, notesIdentity: reportingFingerprint(packet.notes), versions: { manifest: SAVED_REPORT_VERSION,
      review: review.contractVersion, playbook: review.playbookVersion, export: SAVED_REPORT_EXPORT_VERSION } }
  return { stored, input, artifact }
}
function manifest(artifact: SavedReportArtifact): StoredSavedReport {
  return { id, accountId: snapshotContext.account.id, userId, createdAt: '2026-09-05T17:03:00.000Z', artifact }
}
beforeEach(() => {
  vi.clearAllMocks()
  mocks.read.mockResolvedValue(null)
  mocks.insert.mockImplementation(async (_db, _account, _user, artifact) => manifest(artifact))
})

describe('selected parent save and historical reopen boundaries', () => {
  it.each(['campaign', 'adset'] as const)('saves and opens the exact %s receipt without rewriting source evidence', async level => {
    const historyEntity = { level, id: level === 'campaign' ? parent.id : 'set-7' }
    const value = evidence(historyEntity)
    value.input.view.query = { ...value.input.view.query, level, ...(level === 'adset' ? { adset: 'set-7' } : {}) }
    const before = JSON.stringify(value.stored)
    mocks.snapshot.mockResolvedValue(value.stored)
    const saved = await saveReportingReport({} as never, snapshotContext.account, userId, value.input)
    expect(saved.saved.view).toEqual(value.input.view)
    expect(saved.saved.sources.meta).toEqual(value.input.sources.meta)
    expect(saved.data.meta).toEqual(value.stored.snapshot.packet.result)
    expect(mocks.snapshot.mock.calls.every(([, scope, snapshotId]) =>
      JSON.stringify(scope) === JSON.stringify(value.stored.snapshot.scope) && snapshotId === value.stored.id)).toBe(true)
    expect(mocks.insert).toHaveBeenCalledOnce()
    expect(JSON.stringify(value.stored)).toBe(before)
  })
  it('saves only when the visible breakdown matches the exact parent receipt', async () => {
    const historyEntity: ReportingHistoryEntity = { ...parent, breakdown: 'region' }
    const value = evidence(historyEntity)
    value.input.view.query = { ...value.input.view.query, breakdown: 'region' }
    mocks.snapshot.mockResolvedValue(value.stored)
    expect((await saveReportingReport({} as never, snapshotContext.account, userId, value.input)).saved.view.query.breakdown).toBe('region')
    value.input.view.query.breakdown = 'age'
    await expect(saveReportingReport({} as never, snapshotContext.account, userId, value.input)).rejects.toMatchObject({ code: 'invalid' })
  })
  it.each([{ ...parent, id: 'campaign-2' }, { level: 'adset', id: parent.id }] as ReportingHistoryEntity[])(
    'rejects a receipt for another parent %j before reading or writing storage', async historyEntity => {
      const value = evidence(historyEntity)
      await expect(saveReportingReport({} as never, snapshotContext.account, userId, value.input)).rejects.toMatchObject({ code: 'invalid' })
      expect(mocks.read).not.toHaveBeenCalled()
      expect(mocks.snapshot).not.toHaveBeenCalled()
      expect(mocks.insert).not.toHaveBeenCalled()
    })
  it('opens old saved parent navigation with its original absent selector and never upgrades its evidence', async () => {
    const value = evidence(), before = JSON.stringify(value)
    mocks.read.mockResolvedValue(manifest(value.artifact))
    mocks.snapshot.mockResolvedValue(value.stored)
    const reopened = await openSavedReportingReport({} as never, snapshotContext.account, id)
    expect(reopened.saved.view).toEqual(value.input.view)
    expect(reopened.saved.sources.meta).toEqual(value.input.sources.meta)
    expect(reopened.data.meta).toEqual(value.stored.snapshot.packet.result)
    expect(mocks.insert).not.toHaveBeenCalled()
    expect(JSON.stringify(value)).toBe(before)
    await expect(saveReportingReport({} as never, snapshotContext.account, userId, value.input)).rejects.toMatchObject({ code: 'invalid' })
  })
})
