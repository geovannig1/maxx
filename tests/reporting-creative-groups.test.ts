import { describe, expect, it, vi } from 'vitest'
import * as assignment from '@/lib/reporting/creative-assignment-contract'
import { buildCreativeGroups } from '@/lib/reporting/creative-groups'
import { creativeAd, creativeContext, creativeData, creativeHistory, emptyCreativeSection } from './fixtures/reporting-creative'

describe('historical creative-object groups', () => {
  it('groups unique executions by resolved creative ID and records returned and filtered populations', () => {
    const result = buildCreativeGroups(creativeData())
    expect(result.state).toBe('ready')
    expect(result.groups).toHaveLength(1)
    expect(result.groups[0]).toMatchObject({ accountId: creativeContext.account.id, metaCreativeId: '401',
      comparison: { state: 'available' } })
    expect(result.groups[0].id).toContain(creativeContext.account.id)
    expect(result.groups[0].members.map(member => member.adId)).toEqual(['301', '302'])
    expect(result.population).toMatchObject({ returnedAdCount: 2, selectedAdCount: 2, assignedAdCount: 2, unassignedAdCount: 0, filtered: false })
    const filtered = buildCreativeGroups(creativeData(), ['302'])
    expect(filtered.population).toMatchObject({ returnedAdCount: 2, selectedAdCount: 1, assignedAdCount: 1, filtered: true })
    expect(filtered.groups[0].members.map(member => member.adId)).toEqual(['302'])
    expect(filtered.limitations.join(' ')).toMatch(/returned|filtered/i)
  })
  it('does not group equal names, URLs or media IDs across distinct creative objects', () => {
    const a = creativeAd('301', { spend: '10' }, undefined, '401')
    const b = { ...creativeAd('302', { spend: '20' }, undefined, '402'), name: a.name }
    const result = buildCreativeGroups(creativeData([a, b]))
    expect(result.groups.map(group => group.metaCreativeId)).toEqual(['401', '402'])
  })
  it('retains old packets as individually inspectable unassigned executions', () => {
    const source = creativeData(undefined, null)
    const result = buildCreativeGroups(source)
    expect(result.state).toBe('ready')
    expect(result.groups).toEqual([])
    expect(result.unassigned.map(ad => ad.reason)).toEqual(['assignment_history_missing', 'assignment_history_missing'])
    expect(result.unassigned[0].entity.metrics.spend).toEqual(source.meta.data!.entities[0].metrics.spend)
  })
  it('withholds changed or ambiguous assignments rather than using current configuration', () => {
    const ads = [creativeAd('301', { spend: '10' })], history = creativeHistory(ads)
    for (const change of [{ metaCreativeId: '402' }, { metaCreativeId: null }, { metaUpdatedTime: null }]) {
      const result = buildCreativeGroups(creativeData(ads, { ...history, observations: [history.observations[0], { ...history.observations[1], ...change }] }))
      expect(result.groups).toEqual([])
      expect(result.unassigned).toHaveLength(1)
      expect(result.unassigned[0].assignments.current.state).toBe('blocked')
    }
  })
  it('withholds the complete prior comparison when even one current member has unproven prior assignment', () => {
    const source = creativeData(), history = source.meta.data!.creativeAssignmentEvidence!
    const observations = history.observations.map(row => row.metaAdId === '302' && row.observedAt.startsWith('2026-08-30')
      ? { ...row, observedAt: '2026-09-02T03:59:59Z' } : row)
    const result = buildCreativeGroups(creativeData(source.meta.data!.entities, { ...history, observations }))
    expect(result.groups[0].members).toHaveLength(2)
    expect(result.groups[0].comparison).toMatchObject({ state: 'unavailable', reason: 'prior_membership_unproven' })
    expect(result.groups[0].metrics.spend.current.value).toBe(100)
    expect(result.groups[0].metrics.spend.previous.value).toBeNull()
    expect(result.groups[0].metrics.spend.previous.inputs.map(input => input.adId)).toEqual(['301', '302'])
  })
  it('keeps the historical group and current preview ID distinct', () => {
    const ad = creativeAd('301', { spend: '10' }, undefined, '402')
    const history = { ...creativeHistory([ad]), observations: creativeHistory([ad]).observations.map(row => ({ ...row, metaCreativeId: '401' })) }
    const result = buildCreativeGroups(creativeData([ad], history))
    expect(result.groups[0].metaCreativeId).toBe('401')
    expect(result.groups[0].members[0].currentCreativeId).toBe('402')
    expect(result.groups[0].preview).toMatchObject({ state: 'unavailable', creative: null })
    expect(result.groups[0].metrics.spend.current.value).toBe(10)
  })
  it('binds retained Meta history and metrics to its original clock in a newer mixed-source view', () => {
    const source = creativeData()
    const result = buildCreativeGroups({ ...source, context: { ...source.context, asOf: '2026-09-05T18:00:00Z' } })
    expect(result.state).toBe('ready')
    expect(result.context?.asOf).toBe(creativeContext.asOf)
    expect(result.groups[0].metrics.spend.current.inputs[0].claim?.asOf).toBe(creativeContext.asOf)
    const bad = buildCreativeGroups({ ...source, meta: { ...source.meta, asOf: '2026-09-05T18:00:00Z' } })
    expect(bad.state).toBe('invalid')
    expect(bad.groups).toEqual([])
    expect(bad.population.returnedAdCount).toBeNull()
  })
  it('rejects duplicate ad rows and invalid native lineage without partially rescuing a group', () => {
    const source = creativeData()
    const duplicate = creativeData([...source.meta.data!.entities, source.meta.data!.entities[0]], source.meta.data!.creativeAssignmentEvidence!)
    expect(buildCreativeGroups(duplicate).state).toBe('invalid')
    const wrong = structuredClone(source)
    wrong.meta.data!.entities[0].metrics.spend.current.entity.level = 'adset'
    expect(buildCreativeGroups(wrong).state).toBe('invalid')
    const conflict = structuredClone(source)
    conflict.meta.data!.entities[1].metrics.spend.current.claimId = conflict.meta.data!.entities[0].metrics.spend.current.claimId
    expect(buildCreativeGroups(conflict).state).toBe('invalid')
  })
  it('never folds parent totals into ad groups and rejects unknown or duplicate selected IDs', () => {
    const source = creativeData()
    const parent = { ...creativeAd('201', { spend: '999' }), level: 'adset' as const, creative: null, metrics: {} }
    const result = buildCreativeGroups(creativeData([...source.meta.data!.entities, parent], source.meta.data!.creativeAssignmentEvidence!))
    expect(result.groups[0].metrics.spend.current.value).toBe(100)
    expect(result.population.returnedAdCount).toBe(2)
    for (const selection of [['999'], ['301', '301'], ['201']]) expect(buildCreativeGroups(source, selection).state).toBe('invalid')
  })
  it('distinguishes unavailable and invalid populations from a valid empty selection', () => {
    const source = creativeData()
    const unavailable = buildCreativeGroups({ ...source, meta: emptyCreativeSection })
    expect(unavailable.state).toBe('unavailable')
    expect(unavailable.population).toMatchObject({ returnedAdCount: null, selectedAdCount: null, assignedAdCount: null, unassignedAdCount: null, unmatchedAdIds: null })
    const empty = buildCreativeGroups(source, [])
    expect(empty.state).toBe('ready')
    expect(empty.population).toMatchObject({ returnedAdCount: 2, selectedAdCount: 0, assignedAdCount: 0, unassignedAdCount: 0 })
  })
  it('constructs one assignment resolver per report and preserves both native resolutions', () => {
    const source = creativeData()
    const spy = vi.spyOn(assignment, 'createReportCreativeAssignmentResolver')
    const result = buildCreativeGroups(source)
    expect(spy).toHaveBeenCalledOnce()
    spy.mockRestore()
    const resolve = assignment.createReportCreativeAssignmentResolver(creativeContext, source.meta.data!.creativeAssignmentEvidence)
    for (const member of result.groups[0].members) for (const period of ['current', 'previous'] as const) {
      expect(member.assignments[period]).toEqual(resolve(member.adId, period))
    }
  })
})
