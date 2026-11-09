import { ReportingHistoryEntitySchema } from './snapshot-scope'
import { z } from 'zod'
import type { ReportingContext, ReportingData, ReportingPacket, ReportingSectionName } from './contracts'
import { compareCreativeEvidenceInstants as compareInstants } from './creative-assignment-contract'
import { readReportingSnapshotById } from './snapshot-store'
import { canonicalReportingJson, reportingFingerprint, ReportingSnapshotError } from './snapshot-contract'
import { deriveExpertReview } from './review'
import { assembleSavedReportData } from './saved-assembly'
import { validateSavedReportReply } from './saved-validation'
import { insertSavedReportManifest, listSavedReportManifests, readSavedReportManifest,
  type SavedReportingDatabase, type StoredSavedReport } from './saved-store'
import { SavedReportError, SaveReportingReportInputSchema, SAVED_REPORT_VERSION, SAVED_REPORT_EXPORT_VERSION,
  SAVED_SOURCES, savedSnapshotNotes, type SaveReportingReportInput, type SavedReportSources, type OpenSavedReportingReportReply } from './saved-contract'

export type { SaveReportingReportInput, SaveReportingReportReply, OpenSavedReportingReportReply,
  ListSavedReportingReportsReply } from './saved-contract'
const equal = (a: unknown, b: unknown) => canonicalReportingJson(a) === canonicalReportingJson(b)

