import { describe, expect, it } from 'vitest'
import { buildCreativeGroups } from '@/lib/reporting/creative-groups'
import { appointmentResults, creativeAd, creativeData } from './fixtures/reporting-creative'

describe('creative group calculations from native inputs', () => {
  it('recomputes 1/10 plus 9/990 as 1 percent, never the 5.45 percent average of row CTRs', () => {
    const metric = buildCreativeGroups(creativeData()).groups[0].metrics.ctr
    expect(metric.current.value).toBe(1)
    expect(metric.previous.value).toBe(1)
    expect(metric.current.inputs.filter(input => input.role !== 'guard').map(input => [input.adId, input.metricKey, input.claim?.value]))
      .toEqual([['301', 'clicks', 1], ['301', 'impressions', 10], ['302', 'clicks', 9], ['302', 'impressions', 990]])
    expect(metric).not.toHaveProperty('claimId')
  })
  it('preserves explicit native zero but withholds missing or partial fields for the full selected cohort', () => {
    const zero = buildCreativeGroups(creativeData([creativeAd('301', { spend: '0', clicks: '0', impressions: '10' })])).groups[0]
    expect(zero.metrics.spend.current.value).toBe(0)
    expect(zero.metrics.ctr.current.value).toBe(0)
    const missing = buildCreativeGroups(creativeData([creativeAd('301', { spend: '10' }), creativeAd('302', {})])).groups[0].metrics.spend
    expect(missing.current.value).toBeNull()
    expect(missing.current.unavailableReason).toBe('missing_input')
    expect(missing.current.inputs).toHaveLength(2)
    const partial = structuredClone(creativeData())
    partial.meta.data!.entities[0].metrics.spend.current.coverage = { state: 'partial', numerator: 1, denominator: 2 }
    partial.meta.data!.entities[0].metrics = { spend: partial.meta.data!.entities[0].metrics.spend }
    const checked = buildCreativeGroups(partial).groups[0].metrics.spend.current
    expect(checked.value).toBeNull()
    expect(checked.coverage).toBe('partial')
    expect(checked.inputs[0].claim?.value).toBe(10)
  })
  it('keeps zero aggregate denominators unavailable and permits zero-denominator members with a positive combined denominator', () => {
    expect(buildCreativeGroups(creativeData([creativeAd('301', { clicks: '0', impressions: '0' })])).groups[0].metrics.ctr.current.unavailableReason).toBe('zero_denominator')
    const mixed = buildCreativeGroups(creativeData([creativeAd('301', { clicks: '0', impressions: '0' }), creativeAd('302', { clicks: '1', impressions: '100' })])).groups[0]
    expect(mixed.metrics.ctr.current.value).toBe(1)
  })
  it('withholds multi-ad reach, frequency and average watch time while preserving a single native population', () => {
    const raw = { reach: '10', frequency: '1.5', video_avg_time_watched_actions: [{ action_type: 'video_view', value: '4' }] }
    const multi = buildCreativeGroups(creativeData([creativeAd('301', raw), creativeAd('302', raw)])).groups[0]
    for (const key of ['reach', 'frequency', 'average_watch_seconds']) expect(multi.metrics[key].current).toMatchObject({ value: null, unavailableReason: 'native_combined_population_required' })
    const single = buildCreativeGroups(creativeData([creativeAd('301', raw)])).groups[0]
    expect(single.metrics.reach.current.value).toBe(10)
    expect(single.metrics.frequency.current.value).toBe(1.5)
    expect(single.metrics.average_watch_seconds.current.value).toBe(4)
  })
  it('keeps AppointmentConfirmed and Purchase separate without allocating account or parent outcomes', () => {
    const a = creativeAd('301', { spend: '10', results: appointmentResults(1), actions: [{ action_type: 'purchase', value: '2' }, { action_type: 'omni_purchase', value: '2' }] })
    const b = creativeAd('302', { spend: '20', results: appointmentResults(3), actions: [{ action_type: 'purchase', value: '4' }] })
    const group = buildCreativeGroups(creativeData([a, b])).groups[0]
    expect(group.metrics.bookings.current.value).toBe(4)
    expect(group.metrics.purchase_count.current.value).toBe(6)
    expect(group.metrics.bookings.event).toBe('AppointmentConfirmed')
    expect(group.metrics.purchase_count.event).toBe('Purchase')
    expect(group.metrics.cost_per_booking.current.value).toBe(7.5)
  })
  it('rejects incompatible event, unit, source semantics and definition even when numeric inputs exist', () => {
    for (const alter of ['event', 'unit', 'window', 'source', 'formula', 'clock'] as const) {
      const source = structuredClone(creativeData([creativeAd('301', { results: appointmentResults(1) }), creativeAd('302', { results: appointmentResults(2) })]))
      const metric = source.meta.data!.entities[1].metrics.bookings
      if (alter === 'event') metric.event = 'Purchase'
      if (alter === 'unit') metric.current.unit = 'money'
      if (alter === 'window') metric.current.window.start = '2026-09-01'
      if (alter === 'clock') metric.current.asOf = '2026-09-05T16:00:00Z'
      if (alter === 'source') metric.current.attributionScope = 'none'
      if (alter === 'formula') { metric.definition = 'Different outcome meaning'; metric.current.formula = metric.definition; metric.previous!.formula = metric.definition }
      const result = buildCreativeGroups(source)
      expect(result.state === 'invalid' || result.groups[0].metrics.bookings.current.value === null).toBe(true)
    }
  })
  it('does not reconstruct an explicitly withheld native efficiency claim from otherwise available inputs', () => {
    const source = creativeData([creativeAd('301', { spend: '10', results: appointmentResults(2) })])
    const metric = source.meta.data!.entities[0].metrics.cost_per_booking
    metric.current = { ...metric.current, value: null, availability: { state: 'unavailable', blockerCodes: ['meta_outcome_hierarchy_unreconciled'] }, coverage: { state: 'unknown', numerator: null, denominator: null } }
    expect(buildCreativeGroups(source).groups[0].metrics.cost_per_booking.current).toMatchObject({ value: null, unavailableReason: 'source_ratio_withheld' })
  })
  it('withholds unsafe combined count arithmetic even when individual native counts are exact', () => {
    const source = creativeData([creativeAd('301', { impressions: String(Number.MAX_SAFE_INTEGER), clicks: '1' }), creativeAd('302', { impressions: String(Number.MAX_SAFE_INTEGER), clicks: '1' })])
    const group = buildCreativeGroups(source).groups[0]
    expect(group.metrics.impressions.current).toMatchObject({ value: null, unavailableReason: 'unsafe_aggregate_value' })
    expect(group.metrics.ctr.current).toMatchObject({ value: null, unavailableReason: 'unsafe_aggregate_value' })
  })
  it('recomputes legitimate changed source values under the same claim IDs and retains complete exact evidence', () => {
    const oldSource = creativeData(), newSource = creativeData([creativeAd('301', { spend: '50', clicks: '2', impressions: '10' }), creativeAd('302', { spend: '90', clicks: '9', impressions: '990' })])
    const before = buildCreativeGroups(oldSource).groups[0], after = buildCreativeGroups(newSource).groups[0]
    expect(before.metrics.spend.current.inputs[0].claim?.claimId).toBe(after.metrics.spend.current.inputs[0].claim?.claimId)
    expect(before.metrics.spend.current.value).toBe(100)
    expect(after.metrics.spend.current.value).toBe(140)
    expect(after.metrics.ctr.current.value).toBeCloseTo(1.1)
    expect(after.metrics.spend.current.inputs[0].metric).toEqual(newSource.meta.data!.entities[0].metrics.spend)
    expect(after.metrics.spend.current.inputs[0].claim).toEqual(newSource.meta.data!.entities[0].metrics.spend.current)
  })
})
