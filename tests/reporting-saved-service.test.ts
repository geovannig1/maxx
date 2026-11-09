import { beforeEach, describe, expect, it, vi } from 'vitest'
import { snapshotContext, snapshotPacket } from './fixtures/reporting-snapshot'
import { createReportingSnapshot, makeReportingSnapshotScope, reportingFingerprint } from '@/lib/reporting/snapshot-contract'
import { deriveExpertReview } from '@/lib/reporting/review'
import { assembleSavedReportData } from '@/lib/reporting/saved-assembly'
import { saveReportingReport } from '@/lib/reporting/saved-service'
import type { SaveReportingReportInput } from '@/lib/reporting/saved-contract'
import { readReportingSnapshotById } from '@/lib/reporting/snapshot-store'
import { validateSavedReportReply } from '@/lib/reporting/saved-validation'
import { SAVED_REPORT_VERSION, SAVED_REPORT_EXPORT_VERSION } from '@/lib/reporting/saved-contract'
import { validateSavedReview } from '@/lib/reporting/saved-review'
import { metricEvidence } from '@/lib/reporting/review/evidence'
const limits = vi.hoisted(() => ({ bytes: 64 * 1024 * 1024 }))
vi.mock('@/lib/reporting/stream-contract', async original => ({ ...await original<typeof import('@/lib/reporting/stream-contract')>(),
  get MAX_REPORTING_STREAM_BYTES() { return limits.bytes } }))

const packet = snapshotPacket(), scope = makeReportingSnapshotScope('meta', snapshotContext)
const snapshot = createReportingSnapshot(scope, packet, '2026-09-05T17:00:40.000Z')
const receipt = { id: '00000000-0000-4000-8000-000000001401', fingerprint: reportingFingerprint(snapshot), scope,
  retrievalStartedAt: snapshot.retrieval.startedAt, retrievalCompletedAt: snapshot.retrieval.completedAt, sourceAsOf: snapshot.sourceAsOf }
const missing = { state: 'missing', code: 'not_supplied', context: null } as const
const input: SaveReportingReportInput = { requestId: '00000000-0000-4000-8000-000000001402', title: 'Original report',
  view: { pathname: '/dashboard', query: { from: scope.range.from, to: scope.range.to } },
  sources: { meta: { state: 'snapshot', receipt }, business: missing, website: missing, measurement: missing },
  reviewIdentity: '' }
input.reviewIdentity = reportingFingerprint(deriveExpertReview(assembleSavedReportData({ meta: packet }, input.sources)))
vi.mock('@/lib/reporting/snapshot-store', async original => ({ ...await original<typeof import('@/lib/reporting/snapshot-store')>(), readReportingSnapshotById: vi.fn() }))
const dbWithoutManifest = () => ({ rpc: vi.fn(() => ({ abortSignal: async () => ({ data: null, error: null }) })), from: vi.fn() })