function validateScope(input: SaveReportingReportInput, account: ReportingContext['account'], observedAt: string, saving: boolean) {
  const receipts = SAVED_SOURCES.flatMap(source => 'receipt' in input.sources[source] ? [input.sources[source].receipt] : [])
  const first = receipts[0]?.scope
  if (!first || !z.string().uuid().safeParse(account.id).success) throw new SavedReportError('invalid')
  if (input.view.query.from !== first.requestedRange.from || input.view.query.to !== first.requestedRange.to) throw new SavedReportError('invalid')
  const { pathname, query } = input.view
  if (saving && pathname === '/performance' && query.view === 'detail' && ['campaign', 'adset'].includes(query.level)) {
    const selected = ReportingHistoryEntitySchema.safeParse({ level: query.level,
      id: query[query.level === 'campaign' ? 'campaign' : 'adset'], ...(query.breakdown ? { breakdown: query.breakdown } : {}) })
    const meta = input.sources.meta
    if (!selected.success || query.ad || !('receipt' in meta) || !meta.receipt.scope.historyEntity || !equal(meta.receipt.scope.historyEntity, selected.data)) throw new SavedReportError('invalid')
  }
  for (const source of SAVED_SOURCES) {
    const binding = input.sources[source]
    if ('receipt' in binding) {
      const { scope, retrievalStartedAt, retrievalCompletedAt, sourceAsOf } = binding.receipt
      if (scope.accountId !== account.id || scope.metaAccountId !== account.metaAccountId || scope.source !== source
        || !equal([scope.requestedRange, scope.range, scope.comparison], [first.requestedRange, first.range, first.comparison])
        || compareInstants(retrievalStartedAt, retrievalCompletedAt) > 0 || compareInstants(retrievalCompletedAt, observedAt) > 0
        || sourceAsOf && compareInstants(sourceAsOf, retrievalStartedAt) > 0) throw new SavedReportError('invalid')
      if (saving && source === 'meta' && input.view.query.ad && !scope.detailIds.includes(input.view.query.ad)) throw new SavedReportError('invalid')
    } else if (binding.context) {
      const context = binding.context
      if (context.account.id !== account.id || context.account.metaAccountId !== account.metaAccountId
        || saving && context.account.name !== account.name
        || !equal([context.range, context.comparison, context.timezone, context.currency], [first.range, first.comparison, first.timezone, first.currency])
        || compareInstants(context.asOf, observedAt) > 0) throw new SavedReportError('invalid')
    }
  }
}
async function evidence(db: SavedReportingDatabase, sources: SavedReportSources, account: ReportingContext['account'], saving: boolean) {
  const packets: Partial<Record<ReportingSectionName, ReportingPacket>> = {}
  const entries = await Promise.all(SAVED_SOURCES.map(async source => {
    const binding = sources[source]
    if (!('receipt' in binding)) return null
    const receipt = binding.receipt
    let stored
    try { stored = await readReportingSnapshotById(db, receipt.scope, receipt.id) }
    catch (error) { throw new SavedReportError(error instanceof ReportingSnapshotError && error.kind === 'unavailable' ? 'unavailable' : 'invalid') }
    if (!stored) throw new SavedReportError('not_found')
    if (stored.fingerprint !== receipt.fingerprint || !equal(stored.snapshot.scope, receipt.scope)
      || stored.snapshot.retrieval.startedAt !== receipt.retrievalStartedAt || stored.snapshot.retrieval.completedAt !== receipt.retrievalCompletedAt
      || stored.snapshot.sourceAsOf !== receipt.sourceAsOf || saving && stored.snapshot.packet.context.account.name !== account.name) throw new SavedReportError('invalid')
    return [source, stored.snapshot.packet] as const
  }))
  for (const entry of entries) if (entry) packets[entry[0]] = entry[1]
  const data = assembleSavedReportData(packets, sources)
  // Unbacked metadata cannot introduce a different visible name, even on an old saved account.
  for (const source of SAVED_SOURCES) {
    const binding = sources[source]
    if ('context' in binding && binding.context && binding.context.account.name !== data.context.account.name) throw new SavedReportError('invalid')
  }
  const notes = [...new Set(SAVED_SOURCES.flatMap(source => {
    const binding = sources[source], packet = packets[source]
    return packet && 'receipt' in binding ? savedSnapshotNotes(packet.notes, binding.receipt.scope) : []
  }))]
  return { data, notes }
}
function projected(stored: StoredSavedReport, data: ReportingData): Promise<OpenSavedReportingReportReply> {
  const { artifact, id, createdAt } = stored, input = artifact.input
  return validateSavedReportReply({ saved: { id, createdAt, title: input.title, view: input.view,
    sources: input.sources, sourceSummary: input.sources, range: data.context.range, versions: artifact.versions,
    // An upgraded legacy artifact's data identity is re-derived from the upgraded snapshots, whose own
    // fingerprints were checked against the receipts the stored artifact carries.
    reviewIdentity: input.reviewIdentity, dataIdentity: stored.upgradedVocabulary ? reportingFingerprint(data) : artifact.dataIdentity,
    notesIdentity: artifact.notesIdentity },
  data, review: artifact.review, notes: artifact.notes })
}
async function reopen(db: SavedReportingDatabase, account: ReportingContext['account'], stored: StoredSavedReport): Promise<OpenSavedReportingReportReply> {
  validateScope(stored.artifact.input, account, stored.createdAt, false)
  const observed = await evidence(db, stored.artifact.input.sources, account, false)
  if (!equal(observed.notes, stored.artifact.notes)) throw new SavedReportError('invalid')
  return projected(stored, observed.data)
}
export async function saveReportingReport(db: SavedReportingDatabase, account: ReportingContext['account'], userId: string,
  raw: unknown): Promise<OpenSavedReportingReportReply> {
  const parsed = SaveReportingReportInputSchema.safeParse(raw)
  if (!parsed.success || !z.string().uuid().safeParse(userId).success) throw new SavedReportError('invalid')
  const input = parsed.data
  validateScope(input, account, new Date().toISOString(), true)
  const existing = await readSavedReportManifest(db, account.id, { userId, requestId: input.requestId })
  if (existing) {
    if (!equal(existing.artifact.input, input)) throw new SavedReportError('changed')
    return reopen(db, account, existing)
  }
  const { data, notes } = await evidence(db, input.sources, account, true), review = deriveExpertReview(data)
  if (review.input.rejectedSources.length || reportingFingerprint(review) !== input.reviewIdentity) throw new SavedReportError('changed')
  const artifact = { contract: SAVED_REPORT_VERSION, input, review, dataIdentity: reportingFingerprint(data), notes, notesIdentity: reportingFingerprint(notes),
    versions: { manifest: SAVED_REPORT_VERSION, review: review.contractVersion, playbook: review.playbookVersion, export: SAVED_REPORT_EXPORT_VERSION } }
  // Validate the complete reopen representation and transport capacity before committing.
  // PostgreSQL emits a millisecond timestamp with this offset; no source clock changes.
  await projected({ id: input.requestId, accountId: account.id, userId,
    createdAt: new Date().toISOString().replace('Z', '+00:00'), artifact }, data)
  return reopen(db, account, await insertSavedReportManifest(db, account.id, userId, artifact))
}
export async function openSavedReportingReport(db: SavedReportingDatabase, account: ReportingContext['account'], id: string) {
  const stored = await readSavedReportManifest(db, account.id, { id })
  if (!stored) throw new SavedReportError('not_found')
  return reopen(db, account, stored)
}
export async function listSavedReportingReports(db: SavedReportingDatabase, accountId: string, cursor?: string | null) {
  return listSavedReportManifests(db, accountId, cursor)
}
