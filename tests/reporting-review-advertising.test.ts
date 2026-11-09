import { describe, expect, it } from 'vitest'
import { COMPLETE_FIELD_COVERAGE, makeReportMetric, UNKNOWN_FIELD_COVERAGE } from '@/lib/reporting/claims'
import type { ReportEntity, ReportMetric, ReportMetricMap, ReportingData } from '@/lib/reporting/contracts'
import type { ReviewFinding } from '@/lib/reporting/review/contracts'
import { snapshotContext as context } from './fixtures/reporting-snapshot'
import { deriveAdvertisingReview } from '@/lib/reporting/review/advertising'

const unavailable = { state: 'unavailable' as const, data: null, asOf: null, notes: [] }
function metric(key: string, value: number | null, id = context.account.id, level: 'account' | 'ad' | 'adset' | 'campaign' = 'account', prior?: number | null): ReportMetric {
  const event = key.startsWith('bookings') ? 'AppointmentConfirmed' : key === 'purchase_count' ? 'Purchase' : null
  return makeReportMetric({ context, key, label: key, definition: `Meta ${event ?? key}; omitted fields remain unavailable.`,
    source: 'meta', entity: { id, level }, unit: key === 'spend' ? 'money' : 'count', event,
    current: value, previous: prior, coverage: value === null ? UNKNOWN_FIELD_COVERAGE : COMPLETE_FIELD_COVERAGE,
    previousCoverage: prior === null || prior === undefined ? UNKNOWN_FIELD_COVERAGE : COMPLETE_FIELD_COVERAGE,
    measurementKind: event ? 'modelled' : 'measured', attributionScope: event ? 'meta_platform_modelled' : 'none',
    basis: 'impression_date_et', sourceHead: 'synthetic-advertising-review',
    maturity: { state: 'settled', matureThrough: context.range.to },
  })
}
function entity(id: string, values: Record<string, number | null>, level: ReportEntity['level'] = 'ad'): ReportEntity {
  return { id, level, name: `Creative ${id}`, campaignId: 'campaign', campaignName: 'Campaign', adsetId: 'set', adsetName: 'Set',
    status: 'ACTIVE', configurationAsOf: context.asOf, audience: 'unknown', audienceLabel: 'Unknown', creative: null,
    metrics: Object.fromEntries(Object.entries(values).map(([key, value]) => [key, metric(key, value, id, level)])) }
}
function data(entities: ReportEntity[] = [], metrics: ReportMetricMap = {}): ReportingData {
  return { context, business: unavailable, website: unavailable, meta: { state: 'available', asOf: context.asOf, notes: [], data: {
    metrics, entities, series: [], comparisonSeries: [], breakdowns: [], observations: [],
    attributionWindow: 'Meta entity attribution settings', reportingTime: 'Impression date', sourceDescription: 'Synthetic fixture',
  } } }
}
function finding(input: ReportingData, id: string): ReviewFinding {
  const result = deriveAdvertisingReview(input).find(item => item.id === id)
  expect(result, `review includes ${id}`).toBeDefined()
  return result!
}
function references(result: ReviewFinding) {
  return [...result.observation.evidence, ...result.materiality.evidence, ...result.counterEvidence.evidence,
    ...(result.exposure?.evidence ?? []), ...result.explanations.flatMap(item => item.evidence)]
}
const attribution = 'advertising.attribution'

describe('advertising expert review', () => {
  it('uses only AppointmentConfirmed outcomes and never substitutes or adds Purchase aliases', () => {
    const result = finding(data([entity('a', { spend: 90, bookings: null, purchase_count: 900 }),
      entity('b', { spend: 60, bookings: null, purchase_count: 800 })]), attribution)
    expect(result.status).toBe('unavailable')
    expect(references(result).some(ref => ref.metric.event === 'Purchase')).toBe(false)
  })

  it('shows a reversal between total and click-attributed ordering with the actual view fields', () => {
    const input = data([entity('a', { spend: 900, bookings: 12, bookings_click: 2, bookings_view: 10 }),
      entity('b', { spend: 600, bookings: 8, bookings_click: 6, bookings_view: 2 }),
      entity('tiny', { spend: 1, bookings: 1000, bookings_click: 0, bookings_view: 1000 })])
    const result = finding(input, attribution)
    expect(result.status).toBe('mixed')
    expect(result.observation.text).toMatch(/Creative a.*12.*Creative b.*8/)
    expect(result.observation.text).toMatch(/reverse|different order|leads.*click/i)
    expect(result.observation.text).not.toContain('tiny')
    expect(result.exposure?.value).toBe(1500)
    expect(new URL(result.nextInspection.href, 'http://localhost').searchParams.get('compare')).toBe('a,b')
    expect(references(result).filter(ref => ref.metric.key === 'bookings_view').map(ref => ref.metric.current.value)).toEqual(expect.arrayContaining([10, 2]))
  })

  it('does not infer a missing view count by subtracting clicks from total', () => {
    const result = finding(data([entity('a', { spend: 100, bookings: 12, bookings_click: 2, bookings_view: null })]), attribution)
    expect(result.observation.text).toMatch(/view.*unknown|view.*unavailable/i)
    expect(result.observation.text).not.toMatch(/view[^.;]*\b10\b/i)
    expect(references(result).some(ref => ref.metric.key === 'bookings_view' && ref.metric.current.value === 10)).toBe(false)
  })

  it('treats an explicit zero split as measured, while an absent split remains unknown', () => {
    const zero = finding(data([], { spend: metric('spend', 100), bookings: metric('bookings', 4),
      bookings_click: metric('bookings_click', 4), bookings_view: metric('bookings_view', 0) }), attribution)
    expect(zero.status).not.toBe('unavailable')
    expect(zero.observation.text).toMatch(/view[^.;]*0/)
    expect(references(zero).some(ref => ref.metric.key === 'bookings_view' && ref.metric.current.value === 0)).toBe(true)
    const absent = finding(data([], { spend: metric('spend', 100), bookings: metric('bookings', 4) }), attribution)
    expect(absent.observation.text).toMatch(/click.*unknown|click.*unavailable/i)
    expect(absent.observation.text).not.toMatch(/click-attributed[^.;]*\b0\b/i)
  })

  it.each(['event', 'source', 'window'] as const)('rejects incompatible %s identity in split comparisons', field => {
    const original = entity('a', { spend: 100, bookings: 12, bookings_click: 9, bookings_view: 3 })
    const click = original.metrics.bookings_click
    const incompatible = field === 'event' ? { ...click, event: 'Purchase' }
      : { ...click, current: { ...click.current, ...(field === 'source'
        ? { source: { ...click.current.source, system: 'ga4' as const } }
        : { window: { ...click.current.window, start: '2026-08-01' } }) } }
    const result = finding(data([{ ...original, metrics: { ...original.metrics, bookings_click: incompatible } }]), attribution)
    expect(result.observation.text).toMatch(/click.*unknown|click.*unavailable/i)
    expect(result.observation.text).not.toMatch(/click[^.;]*\b9\b/i)
  })

})
