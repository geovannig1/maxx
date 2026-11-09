import { describe, expect, it } from 'vitest'
import { MetricClaimSchema, RECOMMENDATION_EVIDENCE_VALUE_FORMATTER } from '@/lib/cockpit/contracts'
import { makeReportMetric } from '@/lib/reporting/claims'
import { validateReportingPacket } from '@/lib/reporting/validation'
import { reportingFixture } from '../scripts/demo/sample/reports'
import { previousReportingRange } from '@/lib/reporting/range'
import { upcomingBusinessContext } from '@/lib/reporting/business-intelligence-context'

const unavailable = { state: 'unavailable', data: null, asOf: null, notes: ['Detail was not supplied.'] }
function packet() {
  const data = reportingFixture()
  const range = { from: '2026-09-06', to: '2026-10-03' }
  const metric = makeReportMetric({ context: { ...data.context, range, comparison: previousReportingRange(range) },
    key: 'recorded_bookings', label: 'Recorded upcoming bookings', definition: 'Observed active bookings in the next 28 service dates; source completeness is unverified.',
    source: 'outcomes', unit: 'count', current: 3, entity: { level: 'business', id: 'fixture-db:upcoming' },
    coverage: { state: 'partial', numerator: null, denominator: null } })
  const upcomingMetric = { ...metric, current: { ...metric.current, window: { ...metric.current.window, basis: 'service_date_et' },
    comparison: { method: 'none', window: null } } }
  return { context: data.context, section: 'business', notes: [], result: { ...data.business, data: {
    ...data.business.data, intelligence: { customers: unavailable, leadTime: unavailable,
      upcoming: { state: 'partial', asOf: data.context.asOf, notes: ['Recorded schedule, not availability.'], data: {
        range, metrics: { recorded_bookings: upcomingMetric }, days: [], types: [],
      } } },
  } } }
}

describe('business perspective evidence boundaries', () => {
  it('accepts a qualified upcoming service-date view without relabeling selected booking-created totals', () => {
    expect(() => validateReportingPacket(packet())).not.toThrow()
  })
  it.each(['basis', 'entity', 'range', 'comparison', 'source'] as const)('rejects an invalid upcoming %s', field => {
    const value = structuredClone(packet())
    const claim = value.result.data.intelligence.upcoming.data.metrics.recorded_bookings.current
    if (field === 'basis') claim.window.basis = 'booking_created_date_et'
    if (field === 'entity') claim.entity.id = 'another-account:upcoming'
    if (field === 'range') claim.window.start = '2026-09-02'
    if (field === 'comparison') claim.comparison.method = 'prior_equal_period'
    if (field === 'source') claim.source.system = 'meta'
    expect(() => validateReportingPacket(value)).toThrow()
  })
  it('retains strict public schemas that reject customer PII', () => {
    const value = packet()
    const withPii = { ...value.result.data.intelligence, email: 'fictional-person@example.test' }
    value.result.data.intelligence = withPii
    expect(() => validateReportingPacket(value)).toThrow()
  })
  it('supports a days duration with an explicit formatter', () => {
    const base = reportingFixture().business.data!.metrics.paid_bookings.current
    expect(MetricClaimSchema.safeParse({ ...base, value: 7.25, unit: 'days' }).success).toBe(true)
    const format = Reflect.get(RECOMMENDATION_EVIDENCE_VALUE_FORMATTER, 'days')
    expect(typeof format).toBe('function')
    if (typeof format === 'function') expect(format(7.25)).toBe('7.3 days')
  })
  it('rejects a service-date basis in native Meta evidence while accepting its original basis', () => {
    const data = reportingFixture()
    const native = { context: data.context, section: 'meta', notes: [], result: { ...data.meta, data: {
      ...data.meta.data!, metrics: { spend: data.meta.data!.metrics.spend },
      entities: [], series: [], comparisonSeries: [], breakdowns: [],
    } } }
    expect(() => validateReportingPacket(native)).not.toThrow()
    const value = structuredClone(native)
    const metric = value.result.data!.metrics.spend
    metric.current.window.basis = 'service_date_et'
    if (metric.current.comparison.window) metric.current.comparison.window.basis = 'service_date_et'
    if (metric.previous) metric.previous.window.basis = 'service_date_et'
    expect(() => validateReportingPacket(value)).toThrow()
  })
  it('anchors the future horizon to the observed New York day across UTC midnight and DST', () => {
    const context = reportingFixture().context
    expect(upcomingBusinessContext(context, '2026-11-01T03:30:00Z').range).toEqual({ from: '2026-11-01', to: '2026-11-28' })
    expect(upcomingBusinessContext(context, '2026-11-01T05:30:00Z').range).toEqual({ from: '2026-11-02', to: '2026-11-29' })
  })
})
