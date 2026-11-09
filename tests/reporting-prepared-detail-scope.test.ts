import { describe, expect, it } from 'vitest'
import { snapshotContext, snapshotPacket } from './fixtures/reporting-snapshot'
import { createReportingSnapshot, makeReportingSnapshotScope, validateReportingPacketScope } from '@/lib/reporting/snapshot-contract'
import type { ReportEntity } from '@/lib/reporting/contracts'

const scope = makeReportingSnapshotScope('meta', snapshotContext, { detailIds: ['selected-ad'] })
const observedUntil = '2026-09-05T17:00:40.000Z'
const ad: ReportEntity = {
  id: 'selected-ad', level: 'ad', name: 'Selected', campaignId: null, campaignName: null, adsetId: null, adsetName: null,
  status: 'UNKNOWN', configurationAsOf: null, audience: 'unknown', audienceLabel: 'Unavailable', creative: null, metrics: {},
}
function packet(entities: ReportEntity[], pending = false) {
  const value = snapshotPacket()
  value.result.data = { ...value.result.data!, entities, detailState: pending ? 'loading' : 'complete' }
  return value
}
describe('prepared selected-ad detail identity', () => {
  it('accepts selected existing ad details and does not invent an entity for an unobserved selected ID', () => {
    const selected = { ...ad, series: [], comparisonSeries: [], breakdowns: [] }
    expect(() => createReportingSnapshot(scope, packet([selected]), observedUntil)).not.toThrow()
    expect(() => createReportingSnapshot(scope, packet([]), observedUntil)).not.toThrow()
    expect(() => validateReportingPacketScope(packet([ad], true), scope, observedUntil)).not.toThrow()
  })
  it.each(['ad', 'adset', 'campaign'] as const)('rejects unrequested %s optional detail even when all outer scope fields match', level => {
    const wrong = { ...ad, id: 'unrequested', level, series: [], comparisonSeries: [], breakdowns: [] }
    expect(() => createReportingSnapshot(scope, packet([wrong]), observedUntil)).toThrow()
    expect(() => validateReportingPacketScope(packet([wrong], true), scope, observedUntil)).toThrow()
  })
  it.each(['series', 'comparisonSeries', 'breakdowns'] as const)('rejects a completed selected ad missing %s', field => {
    const selected: ReportEntity = { ...ad, series: [], comparisonSeries: [], breakdowns: [] }
    delete selected[field]
    expect(() => createReportingSnapshot(scope, packet([selected]), observedUntil)).toThrow()
  })
})
