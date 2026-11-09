import { z } from 'zod'
import { MetricClaimSchema } from '@/lib/cockpit/contracts'
import { compactJson, CompactJsonSchema, expandJson, type CompactShapeHint } from './compact-json'
import { ReportingContextSchema, ReportMetricSchema, type ReportingData, type ReportingPacket } from './contracts'

/**
 * Stored and transported report packets.
 *
 * Version 1 is the plain `ReportingPacket`. Version 2 (`packetVersion: 2`) stores the complete v1
 * packet as compact JSON (src/lib/reporting/compact-json.ts): each claim, each metric definition and
 * every repeated value is written once and referenced by position, so a 50-campaign, 90-day report
 * with ad sets and ads is ~16 MB instead of ~219 MB. Its top level repeats the small fields that
 * storage triggers read (section, context, result state, source time, notes and the Meta detail
 * state); expansion refuses a packet whose repeated fields differ from the packet they describe.
 *
 * Meaning is unchanged: `expandPacket` returns a value whose JSON is byte-identical to the v1 packet,
 * and every consumer validates that expansion with the same v1 validators. Stored v1 bytes are never
 * rewritten; `readStoredReportingPacket` reads either version.
 */
export const REPORTING_PACKET_VERSION = 2 as const
export const REPORTING_DATA_VERSION = 2 as const

/** Claim and metric metadata are identical across occurrences of one metric; store them once. */
export const REPORTING_COMPACT_HINTS: readonly CompactShapeHint[] = [
  { keys: Object.keys(MetricClaimSchema.shape), group: ['metricKey', 'label', 'unit', 'formula', 'definitionVersion', 'source',
    'attributionScope', 'asOf', 'availability', 'freshness', 'setupFingerprint', 'authority', 'measurementKind'] },
  { keys: Object.keys(ReportMetricSchema.shape), group: ['key', 'label', 'definition', 'event'] },
]

const sections = ['meta', 'business', 'website', 'measurement'] as const
const PacketIndexSchema = z.object({
  section: z.enum(sections), context: ReportingContextSchema, notes: z.array(z.string()),
  result: z.object({
    state: z.enum(['loading', 'available', 'partial', 'unavailable']),
    data: z.object({ detailState: z.enum(['loading', 'complete', 'unavailable']).optional() }).strict().nullable(),
    asOf: z.string().datetime({ offset: true }).nullable(), notes: z.array(z.string()),
  }).strict(),
}).strict()
export const CompactReportingPacketSchema = PacketIndexSchema.extend({
  packetVersion: z.literal(REPORTING_PACKET_VERSION), compact: CompactJsonSchema,
}).strict()
export type CompactReportingPacket = z.infer<typeof CompactReportingPacketSchema>
/** A packet as stored or transported: plain (v1) or compact (v2). */
export type StoredReportingPacket = ReportingPacket | CompactReportingPacket
export const CompactReportingDataSchema = z.object({ dataVersion: z.literal(REPORTING_DATA_VERSION), compact: CompactJsonSchema }).strict()
export type CompactReportingData = z.infer<typeof CompactReportingDataSchema>

type IndexSource = { section?: unknown; context?: unknown; notes?: unknown
  result?: { state?: unknown; data?: object | null; asOf?: unknown; notes?: unknown } }

/** The top-level fields of a v2 packet, derived from the packet itself. */
function packetIndex(packet: IndexSource): z.infer<typeof PacketIndexSchema> {
  const data = packet.result?.data
  const detailState = data && 'detailState' in data ? data.detailState : undefined
  return PacketIndexSchema.parse({ section: packet.section, context: packet.context, notes: packet.notes, result: {
    state: packet.result?.state, asOf: packet.result?.asOf, notes: packet.result?.notes,
    data: data === null ? null : detailState === undefined ? {} : { detailState },
  } })
}

export function compactReportingPacket(packet: ReportingPacket): CompactReportingPacket {
  const index = packetIndex(packet)
  return { packetVersion: REPORTING_PACKET_VERSION, section: index.section, context: index.context, notes: index.notes,
    result: index.result, compact: compactJson(packet, REPORTING_COMPACT_HINTS) }
}

/** The v1 packet a v2 packet stores, unvalidated: callers validate it exactly as a v1 packet. */
export function expandPacket(raw: unknown): unknown {
  const stored = CompactReportingPacketSchema.parse(raw)
  const packet = expandJson(stored.compact)
  if (packet === null || typeof packet !== 'object' || Array.isArray(packet)) throw new Error('Invalid compact packet.')
  const index = { section: stored.section, context: stored.context, notes: stored.notes, result: stored.result }
  let actual: string
  try { actual = JSON.stringify(packetIndex(packet as IndexSource)) } catch { throw new Error('Invalid compact packet index.') }
  if (actual !== JSON.stringify(PacketIndexSchema.parse(index))) throw new Error('The compact packet index does not match its packet.')
  return packet
}

export function isCompactReportingPacket(raw: unknown): boolean {
  return raw !== null && typeof raw === 'object' && 'packetVersion' in raw
}

/** Dispatches on the stored version: v1 is returned unchanged, v2 is expanded. Both still need validation. */
export function readStoredReportingPacket(raw: unknown): unknown {
  return isCompactReportingPacket(raw) ? expandPacket(raw) : raw
}

export function compactReportingData(data: ReportingData): CompactReportingData {
  return { dataVersion: REPORTING_DATA_VERSION, compact: compactJson(data, REPORTING_COMPACT_HINTS) }
}

/** Assembled report data as transported: plain is returned unchanged, compact is expanded. Callers validate. */
export function expandReportingData(raw: unknown): unknown {
  if (raw === null || typeof raw !== 'object' || !('dataVersion' in raw)) return raw
  return expandJson(CompactReportingDataSchema.parse(raw).compact)
}
