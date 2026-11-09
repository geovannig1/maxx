import { describe, expect, it } from 'vitest'
import { buildCreativeGroups } from '@/lib/reporting/creative-groups'
import { buildCreativeGroupCsv, creativeGroupExportRows } from '@/lib/reporting/creative-group-export'
import { creativeAd, creativeContext, creativeData, emptyCreativeSection } from './fixtures/reporting-creative'

describe('creative group CSV evidence', () => {
  it('exports recomputed rates, complete native inputs, historical assignments and explicit filtered population', () => {
    const source = creativeData(), grouped = buildCreativeGroups(source, ['301', '302'])
    const rows = creativeGroupExportRows(grouped, source.context, ['ctr'])
    expect(rows.find(row => row.record_type === 'population')).toMatchObject({ population_state: 'known', returned_ad_count: 2, selected_ad_count: 2, assigned_ad_count: 2, unassigned_ad_count: 0, filtered: 'true', requested_ad_ids: '["301","302"]' })
    expect(rows.find(row => row.record_type === 'calculation' && row.period === 'current')).toMatchObject({ value: 1, calculation: 'ratio_of_sums', source_as_of: source.meta.asOf, availability: 'available' })
    const native = rows.find(row => row.record_type === 'input' && row.period === 'current' && row.ad_id === '301' && row.metric_key === 'clicks')!
    expect(JSON.parse(native.metric_json!)).toEqual(source.meta.data!.entities[0].metrics.clicks)
    expect(JSON.parse(native.claim_json!)).toEqual(source.meta.data!.entities[0].metrics.clicks.current)
    expect(native).toMatchObject({ from: '2026-09-02', to: '2026-09-04', date_basis: 'impression_date_et', timezone: 'America/New_York', source: 'meta', ad_name: 'Ad 301' })
    expect(rows.filter(row => row.record_type === 'membership')).toHaveLength(2)
    expect(JSON.parse(rows.find(row => row.record_type === 'assignment_evidence')!.evidence_json!)).toEqual(source.meta.data!.creativeAssignmentEvidence)
    expect(rows.some(row => row.record_type === 'calculation' && row.claim_json)).toBe(false)
  })
  it('retains missing-input rows and withheld results instead of exporting a complete-looking subset', () => {
    const source = creativeData([creativeAd('301', { spend: '0' }), creativeAd('302', {})])
    source.meta.data!.entities[1].metrics = {}
    const rows = creativeGroupExportRows(buildCreativeGroups(source), source.context, ['spend', 'reach'])
    expect(rows.find(row => row.record_type === 'calculation' && row.metric_key === 'spend' && row.period === 'current')).toMatchObject({ value: null, reason: 'missing_input', availability: 'unavailable' })
    expect(rows.find(row => row.record_type === 'input' && row.metric_key === 'spend' && row.ad_id === '302' && row.period === 'current')).toMatchObject({ value: null, reason: 'missing_input', metric_json: null, claim_json: null })
    expect(rows.find(row => row.record_type === 'input' && row.metric_key === 'spend' && row.ad_id === '301' && row.period === 'current')?.value).toBe(0)
    expect(rows.find(row => row.record_type === 'calculation' && row.metric_key === 'reach')?.reason).toBe('native_combined_population_required')
  })
  it('exports unassigned executions individually and distinguishes unknown population from a measured empty selection', () => {
    const source = creativeData(undefined, null)
    const rows = creativeGroupExportRows(buildCreativeGroups(source), source.context, ['spend'])
    expect(rows.filter(row => row.record_type === 'membership')).toHaveLength(2)
    expect(rows.filter(row => row.record_type === 'unassigned_input')).toHaveLength(4)
    expect(rows.find(row => row.record_type === 'membership')).toMatchObject({ group_id: null, reason: 'assignment_history_missing' })
    const unavailable = creativeGroupExportRows(buildCreativeGroups({ ...source, meta: emptyCreativeSection }), source.context, ['spend'])
    expect(unavailable[0]).toMatchObject({ population_state: 'unknown', returned_ad_count: null, selected_ad_count: null, unmatched_ad_ids: null, reason: 'meta_source_unavailable' })
    const empty = creativeGroupExportRows(buildCreativeGroups(source, []), source.context, ['spend'])
    expect(empty[0]).toMatchObject({ population_state: 'known', selected_ad_count: 0, assigned_ad_count: 0, requested_ad_ids: '[]' })
    expect(empty.some(row => row.record_type === 'calculation')).toBe(false)
  })
  it('rejects altered arithmetic and full evidence content even when claim IDs stay the same', () => {
    for (const field of ['value', 'claim', 'metric', 'member', 'population'] as const) {
      const grouped = structuredClone(buildCreativeGroups(creativeData()))
      if (field === 'value') grouped.groups[0].metrics.ctr.current.value = 5.45
      if (field === 'claim') grouped.groups[0].metrics.ctr.current.inputs[0].claim!.value = 999
      if (field === 'metric') grouped.groups[0].metrics.spend.current.inputs[0].metric!.definition = 'Changed native content'
      if (field === 'member') {
        const assignment = grouped.groups[0].members[0].assignments.current
        if (assignment.state === 'observed_stable') assignment.metaCreativeId = '999'
      }
      if (field === 'population') grouped.population.returnedAdCount = 900
      expect(() => buildCreativeGroupCsv(grouped, creativeContext, ['ctr', 'spend'])).toThrow(/evidence|materialized/i)
    }
  })
  it('accepts a legitimate changed packet under stable IDs but rejects foreign account/range export context', () => {
    const updated = creativeData([creativeAd('301', { spend: '30' })])
    expect(buildCreativeGroupCsv(buildCreativeGroups(updated), updated.context, ['spend'])).toContain(',30,')
    for (const context of [{ ...updated.context, account: { ...updated.context.account, id: 'foreign' } }, { ...updated.context, range: { from: '2026-09-01', to: '2026-09-04' } }]) {
      expect(() => buildCreativeGroupCsv(buildCreativeGroups(updated), context, ['spend'])).toThrow()
    }
    const mixed = { ...updated, context: { ...updated.context, asOf: '2026-09-05T19:00:00Z' } }
    expect(creativeGroupExportRows(buildCreativeGroups(mixed), mixed.context, ['spend'])[0].source_as_of).toBe(updated.meta.asOf)
  })
  it('neutralizes formula-shaped names and string IDs while preserving quoted native evidence', () => {
    const source = creativeData()
    source.meta.data!.entities[0].name = ' \t=HYPERLINK("bad")'
    source.meta.data!.entities[0].creative!.name = '\uFEFF+SUM(1,2)'
    source.context = { ...source.context, account: { ...source.context.account, name: '@account', metaAccountId: '-123' } }
    const csv = buildCreativeGroupCsv(buildCreativeGroups(source), source.context, ['ctr'])
    expect(csv).toContain('"\' \t=HYPERLINK(""bad"")"')
    expect(csv).toContain('"\'\uFEFF+SUM(1,2)"')
    expect(csv).toContain('"\'@account"')
    expect(csv).toContain('"\'-123"')
    expect(() => buildCreativeGroupCsv(buildCreativeGroups(source), source.context, ['unknown_metric'])).toThrow(/metric/i)
  })
})
