import { z } from 'zod'
import { ReportingDeadlineError, withReportingDeadline } from './deadline'

const MAX_COMMAND_BYTES = 1_024
const CommandSchema = z.object({ refresh: z.boolean() }).strict()
export class PreparedRequestError extends Error {
  constructor(readonly status: number, message: string) { super(message); this.name = 'PreparedRequestError' }
}

/** Bound both bytes and elapsed time before resolving account data or claiming work. */
export async function readPreparedRefreshCommand(request: Request): Promise<{ refresh: boolean }> {
  if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    throw new PreparedRequestError(415, 'Send a JSON reporting refresh request.')
  }
  const declared = request.headers.get('content-length')
  if (declared !== null && (!/^\d+$/.test(declared) || !Number.isSafeInteger(Number(declared)))) {
    throw new PreparedRequestError(400, 'Send a valid reporting refresh request.')
  }
  if (declared !== null && Number(declared) > MAX_COMMAND_BYTES) {
    throw new PreparedRequestError(413, 'The reporting refresh request is too large.')
  }
  if (!request.body) throw new PreparedRequestError(400, 'Send a valid reporting refresh request.')
  const reader = request.body.getReader()
  let complete = false
  try {
    return await withReportingDeadline(async signal => {
      const decoder = new TextDecoder('utf-8', { fatal: true })
      let content = '', bytes = 0
      while (true) {
        const { done, value } = await reader.read()
        signal.throwIfAborted()
        if (done) { complete = true; break }
        bytes += value.byteLength
        if (bytes > MAX_COMMAND_BYTES) throw new PreparedRequestError(413, 'The reporting refresh request is too large.')
        content += decoder.decode(value, { stream: true })
      }
      return CommandSchema.parse(JSON.parse(content + decoder.decode()))
    }, 5_000, request.signal)
  } catch (error) {
    if (error instanceof PreparedRequestError) throw error
    if (error instanceof ReportingDeadlineError) throw new PreparedRequestError(408, 'The reporting refresh request took too long.')
    throw new PreparedRequestError(400, 'Send a valid reporting refresh request.')
  } finally {
    if (complete) reader.releaseLock()
    else void reader.cancel('Reporting refresh request ended.').catch(() => undefined)
  }
}
