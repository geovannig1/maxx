import { z } from 'zod'
import { ReportingPacketSchema, type ReportingPacket } from './contracts'
import { CompactReportingPacketSchema, type CompactReportingPacket } from './packet-format'
import { ReportingSnapshotScopeSchema } from './snapshot-scope'

export const REPORTING_PREPARED_TYPE = 'application/vnd.maxx.prepared-report+json'
const timestamp = z.string().datetime({ offset: true })
export const PreparedReportingReplySchema = z.object({
  kind: z.literal('prepared-report'), version: z.literal(1), scope: ReportingSnapshotScopeSchema,
  // A saved packet is sent exactly as stored (v1 or v2), so the browser can check its fingerprint.
  packet: z.union([CompactReportingPacketSchema, ReportingPacketSchema]).nullable(),
  snapshot: z.object({ id: z.string().uuid(), fingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/).optional(), retrievalStartedAt: timestamp, retrievalCompletedAt: timestamp }).strict().nullable(),
  job: z.object({
    id: z.string().uuid(), status: z.enum(['running', 'complete', 'failed']), startedAt: timestamp, leaseExpiresAt: timestamp,
    completedAt: timestamp.nullable(),
    failureCode: z.enum(['source_unavailable', 'invalid_report', 'storage_unavailable', 'interrupted']).nullable(),
    snapshotId: z.string().uuid().nullable(),
  }).strict().nullable(),
  needsRefresh: z.boolean(),
}).strict()
export type PreparedReportingReply = z.infer<typeof PreparedReportingReplySchema>
/** A reply after browser validation: `packet` is the validated v1 meaning, `storedPacket` the v2 bytes sent. */
export type ValidatedPreparedReportingReply = Omit<PreparedReportingReply, 'packet'> & {
  packet: ReportingPacket | null
  storedPacket?: CompactReportingPacket
}
