import { z } from 'zod'
import type { getAdminClient } from '@/lib/supabase/admin'
import { withReportingDeadline } from './deadline'
import { upgradeLegacyVocabulary } from '@/lib/outcomes/legacy-vocabulary'
import { canonicalReportingJson, reportingFingerprint } from './snapshot-contract'
import { SavedReviewSchema } from './saved-review'
import { SaveReportingReportInputSchema, SavedFingerprintSchema, SavedReportError, SavedVersionsSchema,
  SavedReportSummarySchema, SAVED_REPORT_VERSION, SAVED_SOURCES } from './saved-contract'

export type SavedReportingDatabase = Pick<ReturnType<typeof getAdminClient>, 'from' | 'rpc'>
export const SavedArtifactSchema = z.object({ contract: z.literal(SAVED_REPORT_VERSION),
  input: SaveReportingReportInputSchema, review: SavedReviewSchema, versions: SavedVersionsSchema,
  dataIdentity: SavedFingerprintSchema, notes: z.array(z.string()), notesIdentity: SavedFingerprintSchema }).strict()
export type SavedReportArtifact = z.infer<typeof SavedArtifactSchema>
const uuid = z.string().uuid(), timestamp = z.string().datetime({ offset: true })
const RowSchema = z.object({ id: uuid, ad_account_id: uuid, created_by_user_id: uuid, request_id: uuid,
  artifact_canonical: z.string(), artifact_fingerprint: SavedFingerprintSchema, created_at: timestamp,
  meta_snapshot_id: uuid.nullable(), business_snapshot_id: uuid.nullable(), website_snapshot_id: uuid.nullable(),
  measurement_snapshot_id: uuid.nullable() }).strict()
export interface StoredSavedReport {
  id: string; accountId: string; userId: string; createdAt: string; artifact: SavedReportArtifact
  /** The stored artifact used legacy source-named vocabulary and was upgraded on read (integrity was
   *  verified on its stored bytes first); its derived identities describe the upgraded content. */
  upgradedVocabulary?: boolean
}

