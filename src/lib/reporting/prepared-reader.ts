import type { ReportingPacket, ReportingSectionName } from './contracts'
import { REPORTING_PREPARED_TYPE, type ValidatedPreparedReportingReply } from './prepared-contract'
import { invalidPreparedReport, validatePreparedReportingReply } from './prepared-validation'
import { ReportingRequestError } from './request-error'
import { checkReportingResponse } from './response-status'
import { MAX_REPORTING_STREAM_BYTES } from './stream-contract'
import { preparedEvidenceDelivery, type ReportingEvidenceDelivery } from './saved-delivery'

/** Count actual decoded transport bytes, including compressed HTTP responses.
 * The outer request deadline covers headers, every body and the polling delay. */
export async function readPreparedBody(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!response.body) throw invalidPreparedReport()
  const reader = response.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true })
  const cancel = () => { void reader.cancel().catch(() => {}) }
  signal.addEventListener('abort', cancel, { once: true })
  let exhausted = false, bytes = 0, content = ''
  try {
    for (;;) {
      signal.throwIfAborted()
      const { value, done } = await reader.read()
      signal.throwIfAborted()
      if (done) { exhausted = true; break }
      bytes += value.byteLength
      if (bytes > MAX_REPORTING_STREAM_BYTES) throw invalidPreparedReport()
      content += decoder.decode(value, { stream: true })
    }
    return JSON.parse(content + decoder.decode())
  } catch (error) {
    if (signal.aborted) throw error
    throw invalidPreparedReport()
  } finally {
    signal.removeEventListener('abort', cancel)
    if (!exhausted) cancel()
    reader.releaseLock()
  }
}
function pollDelay(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const stop = () => { clearTimeout(timer); signal.removeEventListener('abort', stop); reject(signal.reason) }
    const timer = setTimeout(() => { signal.removeEventListener('abort', stop); resolve() }, 1_000)
    signal.addEventListener('abort', stop, { once: true })
    if (signal.aborted) stop()
  })
}
export async function readPreparedReporting(
  initial: Response, section: ReportingSectionName, key: string, signal: AbortSignal, refresh: boolean,
  onProgress?: (packet: ReportingPacket) => void,
  onEvidence?: (delivery: ReportingEvidenceDelivery) => void,
): Promise<ReportingPacket> {
  const read = async (response: Response, prior?: ValidatedPreparedReportingReply) => {
    checkReportingResponse(response)
    if (response.headers.get('content-type')?.split(';')[0].trim() !== REPORTING_PREPARED_TYPE) throw invalidPreparedReport()
    return validatePreparedReportingReply(await readPreparedBody(response, signal), section, key, prior)
  }
  let displayed: ReportingPacket | null = null
  const receive = async (value: ValidatedPreparedReportingReply) => {
    const delivery = await preparedEvidenceDelivery(value)
    signal.throwIfAborted()
    if (delivery) { displayed = delivery.packet; onEvidence?.(delivery); onProgress?.(delivery.packet) }
  }
  const endpoint = `/api/reporting?${key}&section=${section}`
  let reply = await read(initial)
  await receive(reply)
  if (reply.job?.status !== 'running' && (refresh || reply.needsRefresh)) {
    reply = await read(await fetch(endpoint, { method: 'POST', cache: 'no-store', signal,
      headers: { Accept: REPORTING_PREPARED_TYPE, 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh }),
    }), reply)
    await receive(reply)
  }
  while (reply.job?.status === 'running') {
    await pollDelay(signal)
    reply = await read(await fetch(`${endpoint}&job=${encodeURIComponent(reply.job.id)}`, {
      cache: 'no-store', signal, headers: { Accept: REPORTING_PREPARED_TYPE },
    }), reply)
    await receive(reply)
  }
  if (reply.job?.status === 'failed') throw new ReportingRequestError(reply.job.failureCode === 'interrupted'
    ? 'This report refresh was interrupted. Retry this source; previous results remain available.'
    : 'This source could not refresh. Previous results remain available; retry this source.', 'transient')
  const packet = displayed
  if (!packet || (!reply.job && reply.needsRefresh)) throw invalidPreparedReport()
  return packet
}
