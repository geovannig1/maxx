import type { ReportingPacket } from './contracts'
import { ReportingRequestError } from './request-error'
import { MAX_REPORTING_STREAM_BYTES, ReportingFrameSchema } from './stream-contract'
import { readStoredReportingPacket } from './packet-format'

const invalid = () => new ReportingRequestError('This source returned an invalid report stream. Retry this source.', 'invalid')

/** Consume at most one initial packet and one terminal packet. EOF alone is not
 * success: the final frame proves optional work reached a terminal state. */
export async function readReportingStream(
  response: Response, signal: AbortSignal,
  validate: (packet: ReportingPacket) => ReportingPacket,
  onProgress?: (packet: ReportingPacket) => void,
): Promise<ReportingPacket> {
  if (!response.body) throw invalid()
  const reader = response.body.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const cancel = () => { void reader.cancel().catch(() => {}) }
  signal.addEventListener('abort', cancel, { once: true })
  let buffer = '', bytes = 0, progress = false, exhausted = false
  let complete: ReportingPacket | undefined
  let identity: string | undefined
  const consume = (line: string) => {
    if (complete) throw invalid()
    let frame
    try {
      // A v2 packet is expanded, then validated exactly as a v1 frame.
      const raw: unknown = JSON.parse(line)
      frame = ReportingFrameSchema.parse(raw !== null && typeof raw === 'object' && 'packet' in raw
        ? { ...raw, packet: readStoredReportingPacket(raw.packet) } : raw)
    } catch { throw invalid() }
    const packet = validate(frame.packet)
    // All frames are one retrieval generation. Do not combine a replacement
    // account/window/as-of with already exposed progress from another generation.
    const nextIdentity = JSON.stringify(packet.context)
    if (identity !== undefined && nextIdentity !== identity) throw invalid()
    identity = nextIdentity
    if (frame.kind === 'partial') {
      if (progress) throw invalid()
      progress = true
      onProgress?.(packet)
    } else complete = packet
  }
  try {
    for (;;) {
      signal.throwIfAborted()
      const { value, done } = await reader.read()
      signal.throwIfAborted()
      if (done) { exhausted = true; break }
      bytes += value.byteLength
      if (bytes > MAX_REPORTING_STREAM_BYTES) throw new ReportingRequestError('This report is too large to load. Choose a shorter reporting period.', 'invalid')
      try { buffer += decoder.decode(value, { stream: true }) } catch { throw invalid() }
      let newline: number
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        if (line.trim()) consume(line)
      }
    }
    try { buffer += decoder.decode() } catch { throw invalid() }
    if (buffer.trim()) throw new ReportingRequestError('The report stream ended before its packet finished. Retry this source.', 'transient')
    if (!complete) throw new ReportingRequestError('The report stream ended before all details arrived. Retry this source.', 'transient')
    return complete
  } finally {
    signal.removeEventListener('abort', cancel)
    if (!exhausted) cancel()
    reader.releaseLock()
  }
}