describe('saved report server boundaries', () => {
  beforeEach(() => {
    vi.mocked(readReportingSnapshotById).mockClear()
    limits.bytes = 64 * 1024 * 1024
    vi.mocked(readReportingSnapshotById).mockResolvedValue({ id: receipt.id, fingerprint: receipt.fingerprint,
      createdAt: snapshot.retrieval.completedAt, snapshot })
  })
  it.each(['campaign', 'adset'])('requires an exact saved Meta parent receipt before saving %s history', async level => {
    const db = dbWithoutManifest()
    const selected = { ...input, view: { pathname: '/performance', query: { ...input.view.query, view: 'detail', level,
      campaign: 'campaign-1', ...(level === 'adset' ? { adset: 'set-7' } : {}) } } }
    await expect(saveReportingReport(db as never, snapshotContext.account, '00000000-0000-4000-8000-000000001403', selected))
      .rejects.toMatchObject({ code: 'invalid' })
    expect(db.rpc).not.toHaveBeenCalled()
    expect(readReportingSnapshotById).not.toHaveBeenCalled()
  })
  it('rejects a foreign receipt before any storage or source access', async () => {
    const db = { rpc: vi.fn(), from: vi.fn() }
    await expect(saveReportingReport(db as never, { ...snapshotContext.account, id: '00000000-0000-4000-8000-000000001312' },
      '00000000-0000-4000-8000-000000001403', input)).rejects.toMatchObject({ code: 'invalid' })
    expect(db.rpc).not.toHaveBeenCalled()
    expect(db.from).not.toHaveBeenCalled()
  })
  it('rejects metric payloads instead of publishing client evidence', async () => {
    await expect(saveReportingReport({} as never, snapshotContext.account, '00000000-0000-4000-8000-000000001403',
      { ...input, packet })).rejects.toMatchObject({ code: 'invalid' })
  })
  it.each([
    ['no immutable source', (value: SaveReportingReportInput) => ({ ...value, sources: { ...value.sources, meta: missing } })],
    ['different period', (value: SaveReportingReportInput) => ({ ...value, view: { ...value.view, query: { from: '2026-08-02', to: '2026-08-04' } } })],
    ['unexpected source', (value: SaveReportingReportInput) => ({ ...value, sources: { ...value.sources, business: value.sources.meta } })],
    ['different meta account', (value: SaveReportingReportInput) => ({ ...value, sources: { ...value.sources, meta: { state: 'snapshot', receipt: { ...receipt, scope: { ...scope, metaAccountId: 'act_999' } } } } })],
    ['wrong field fingerprint', (value: SaveReportingReportInput) => ({ ...value, sources: { ...value.sources, meta: { state: 'snapshot', receipt: { ...receipt, fingerprint: `sha256:${'0'.repeat(64)}` } } } })],
    ['different retrieval time', (value: SaveReportingReportInput) => ({ ...value, sources: { ...value.sources, meta: { state: 'snapshot', receipt: { ...receipt, retrievalCompletedAt: '2026-09-05T17:00:41.000Z' } } } })],
    ['future context', (value: SaveReportingReportInput) => ({ ...value, sources: { ...value.sources, website: { state: 'unavailable', code: 'source_unavailable', context: { ...snapshotContext, asOf: '2099-01-01T00:00:00.000Z' } } } })],
    ['unbacked foreign account', (value: SaveReportingReportInput) => ({ ...value, sources: { ...value.sources, website: { state: 'unavailable', code: 'source_unavailable', context: { ...snapshotContext, account: { ...snapshotContext.account, id: 'foreign' } } } } })],
    ['unbacked invented name', (value: SaveReportingReportInput) => ({ ...value, sources: { ...value.sources, website: { state: 'unavailable', code: 'source_unavailable', context: { ...snapshotContext, account: { ...snapshotContext.account, name: 'Invented identity' } } } } })],
    ['unbacked different dates', (value: SaveReportingReportInput) => ({ ...value, sources: { ...value.sources, website: { state: 'unavailable', code: 'source_unavailable', context: { ...snapshotContext, range: { from: '2026-08-02', to: '2026-08-04' }, comparison: { from: '2026-07-30', to: '2026-08-01' } } } } })],
    ['unsaved requested detail', (value: SaveReportingReportInput) => ({ ...value, view: { ...value.view, query: { ...value.view.query, ad: 'ad_999' } } })],
    ['client metric payload', (value: SaveReportingReportInput) => ({ ...value, packet })],
  ])('rejects %s without a manifest write', async (_, change) => {
    const db = dbWithoutManifest()
    await expect(saveReportingReport(db as never, snapshotContext.account, '00000000-0000-4000-8000-000000001403', change(input))).rejects.toMatchObject({ code: 'invalid' })
    expect(db.rpc.mock.calls.every(args => (args as unknown[])[0] !== 'save_reporting_report')).toBe(true)
  })
  it('rejects an changed visible review instead of saving a new assessment', async () => {
    await expect(saveReportingReport(dbWithoutManifest() as never, snapshotContext.account, '00000000-0000-4000-8000-000000001403',
      { ...input, reviewIdentity: `sha256:${'1'.repeat(64)}` })).rejects.toMatchObject({ code: 'changed' })
  })
  it('checks the complete reopen payload capacity before committing an unusable report', async () => {
    limits.bytes = 1
    const db = dbWithoutManifest()
    await expect(saveReportingReport(db as never, snapshotContext.account, '00000000-0000-4000-8000-000000001403', input)).rejects.toMatchObject({ code: 'invalid' })
    expect(db.rpc.mock.calls.some(args => (args as unknown[])[0] === 'save_reporting_report')).toBe(false)
  })
  it('does not substitute newest evidence when an exact snapshot is missing', async () => {
    vi.mocked(readReportingSnapshotById).mockResolvedValueOnce(null)
    await expect(saveReportingReport(dbWithoutManifest() as never, snapshotContext.account,
      '00000000-0000-4000-8000-000000001403', input)).rejects.toMatchObject({ code: 'not_found' })
  })
  it('validates original review refs and rejects changed metric content even with reused claim IDs', async () => {
    const data = assembleSavedReportData({ meta: packet }, input.sources), review = deriveExpertReview(data)
    review.findings[0].observation.evidence = [metricEvidence(data, 'meta', ['metrics', 'clicks'])!]
    expect(validateSavedReview(review, data)).toEqual(review)
    const bothWithheld = { ...review, findings: review.findings.map((finding, index) => index === 0
      ? { ...finding, evidencePeriods: { [finding.observation.evidence[0].id]: [] } } : finding) }
    expect(validateSavedReview(bothWithheld, data)).toEqual(bothWithheld)
    const withRef = review.findings.find(finding => finding.observation.evidence.length)!
    expect(withRef).toBeDefined()
    const changed = structuredClone(review)
    changed.findings.find(finding => finding.id === withRef.id)!.observation.evidence[0].metric.current.value = 999
    expect(() => validateSavedReview(changed, data)).toThrow('could not be validated')
  })
  it('binds loaded data and original review, rejects payload/reference/hash/version corruption', async () => {
    const data = assembleSavedReportData({ meta: packet }, input.sources), review = deriveExpertReview(data)
    const reply = { saved: { id: input.requestId, title: input.title, createdAt: '2026-09-06T17:00:00.000Z', view: input.view,
      range: data.context.range, sourceSummary: input.sources, sources: input.sources, reviewIdentity: reportingFingerprint(review),
      dataIdentity: reportingFingerprint(data), notesIdentity: reportingFingerprint(packet.notes), versions: { manifest: SAVED_REPORT_VERSION, review: review.contractVersion,
        playbook: review.playbookVersion, export: SAVED_REPORT_EXPORT_VERSION } }, data, review, notes: packet.notes }
    expect(await validateSavedReportReply(reply)).toEqual(reply)
    await expect(validateSavedReportReply({ ...reply, review: { ...review, playbookVersion: 'different' } })).rejects.toMatchObject({ code: 'invalid' })
    const changed = structuredClone(reply)
    changed.data.meta.data!.metrics.clicks.current.value = 99
    await expect(validateSavedReportReply(changed)).rejects.toMatchObject({ code: 'invalid' })
    const badContext = structuredClone(reply)
    badContext.saved.sources.website = { state: 'missing', code: 'not_supplied', context: { ...snapshotContext, account: { ...snapshotContext.account, id: 'foreign' } } }
    badContext.saved.sourceSummary = badContext.saved.sources
    await expect(validateSavedReportReply(badContext)).rejects.toMatchObject({ code: 'invalid' })
    await expect(validateSavedReportReply({ ...reply, notes: ['Changed note'] })).rejects.toMatchObject({ code: 'invalid' })
  })
})
