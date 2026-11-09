import { describe, expect, it } from 'vitest'
import { MetaApiError } from '@/lib/platforms/meta/client'
import { readMetaInventory, resolveInventoryAudience } from '@/lib/platforms/meta/reporting/meta-inventory'
import type { MetaRow } from '@/lib/reporting/meta-metrics'
import { reportingFixture } from '../scripts/demo/sample/reports'
import { validateReportingPacket } from '@/lib/reporting/validation'

const context = reportingFixture().context
const adset = { id: 'set-7', name: 'Lower-spend audience', targeting: {
  custom_audiences: [{ id: 'healthy' }], excluded_custom_audiences: [{ id: 'failed' }],
  targeting_automation: { advantage_audience: 0 },
} }
const native: MetaRow[] = [
  { id: 'healthy', name: 'Website', subtype: 'WEBSITE', operation_status: { code: 200 }, delivery_status: { code: 200 },
    approximate_count_lower_bound: '20', approximate_count_upper_bound: '20', retention_days: '180' },
  { id: 'failed', name: 'Lookalike', subtype: 'LOOKALIKE', operation_status: { code: 433, description: 'Could not create lookalike' }, delivery_status: { code: 200, description: 'Ready for use' },
    approximate_count_lower_bound: -1, approximate_count_upper_bound: -1,
    lookalike_spec: { origin: [{ id: 'seed-a', name: 'First seed' }, { id: 'seed-b', name: 'Second seed' }] } },
]
async function inventory(rows = native) {
  return readMetaInventory(context, async path => path.endsWith('/customaudiences') ? rows : path.endsWith('/adsets') ? [adset] : [])
}
describe('audience evidence survives reporting projection', () => {
  it('keeps unhealthy exclusions beside the healthy inclusion with exact identities and both native statuses', async () => {
    const result = await inventory()
    const evidence = resolveInventoryAudience(context, adset, result.audiences, context.asOf).audienceEvidence
    expect(evidence).toMatchObject({ accountId: context.account.id, adsetId: 'set-7', observedAt: context.asOf, expansion: 'disabled', targetingAvailable: true })
    expect(evidence?.members).toMatchObject([
      { id: 'healthy', role: 'included', ownership: 'matched', operationCode: 200, deliveryCode: 200, lowerBound: 20, upperBound: 20, retentionDays: 180 },
      { id: 'failed', role: 'excluded', operationCode: 433, deliveryCode: 200, operationDescription: 'Could not create lookalike', deliveryDescription: 'Ready for use', lowerBound: null, upperBound: null,
        seeds: [{ id: 'seed-a', name: 'First seed' }, { id: 'seed-b', name: 'Second seed' }] },
    ])
    expect(JSON.stringify(evidence)).not.toContain('contributes no reachable')
  })
  it('degrades a rejected optional field while preserving the returned audience and other status', async () => {
    const result = await readMetaInventory(context, async (path, params) => {
      if (!path.endsWith('/customaudiences')) return []
      if (params.fields.split(',').includes('operation_status')) throw new MetaApiError({ code: 100, message: 'Nonexisting field operation_status' })
      return [{ ...native[0], operation_status: undefined }]
    })
    expect(result.audiences.healthy?.deliveryStatus).toEqual({ code: 200 })
    expect(result.audiences.healthy?.operationStatus).toBeUndefined()
    expect(result.audiences.healthy?.accountId).toBe(context.account.id)
  })
  it('does not expose foreign-account metadata or accept conflicting duplicate inventory IDs', async () => {
    const result = await inventory([{ ...native[0], account_id: 'wrong-account', name: 'Foreign private name' }, native[1], { ...native[1], operation_status: { code: 200 } }])
    const evidence = resolveInventoryAudience(context, adset, result.audiences, context.asOf).audienceEvidence
    expect(evidence?.members[0]).toMatchObject({ id: 'healthy', ownership: 'mismatch', operationCode: null, name: null })
    expect(evidence?.members[1]).toMatchObject({ id: 'failed', ownership: 'unconfirmed', operationCode: null })
    expect(JSON.stringify(evidence)).not.toContain('Foreign private name')
  })
  it('keeps the same ID separately in each role and discloses malformed references instead of claiming an empty broad audience', async () => {
    const result = await inventory()
    const evidence = resolveInventoryAudience(context, { ...adset, targeting: { custom_audiences: [{ id: 'healthy' }, { id: 'healthy' }, {}], excluded_custom_audiences: ['healthy'] } }, result.audiences, context.asOf).audienceEvidence
    expect(evidence?.members.map(member => [member.id, member.role])).toEqual([['healthy', 'included'], ['healthy', 'excluded']])
    expect(evidence?.unparsedReferences).toBe(1)
  })
  it.each(['wrong account', 'wrong ad set', 'future observation', 'duplicate role', 'foreign metadata'])('rejects %s at the packet boundary', async defect => {
    const data = reportingFixture(), result = await inventory()
    const entity = data.meta.data!.entities.find(item => item.level === 'adset')!
    entity.configurationAsOf = context.asOf
    entity.audienceEvidence = resolveInventoryAudience(context, { ...adset, id: entity.id }, result.audiences, context.asOf).audienceEvidence
    const packet = { context, section: 'meta', result: data.meta, notes: [] }
    expect(() => validateReportingPacket(packet)).not.toThrow()
    const evidence = entity.audienceEvidence!
    if (defect === 'wrong account') evidence.accountId = 'foreign'
    if (defect === 'wrong ad set') evidence.adsetId = 'not-this-set'
    if (defect === 'future observation') evidence.members[0].inventoryObservedAt = '2030-01-01T00:00:00Z'
    if (defect === 'duplicate role') evidence.members.push(evidence.members[0])
    if (defect === 'foreign metadata') evidence.members[0].ownership = 'mismatch'
    expect(() => validateReportingPacket(packet)).toThrow()
  })
  it.each(['not-a-date', '2030-01-01T00:00:00Z'])('never classifies invalid configuration time %s as cold/broad', time => {
    expect(resolveInventoryAudience(context, { id: 'set-7', targeting: {} }, {}, time).audience).toBe('unknown')
  })
  it('does not classify malformed references as a confirmed broad population', () => {
    expect(resolveInventoryAudience(context, { id: 'set-7', targeting: { custom_audiences: 'bad' } }, {}, context.asOf).audience).toBe('unknown')
  })
  it('accepts equivalent offset instants and rejects submillisecond future observations', async () => {
    const data = reportingFixture(), result = await inventory()
    const entity = data.meta.data!.entities.find(item => item.level === 'adset')!
    entity.configurationAsOf = context.asOf
    entity.audienceEvidence = resolveInventoryAudience(context, { ...adset, id: entity.id }, result.audiences, '2026-09-05T13:00:00-04:00').audienceEvidence
    const packet = { context, section: 'meta', result: data.meta, notes: [] }
    expect(() => validateReportingPacket(packet)).not.toThrow()
    entity.configurationAsOf = '2026-09-05T17:00:00.000000001Z'
    entity.audienceEvidence!.observedAt = entity.configurationAsOf
    expect(() => validateReportingPacket(packet)).toThrow()
  })
  it.each([{ origin: { id: 'seed-single', name: 'Explicit single seed' } }, { origin_audience_id: 'seed-single' }])('preserves an explicit single seed in an alternate supported shape', async lookalike_spec => {
    const result = await inventory([{ ...native[1], lookalike_spec }])
    const evidence = resolveInventoryAudience(context, adset, result.audiences, context.asOf).audienceEvidence
    expect(evidence?.members[1].seeds.map(seed => seed.id)).toEqual(['seed-single'])
  })
  it('does not round a future native metadata timestamp into an accepted observation', async () => {
    const result = await inventory([{ ...native[0], time_updated: '2026-09-05T17:00:00.000000001Z' },
      { ...native[1], time_updated: '2026-09-05T16:59:59.123456789Z' }])
    const evidence = resolveInventoryAudience(context, adset, result.audiences, context.asOf).audienceEvidence!
    expect(evidence.members[0].metaUpdatedAt).toBeNull()
    expect(evidence.members[1].metaUpdatedAt).toBe('2026-09-05T16:59:59.123456789Z')
  })
})