function row(raw: unknown, accountId: string): StoredSavedReport {
  try {
    const value = RowSchema.parse(raw)
    if (value.ad_account_id !== accountId || Buffer.byteLength(value.artifact_canonical) > 64 * 1024 * 1024) throw new Error()
    const decoded = JSON.parse(value.artifact_canonical)
    if (value.artifact_fingerprint !== reportingFingerprint(decoded) || value.artifact_canonical !== canonicalReportingJson(decoded)) throw new Error()
    if (decoded?.contract !== SAVED_REPORT_VERSION || !SavedVersionsSchema.safeParse(decoded?.versions).success
      || decoded?.review?.contractVersion !== 'report_review.v1') throw new SavedReportError('incompatible')
    // The stored parts' identities hold on the stored bytes; only then is legacy vocabulary upgraded,
    // and the derived identities re-derived from the upgraded parts.
    if (decoded?.input?.reviewIdentity !== reportingFingerprint(decoded?.review)
      || decoded?.notesIdentity !== reportingFingerprint(decoded?.notes)) throw new Error()
    const upgraded = upgradeLegacyVocabulary(decoded)
    const upgradedVocabulary = canonicalReportingJson(upgraded) !== value.artifact_canonical
    const artifact = SavedArtifactSchema.parse(upgradedVocabulary
      ? { ...upgraded, input: { ...upgraded.input, reviewIdentity: reportingFingerprint(upgraded.review) },
        notesIdentity: reportingFingerprint(upgraded.notes) }
      : upgraded)
    if (artifact.input.requestId !== value.request_id || artifact.review.context.account.id !== accountId
      || artifact.versions.review !== artifact.review.contractVersion || artifact.versions.playbook !== artifact.review.playbookVersion
      || artifact.input.reviewIdentity !== reportingFingerprint(artifact.review)
      || artifact.notesIdentity !== reportingFingerprint(artifact.notes)) throw new Error()
    for (const source of SAVED_SOURCES) {
      const binding = artifact.input.sources[source]
      if (value[`${source}_snapshot_id`] !== ('receipt' in binding ? binding.receipt.id : null)) throw new Error()
    }
    return { id: value.id, accountId, userId: value.created_by_user_id, createdAt: value.created_at, artifact,
      ...(upgradedVocabulary ? { upgradedVocabulary } : {}) }
  } catch (error) { throw error instanceof SavedReportError ? error : new SavedReportError('invalid') }
}
async function rpc(db: SavedReportingDatabase, name: string, args: Record<string, unknown>): Promise<unknown> {
  try {
    return await withReportingDeadline(async signal => {
      const { data, error } = await db.rpc(name, args).abortSignal(signal)
      if (error) throw new SavedReportError(error.code === '23505' ? 'changed' : error.code === '23514' ? 'invalid' : 'unavailable')
      return data
    }, 5_000)
  } catch (error) { throw error instanceof SavedReportError ? error : new SavedReportError('unavailable') }
}
export async function readSavedReportManifest(db: SavedReportingDatabase, accountId: string,
  selector: { id: string } | { userId: string; requestId: string }): Promise<StoredSavedReport | null> {
  if (!uuid.safeParse(accountId).success || Object.values(selector).some(value => !uuid.safeParse(value).success)) throw new SavedReportError('invalid')
  const value = await rpc(db, 'read_saved_reporting_report', { p_account: accountId,
    p_id: 'id' in selector ? selector.id : null, p_user: 'userId' in selector ? selector.userId : null,
    p_request: 'requestId' in selector ? selector.requestId : null })
  const result = value === null ? null : row(value, accountId)
  if (result && ('id' in selector ? result.id !== selector.id
    : result.userId !== selector.userId || result.artifact.input.requestId !== selector.requestId)) throw new SavedReportError('invalid')
  return result
}
export async function insertSavedReportManifest(db: SavedReportingDatabase, accountId: string, userId: string,
  artifact: SavedReportArtifact): Promise<StoredSavedReport> {
  const text = canonicalReportingJson(SavedArtifactSchema.parse(artifact))
  if (Buffer.byteLength(text) > 64 * 1024 * 1024) throw new SavedReportError('invalid')
  const result = row(await rpc(db, 'save_reporting_report', { p_account: accountId, p_user: userId,
    p_request: artifact.input.requestId, p_artifact_canonical: text }), accountId)
  if (result.userId !== userId || canonicalReportingJson(result.artifact) !== text) throw new SavedReportError('invalid')
  return result
}
const CursorSchema = z.object({ before: timestamp, id: uuid }).strict()
export async function listSavedReportManifests(db: SavedReportingDatabase, accountId: string, cursor?: string | null) {
  let page: z.infer<typeof CursorSchema> | null = null
  try {
    uuid.parse(accountId)
    if (cursor) {
      if (cursor.length > 256 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error()
      page = CursorSchema.parse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')))
    }
  } catch { throw new SavedReportError('invalid') }
  const raw = await rpc(db, 'list_saved_reporting_reports', { p_account: accountId, p_before: page?.before ?? null, p_before_id: page?.id ?? null })
  const parsed = z.array(SavedReportSummarySchema).max(21).safeParse(raw)
  if (!parsed.success) throw new SavedReportError('invalid')
  for (const summary of parsed.data) for (const source of SAVED_SOURCES) {
    const binding = summary.sourceSummary[source]
    if ('receipt' in binding && (binding.receipt.scope.accountId !== accountId || binding.receipt.scope.source !== source)) throw new SavedReportError('invalid')
    if ('context' in binding && binding.context && binding.context.account.id !== accountId) throw new SavedReportError('invalid')
  }
  const reports = parsed.data.slice(0, 20), last = reports.at(-1)
  return { reports, nextCursor: parsed.data.length > 20 && last
    ? Buffer.from(JSON.stringify({ before: last.createdAt, id: last.id })).toString('base64url') : null }
}
