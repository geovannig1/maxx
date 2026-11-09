import { z } from 'zod'
import { ReportingDataSchema } from './contracts'
import { validateScopedReportingPacket } from './packet-scope'
import { compareCreativeEvidenceInstants as compareInstants } from './creative-assignment-contract'
import { validateSavedReview } from './saved-review'
import { savedCanonicalJson, savedReportIdentity } from './saved-identity'
import { MAX_REPORTING_STREAM_BYTES } from './stream-contract'
import { expandReportingData } from './packet-format'
import { SavedFingerprintSchema, SavedReportError, SavedReportSummarySchema, SavedSourcesSchema, SavedVersionsSchema,
  SAVED_SOURCES, SAVED_SOURCE_MESSAGES, type OpenSavedReportingReportReply } from './saved-contract'

const ReplySchema = z.object({ saved: SavedReportSummarySchema.extend({ sources: SavedSourcesSchema,
  reviewIdentity: SavedFingerprintSchema, dataIdentity: SavedFingerprintSchema, notesIdentity: SavedFingerprintSchema }),
  data: ReportingDataSchema, review: z.unknown(), notes: z.array(z.string()) }).strict()

export async function validateSavedReportReply(raw: unknown): Promise<OpenSavedReportingReportReply> {
  try {
    if (new TextEncoder().encode(JSON.stringify(raw)).byteLength > MAX_REPORTING_STREAM_BYTES) throw new Error()
    // Transported data may be dataVersion 2: identity and validation apply to its expansion.
    const value = raw !== null && typeof raw === 'object' && 'data' in raw ? { ...raw, data: expandReportingData(raw.data) } : raw
    const { saved, data, review: rawReview, notes } = ReplySchema.parse(value)
    if (!SavedVersionsSchema.safeParse(saved.versions).success) throw new SavedReportError('incompatible')
    if (savedCanonicalJson(saved.sources) !== savedCanonicalJson(saved.sourceSummary)
      || savedCanonicalJson(saved.range) !== savedCanonicalJson(data.context.range)
      || compareInstants(data.context.asOf, saved.createdAt) > 0
      || await savedReportIdentity(data) !== saved.dataIdentity
      || await savedReportIdentity(rawReview) !== saved.reviewIdentity
      || await savedReportIdentity(notes) !== saved.notesIdentity || new Set(notes).size !== notes.length) throw new Error()
    let latest: string | null = null
    for (const source of SAVED_SOURCES) {
      const binding = saved.sources[source], result = data[source]
      if (!result) throw new Error()
      if (binding.state === 'snapshot' || binding.state === 'retained_snapshot') {
        const receipt = binding.receipt
        if (receipt.sourceAsOf !== result.asOf || receipt.scope.source !== source
          || compareInstants(receipt.retrievalCompletedAt, saved.createdAt) > 0
          || saved.view.query.from !== receipt.scope.requestedRange.from || saved.view.query.to !== receipt.scope.requestedRange.to) throw new Error()
        validateScopedReportingPacket({ section: source, context: { ...data.context, asOf: receipt.retrievalStartedAt },
          result, notes: [] }, receipt.scope, receipt.retrievalCompletedAt)
        if (!latest || compareInstants(receipt.retrievalStartedAt, latest) > 0) latest = receipt.retrievalStartedAt
      } else if (result.data !== null || result.state !== 'unavailable' || result.asOf !== null
        || savedCanonicalJson(result.notes) !== savedCanonicalJson([SAVED_SOURCE_MESSAGES[binding.code]])) throw new Error()
      if ('context' in binding && binding.context) {
        const { asOf, ...context } = binding.context, { asOf: cutoff, ...expected } = data.context
        if (savedCanonicalJson(context) !== savedCanonicalJson(expected) || compareInstants(asOf, cutoff) > 0) throw new Error()
        if (!latest || compareInstants(asOf, latest) > 0) latest = asOf
      }
    }
    if (!latest || compareInstants(latest, data.context.asOf) !== 0) throw new Error()
    const review = validateSavedReview(rawReview, data)
    if (review.contractVersion !== saved.versions.review || review.playbookVersion !== saved.versions.playbook) throw new Error()
    return { saved, data, review, notes }
  } catch (error) {
    if (error instanceof SavedReportError) throw error
    throw new SavedReportError('invalid')
  }
}
