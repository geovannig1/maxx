import { createHash } from 'node:crypto'
import { z } from 'zod'
import { ReportingPacketSchema, type ReportingPacket } from './contracts'
import { ReportingSnapshotScopeSchema, type ReportingSnapshotScope } from './snapshot-scope'
export { ReportingSnapshotScopeSchema, makeReportingSnapshotScope, type ReportingSnapshotScope } from './snapshot-scope'
import { validateScopedReportingPacket } from './packet-scope'
import { hasPendingBusinessIntelligence } from './business-progress'
import { compactReportingPacket, readStoredReportingPacket, type CompactReportingPacket } from './packet-format'

const timestamp = z.string().datetime({ offset: true })
const SnapshotSchema = z.object({
  contract: z.literal('maxx_reporting_snapshot'), version: z.literal(1),
  scope: ReportingSnapshotScopeSchema, packet: ReportingPacketSchema,
  retrieval: z.object({ startedAt: timestamp, completedAt: timestamp }).strict(),
  sourceAsOf: timestamp.nullable(),
}).strict()
export type ReportingSnapshot = z.infer<typeof SnapshotSchema>
/** The document written to storage: the snapshot with its packet in the compact v2 format. */
export type StoredReportingSnapshotDocument = Omit<ReportingSnapshot, 'packet'> & { packet: CompactReportingPacket }

export class ReportingSnapshotError extends Error {
  constructor(readonly kind: 'invalid' | 'unavailable') {
    super(kind === 'invalid' ? 'Stored reporting evidence could not be validated.' : 'Reporting storage is temporarily unavailable.')
    this.name = 'ReportingSnapshotError'
  }
}

export function canonicalReportingJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalReportingJson).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    return `{${Object.entries(value).filter(([, entry]) => entry !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalReportingJson(entry)}`).join(',')}}`
  }
  throw new ReportingSnapshotError('invalid')
}

export function reportingFingerprint(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalReportingJson(value), 'utf8').digest('hex')}`
}

export function validateReportingPacketScope(
  raw: unknown, expectedScope: ReportingSnapshotScope, observedUntil: string,
): ReportingPacket {
  try { return validateScopedReportingPacket(raw, expectedScope, observedUntil) }
  catch { throw new ReportingSnapshotError('invalid') }
}

/** Accepts a stored snapshot whose packet is v1 or v2; returns the validated v1 snapshot. */
export function validateReportingSnapshot(raw: unknown, expectedScope: ReportingSnapshotScope): ReportingSnapshot {
  try {
    const record = raw !== null && typeof raw === 'object' && 'packet' in raw ? raw as { packet: unknown } : null
    const snapshot = SnapshotSchema.parse(record ? { ...record, packet: readStoredReportingPacket(record.packet) } : raw)
    const expected = ReportingSnapshotScopeSchema.parse(expectedScope)
    const packet = validateReportingPacketScope(snapshot.packet, expected, snapshot.retrieval.completedAt)
    if (canonicalReportingJson(snapshot.scope) !== canonicalReportingJson(expected)
      || (packet.section === 'meta' && ![undefined, 'complete'].includes(packet.result.data?.detailState))
      || (packet.section === 'business' && hasPendingBusinessIntelligence(packet.result.data))
      || snapshot.retrieval.startedAt !== packet.context.asOf || snapshot.sourceAsOf !== packet.result.asOf) {
      throw new ReportingSnapshotError('invalid')
    }
    return { ...snapshot, packet }
  } catch { throw new ReportingSnapshotError('invalid') }
}

export function createReportingSnapshot(
  scope: ReportingSnapshotScope, packet: ReportingPacket, completedAt: string,
): ReportingSnapshot {
  return validateReportingSnapshot({
    contract: 'maxx_reporting_snapshot', version: 1, scope, packet,
    retrieval: { startedAt: packet.context.asOf, completedAt }, sourceAsOf: packet.result.asOf,
  }, scope)
}

/** New writes store the packet as v2. Callers validate the snapshot first; its meaning is unchanged. */
export function storedReportingSnapshot(snapshot: ReportingSnapshot): StoredReportingSnapshotDocument {
  return { ...snapshot, packet: compactReportingPacket(snapshot.packet) }
}
