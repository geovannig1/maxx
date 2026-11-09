import { z } from 'zod'
import { ReportingPacketSchema } from './contracts'
import { hasPendingBusinessIntelligence } from './business-progress'

export const REPORTING_STREAM_TYPE = 'application/x-ndjson'
// Bounds client memory for the two packet frames, including decompressed bytes.
export const MAX_REPORTING_STREAM_BYTES = 64 * 1024 * 1024
export const ReportingFrameSchema = z.object({
  kind: z.enum(['partial', 'complete']), packet: ReportingPacketSchema,
}).strict().superRefine((frame, check) => {
  const detailState = frame.packet.section === 'meta' ? frame.packet.result.data?.detailState : undefined
  const pending = detailState === 'loading' || frame.packet.section === 'business' && hasPendingBusinessIntelligence(frame.packet.result.data)
  if (frame.kind === 'partial' && (frame.packet.result.state !== 'partial' || !pending)) {
    check.addIssue({ code: 'custom', message: 'Progress must contain a partial supported report with pending details.' })
  }
  if (frame.kind === 'complete' && (pending || frame.packet.result.state === 'loading')) {
    check.addIssue({ code: 'custom', message: 'The completed report must not claim pending work.' })
  }
})
