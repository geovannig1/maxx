import { describe, expect, it, vi } from 'vitest'
import { readPreparedReporting } from '@/lib/reporting/prepared-reader'
import { preparedReportingReply } from '@/lib/reporting/prepared-response'
import { REPORTING_PREPARED_TYPE } from '@/lib/reporting/prepared-contract'
import { savedPreviewSnapshots } from './reporting-browser/saved-preview-fixture'
import { createSavedReport, readSavedReport } from '@/lib/reporting/saved-client'
import { assembleSavedReportData } from '@/lib/reporting/saved-assembly'
import { deriveExpertReview } from '@/lib/reporting/review'
import { savedReportIdentity } from '@/lib/reporting/saved-identity'
import { SAVED_SOURCES, type SavedReportSources, type SaveReportingReportInput, type OpenSavedReportingReportReply } from '@/lib/reporting/saved-contract'

async function savedReply() {
  const snapshots = savedPreviewSnapshots('movement', '2026-09-02', '2026-09-04')
  const sources = Object.fromEntries(SAVED_SOURCES.map(source => {
    const stored = snapshots[source], snapshot = stored.snapshot
    return [source, { state: 'snapshot', receipt: { id: stored.id, fingerprint: stored.fingerprint, scope: snapshot.scope,
      retrievalStartedAt: snapshot.retrieval.startedAt, retrievalCompletedAt: snapshot.retrieval.completedAt, sourceAsOf: snapshot.sourceAsOf } }]
  })) as SavedReportSources
  const data = assembleSavedReportData(Object.fromEntries(SAVED_SOURCES.map(source => [source, snapshots[source].snapshot.packet])), sources)
  const review = deriveExpertReview(data), reviewIdentity = await savedReportIdentity(review)
  const notes = [...new Set(Object.values(snapshots).flatMap(stored => stored.snapshot.packet.notes))]
  const input: SaveReportingReportInput = { requestId: crypto.randomUUID(), title: 'Original selected report',
    view: { pathname: '/dashboard', query: { from: '2026-09-02', to: '2026-09-04' } }, sources, reviewIdentity }
  const reply: OpenSavedReportingReportReply = { saved: { id: crypto.randomUUID(), title: input.title, createdAt: new Date().toISOString(),
    view: input.view, range: data.context.range, sourceSummary: sources, sources, reviewIdentity, dataIdentity: await savedReportIdentity(data), notesIdentity: await savedReportIdentity(notes),
    versions: { manifest: 'saved_report.v1', review: 'report_review.v1', playbook: review.playbookVersion, export: 'report_export.v1' } }, data, review, notes }
  return { input, reply }
}

describe('saved request and reply identity', () => {
  it('rejects another valid saved report returned for the requested ID', async () => {
    const { reply } = await savedReply()
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify(reply), { headers: { 'Content-Type': 'application/json' } }))
    try {
      await expect(readSavedReport(crypto.randomUUID(), new AbortController().signal)).rejects.toThrow()
      await expect(readSavedReport(reply.saved.id, new AbortController().signal)).resolves.toEqual(reply)
    } finally { fetcher.mockRestore() }
  })
  it('rejects a valid manifest that does not match the save command', async () => {
    const { input, reply } = await savedReply()
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify(reply), { headers: { 'Content-Type': 'application/json' } }))
    try {
      await expect(createSavedReport({ ...input, title: 'A different requested title' }, new AbortController().signal)).rejects.toThrow()
      await expect(createSavedReport(input, new AbortController().signal)).resolves.toEqual(reply)
    } finally { fetcher.mockRestore() }
  })
})

function response(fingerprint: 'valid' | 'absent' | 'wrong' = 'valid') {
  const saved = savedPreviewSnapshots('movement', '2026-09-02', '2026-09-04').business
  const reply = preparedReportingReply(saved.snapshot.scope, saved, null)
  const snapshot = { ...reply.snapshot!, ...(fingerprint === 'absent' ? {} : { fingerprint: fingerprint === 'valid' ? saved.fingerprint : `sha256:${'0'.repeat(64)}` }) }
  if (fingerprint === 'absent') delete snapshot.fingerprint
  return { saved, response: new Response(JSON.stringify({ ...reply, snapshot }), { headers: { 'Content-Type': REPORTING_PREPARED_TYPE } }) }
}
describe('exact evidence delivery to the visible report', () => {
  it('retains an older-server report without pretending it has an immutable receipt', async () => {
    const input = response('absent'), delivery = vi.fn()
    const packet = await readPreparedReporting(input.response, 'business', 'from=2026-09-02&to=2026-09-04', new AbortController().signal, false, undefined, delivery)
    expect(packet).toEqual(input.saved.snapshot.packet)
    expect(delivery).toHaveBeenCalledWith({ packet, receipt: null })
  })
  it('delivers the exact fingerprint-bound receipt with its original packet', async () => {
    const input = response(), delivery = vi.fn()
    const packet = await readPreparedReporting(input.response, 'business', 'from=2026-09-02&to=2026-09-04', new AbortController().signal, false, undefined, delivery)
    expect(delivery).toHaveBeenCalledWith({ packet, receipt: {
      id: input.saved.id, fingerprint: input.saved.fingerprint, scope: input.saved.snapshot.scope,
      retrievalStartedAt: input.saved.snapshot.retrieval.startedAt, retrievalCompletedAt: input.saved.snapshot.retrieval.completedAt,
      sourceAsOf: input.saved.snapshot.sourceAsOf,
    } })
  })
  it('rejects a packet whose content does not match its immutable receipt before displaying it', async () => {
    const input = response('wrong'), delivery = vi.fn(), progress = vi.fn()
    await expect(readPreparedReporting(input.response, 'business', 'from=2026-09-02&to=2026-09-04', new AbortController().signal, false, progress, delivery)).rejects.toThrow()
    expect(delivery).not.toHaveBeenCalled()
    expect(progress).not.toHaveBeenCalled()
  })
})
