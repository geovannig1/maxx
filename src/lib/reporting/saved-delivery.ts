import type { ReportingPacket } from './contracts'
import type { ValidatedPreparedReportingReply } from './prepared-contract'
import { invalidPreparedReport } from './prepared-validation'
import { SavedReceiptSchema, type SavedReportReceipt } from './saved-contract'
import { savedReportIdentity } from './saved-identity'

export interface ReportingEvidenceDelivery { packet: ReportingPacket; receipt: SavedReportReceipt | null }
export async function preparedEvidenceDelivery(reply: ValidatedPreparedReportingReply): Promise<ReportingEvidenceDelivery | null> {
  if (!reply.packet) return null
  let receipt: SavedReportReceipt | null = null
  if (reply.snapshot?.fingerprint) {
    // The fingerprint covers the stored bytes: a v2 packet as sent, a v1 packet as validated.
    const snapshot = { contract: 'maxx_reporting_snapshot', version: 1, scope: reply.scope, packet: reply.storedPacket ?? reply.packet,
      retrieval: { startedAt: reply.snapshot.retrievalStartedAt, completedAt: reply.snapshot.retrievalCompletedAt },
      sourceAsOf: reply.packet.result.asOf }
    if (await savedReportIdentity(snapshot) !== reply.snapshot.fingerprint) throw invalidPreparedReport()
    receipt = SavedReceiptSchema.parse({ ...reply.snapshot, scope: reply.scope, sourceAsOf: reply.packet.result.asOf })
  }
  return { packet: reply.scope.requestedRange.to === reply.scope.range.to ? reply.packet : { ...reply.packet,
    notes: [...reply.packet.notes, 'The requested end date included an open or future account day. Reporting ends yesterday in the account timezone.'] }, receipt }
}
