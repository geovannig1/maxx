import { describe, expect, it } from 'vitest'
import { buildBusinessReport } from '@/lib/reporting/business-metrics'
import { buildBusinessCustomers, buildBusinessLeadTime, buildBusinessUpcoming } from '@/lib/reporting/business-intelligence-metrics'
import { pendingBusinessIntelligence } from '@/lib/reporting/business-progress'
import { createReportingSnapshot, makeReportingSnapshotScope } from '@/lib/reporting/snapshot-contract'
import { validatePreparedReportingReply } from '@/lib/reporting/prepared-validation'
import { validateScopedReportingPacket } from '@/lib/reporting/packet-scope'
import type { PreparedReportingReply } from '@/lib/reporting/prepared-contract'
import type { ReportingPacket } from '@/lib/reporting/contracts'
import { snapshotContext as context } from './fixtures/reporting-snapshot'
import { preparedKey, preparedSnapshotId } from './fixtures/reporting-prepared'

const scope = makeReportingSnapshotScope('business', context)
const completedAt = '2026-09-05T17:00:40.000Z'
function businessPacket(pending = false): Extract<ReportingPacket, { section: 'business' }> {
  return { section: 'business', context, notes: [], result: { state: 'partial', asOf: context.asOf, notes: [], data: {
    ...buildBusinessReport(context, [], []), intelligence: pending ? pendingBusinessIntelligence() : {
      customers: buildBusinessCustomers(context, []), leadTime: buildBusinessLeadTime(context, []),
      upcoming: buildBusinessUpcoming(context, [], context.asOf),
    },
  } } }
}
function reply(packet: ReportingPacket): PreparedReportingReply {
  return { kind: 'prepared-report', version: 1, scope, packet, job: null, needsRefresh: false,
    snapshot: { id: preparedSnapshotId, retrievalStartedAt: context.asOf, retrievalCompletedAt: completedAt } }
}

describe('business publication boundaries', () => {
  it('accepts completed, honestly partial business coverage for publication', () => {
    const packet = businessPacket()
    expect(() => createReportingSnapshot(scope, packet, completedAt)).not.toThrow()
    expect(() => validatePreparedReportingReply(reply(packet), 'business', preparedKey)).not.toThrow()
  })
  it('allows pending core as progress but rejects a completed snapshot containing loading business details', () => {
    const packet = businessPacket(true)
    expect(() => validateScopedReportingPacket(packet, scope, completedAt)).not.toThrow()
    expect(() => createReportingSnapshot(scope, packet, completedAt)).toThrow()
  })
  it('rejects a prepared completed snapshot containing loading business details', () => {
    expect(() => validatePreparedReportingReply(reply(businessPacket(true)), 'business', preparedKey)).toThrow()
  })
  it('rejects a nested future observation made after publication even when no metric claims exist', () => {
    const packet = businessPacket()
    packet.result.data!.intelligence!.upcoming = { state: 'partial', asOf: '2026-09-05T17:02:00.000Z', notes: [],
      data: { range: { from: '2026-09-06', to: '2026-10-03' }, metrics: {}, days: [], types: [] } }
    expect(() => validateScopedReportingPacket(packet, scope, completedAt)).toThrow()
  })
})
