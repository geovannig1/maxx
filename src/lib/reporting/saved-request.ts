import { withReportingDeadline, ReportingDeadlineError } from './deadline'
import { SaveReportingReportInputSchema } from './saved-contract'

export class SavedRequestError extends Error {
  constructor(readonly status: number, message: string) { super(message); this.name = 'SavedRequestError' }
}
/** Decode at most 64KiB of view metadata and references, never client metric packets. */
export async function readSavedReportCommand(request: Request) {
  if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    throw new SavedRequestError(415, 'Send a JSON save request.')
  }
  const declared = request.headers.get('content-length')
  if (declared !== null && (!/^\d+$/.test(declared) || !Number.isSafeInteger(Number(declared)))) throw new SavedRequestError(400, 'Send a valid save request.')
  if (declared !== null && Number(declared) > 65_536) throw new SavedRequestError(413, 'The save request is too large.')
  if (!request.body) throw new SavedRequestError(400, 'Send a valid save request.')
  const reader = request.body.getReader()
  let complete = false
  try {
    return await withReportingDeadline(async signal => {
      const decoder = new TextDecoder('utf-8', { fatal: true })
      let bytes = 0, content = ''
      for (;;) {
        const { done, value } = await reader.read()
        signal.throwIfAborted()
        if (done) { complete = true; break }
        bytes += value.byteLength
        if (bytes > 65_536) throw new SavedRequestError(413, 'The save request is too large.')
        content += decoder.decode(value, { stream: true })
      }
      return SaveReportingReportInputSchema.parse(JSON.parse(content + decoder.decode()))
    }, 5_000, request.signal)
  } catch (error) {
    if (error instanceof SavedRequestError) throw error
    if (error instanceof ReportingDeadlineError) throw new SavedRequestError(408, 'The save request took too long.')
    throw new SavedRequestError(400, 'Send a valid save request with report references and a title.')
  } finally {
    if (complete) reader.releaseLock()
    else void reader.cancel('Save request ended.').catch(() => undefined)
  }
}
