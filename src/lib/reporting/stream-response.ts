import type { ReportingHistoryEntity } from './snapshot-scope'
import type { ReportingContext, ReportingPacket } from './contracts'
import { ReportingPacketSchema } from './contracts'
import { loadReportingSection } from './loader'
import { REPORTING_STREAM_TYPE, ReportingFrameSchema } from './stream-contract'
import { compactReportingPacket } from './packet-format'

export function acceptsReportingStream(accept: string | null): boolean {
  return Boolean(accept?.split(',').some(value => {
    const [type, ...parameters] = value.trim().split(';')
    const quality = parameters.find(parameter => parameter.trim().startsWith('q='))
    return type.trim() === REPORTING_STREAM_TYPE && (quality === undefined || Number(quality.trim().slice(2)) > 0)
  }))
}

/** Authentication, ownership and scope resolution must precede this response.
 * A disconnect releases this observer; the loader may still serve another one. */
export function streamReportingReport(
  section: 'meta' | 'business', context: ReportingContext, refresh: boolean, detailIds: string[],
  signal: AbortSignal, notes: string[], historyEntity?: ReportingHistoryEntity,
): Response {
  const observer = new AbortController()
  const encoder = new TextEncoder()
  let closed = false
  let finish = () => {}
  const abort = () => { observer.abort(); finish() }
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      finish = () => {
        signal.removeEventListener('abort', abort)
        if (!closed) { closed = true; controller.close() }
      }
      const emit = (kind: 'partial' | 'complete', packet: ReportingPacket) => {
        if (closed || observer.signal.aborted) return
        if (packet.section !== section) throw new Error('Reporting stream source mismatch')
        const frame = ReportingFrameSchema.parse({ kind, packet: { ...packet, notes: [...packet.notes, ...notes] } })
        // Validated as v1, sent as v2 (src/lib/reporting/packet-format.ts).
        controller.enqueue(encoder.encode(`${JSON.stringify({ kind: frame.kind, packet: compactReportingPacket(frame.packet) })}\n`))
      }
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) { abort(); return }
      void loadReportingSection(section, context, refresh, detailIds, packet => emit('partial', packet), observer.signal, ...(historyEntity ? [{ historyEntity }] : []))
        .then(packet => emit('complete', packet))
        .catch(() => {
          emit('complete', ReportingPacketSchema.parse({ section, context, notes: [],
            result: { state: 'unavailable', data: null, asOf: null, notes: ['This reporting source could not finish. Retry this source.'] } }))
        }).finally(finish)
    },
    cancel() { closed = true; observer.abort(); signal.removeEventListener('abort', abort) },
  })
  return new Response(stream, { headers: {
    'Content-Type': `${REPORTING_STREAM_TYPE}; charset=utf-8`,
    'Cache-Control': 'private, no-store, no-transform', Vary: 'Cookie, Accept, Accept-Encoding',
    'X-Content-Type-Options': 'nosniff', 'X-Accel-Buffering': 'no',
  } })
}

/** Compatibility wrapper for existing Meta-only callers. */
export function streamMetaReport(context: ReportingContext, refresh: boolean, detailIds: string[], signal: AbortSignal, notes: string[]): Response {
  return streamReportingReport('meta', context, refresh, detailIds, signal, notes)
}
