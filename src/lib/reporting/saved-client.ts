import { z } from 'zod'
import { checkReportingResponse } from './response-status'
import { readPreparedBody } from './prepared-reader'
import { withReportingDeadline, REPORTING_REQUEST_TIMEOUT_MS } from './deadline'
import { validateSavedReportReply } from './saved-validation'
import { SavedReportError, SavedReportSummarySchema, type SaveReportingReportInput } from './saved-contract'
import { savedCanonicalJson } from './saved-identity'

const ListSchema = z.object({ reports: z.array(SavedReportSummarySchema), nextCursor: z.string().nullable() }).strict()
async function savedResponse(url: string, signal: AbortSignal, init?: RequestInit) {
  const response = await fetch(url, { ...init, cache: 'no-store', signal })
  if (response.status === 404) throw new SavedReportError('not_found')
  if (response.status === 409) throw new SavedReportError('changed')
  if (response.status === 422) throw new SavedReportError('incompatible')
  checkReportingResponse(response)
  return readPreparedBody(response, signal)
}
export function readSavedReport(id: string, signal: AbortSignal) {
  return withReportingDeadline(async child => {
    if (!z.string().uuid().safeParse(id).success) throw new SavedReportError('invalid')
    const reply = await validateSavedReportReply(await savedResponse(`/api/reporting/saved/${encodeURIComponent(id)}`, child))
    if (reply.saved.id !== id) throw new SavedReportError('invalid')
    return reply
  }, REPORTING_REQUEST_TIMEOUT_MS, signal)
}
export function createSavedReport(input: SaveReportingReportInput, signal: AbortSignal) {
  return withReportingDeadline(async child => {
    const reply = await validateSavedReportReply(await savedResponse('/api/reporting/saved', child, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
    }))
    if (reply.saved.title !== input.title || reply.saved.reviewIdentity !== input.reviewIdentity
      || savedCanonicalJson(reply.saved.view) !== savedCanonicalJson(input.view)
      || savedCanonicalJson(reply.saved.sources) !== savedCanonicalJson(input.sources)) throw new SavedReportError('changed')
    return reply
  }, REPORTING_REQUEST_TIMEOUT_MS, signal)
}
export function readSavedReportList(cursor: string | null, signal: AbortSignal) {
  return withReportingDeadline(async child => ListSchema.parse(await savedResponse(`/api/reporting/saved${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`, child)), REPORTING_REQUEST_TIMEOUT_MS, signal)
}
