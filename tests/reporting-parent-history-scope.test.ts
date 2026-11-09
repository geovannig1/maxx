import { describe, expect, it } from 'vitest'
import { makeReportingSnapshotScope, ReportingSnapshotScopeSchema } from '@/lib/reporting/snapshot-scope'
import { reportingFingerprint } from '@/lib/reporting/snapshot-contract'
import { snapshotContext } from './fixtures/reporting-snapshot'

const legacy = () => makeReportingSnapshotScope('meta', snapshotContext)
const parent = { level: 'campaign', id: 'campaign-1' } as const

describe('selected parent history identity', () => {
  it('preserves legacy shape and binds both parent level and ID into snapshot identity', () => {
    expect(legacy()).not.toHaveProperty('historyEntity')
    const selected = makeReportingSnapshotScope('meta', snapshotContext, { historyEntity: parent })
    expect(selected).toEqual({ ...legacy(), historyEntity: parent })
    expect(reportingFingerprint(selected)).not.toBe(reportingFingerprint(legacy()))
    for (const historyEntity of [{ level: 'adset' as const, id: parent.id }, { ...parent, id: 'campaign-2' }]) {
      expect(reportingFingerprint(makeReportingSnapshotScope('meta', snapshotContext, { historyEntity })))
        .not.toBe(reportingFingerprint(selected))
    }
    expect(ReportingSnapshotScopeSchema.parse(JSON.parse(JSON.stringify(selected)))).toEqual(selected)
  })
  it.each(['placement', 'age', 'gender', 'region'] as const)('binds an on-demand %s breakdown into the selected-parent snapshot identity', breakdown => {
    const selected = ReportingSnapshotScopeSchema.parse({ ...legacy(), historyEntity: { ...parent, breakdown } })
    expect(selected.historyEntity).toEqual({ ...parent, breakdown })
    expect(reportingFingerprint(selected)).not.toBe(reportingFingerprint(
      makeReportingSnapshotScope('meta', snapshotContext, { historyEntity: parent }),
    ))
  })
  it.each([null, {}, { level: 'ad', id: 'ad-1' }, { level: 'campaign', id: '' },
    { level: 'campaign', id: 'space id' }, { level: 'adset', id: 'a'.repeat(161) },
    { ...parent, breakdown: 'device' }, { ...parent, breakdown: null }, { ...parent, extra: true }])('rejects malformed selector %j', historyEntity => {
    expect(ReportingSnapshotScopeSchema.safeParse({ ...legacy(), historyEntity }).success).toBe(false)
  })
  it('rejects mixed ad/parent and non-Meta scope while accepting explicit empty ad selection', () => {
    expect(() => makeReportingSnapshotScope('meta', snapshotContext, { historyEntity: parent, detailIds: ['ad-1'] })).toThrow()
    expect(() => makeReportingSnapshotScope('business', snapshotContext, { historyEntity: parent })).toThrow()
    expect(makeReportingSnapshotScope('meta', snapshotContext, { historyEntity: parent, detailIds: [] })).toHaveProperty('historyEntity', parent)
  })
})
