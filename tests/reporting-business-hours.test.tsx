import './_support/outcome-noun-booking'
import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { buildBusinessReport, type BusinessLedgerRow } from '@/lib/reporting/business-metrics'
import { buildBusinessCustomers, buildBusinessUpcoming, type BusinessIntelligenceRow } from '@/lib/reporting/business-intelligence-metrics'
import { validateReportingPacket } from '@/lib/reporting/validation'
import { BusinessDetailReport } from '@/components/reporting/BusinessDetailReport'
import { BusinessOverview } from '@/components/reporting/BusinessOverview'
import { collectReportExportRows } from '@/components/reporting/ReportsReport'
import { reportingFixture } from '../scripts/demo/sample/reports'
import { deriveExpertReview } from '@/lib/reporting/review'

vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams(), usePathname: () => '/reports' }))
const context = reportingFixture().context
type DurationRow = BusinessLedgerRow & { appointment_duration?: unknown }
const row = (id: number, duration: unknown, extra: Partial<DurationRow> = {}): DurationRow => ({ id,
  appointment_type: 'Native service', appointment_type_id: 10, price: 100, amount_paid: 100, canceled: false,
  booking_date_et: context.range.from, appointment_duration: duration, ...extra })

describe('recorded appointment hours', () => {
  it('preserves the reversal where more bookings contain fewer recorded hours, through services, days and export', () => {
    const current = [row(1, '60'), row(2, 90)]
    const previous = [row(3, '240', { booking_date_et: context.comparison.from })]
    const business = buildBusinessReport(context, current, previous)
    expect(business.metrics.value_bearing_bookings.current.value).toBe(2)
    expect(business.metrics.recorded_booked_hours?.current.value).toBe(2.5)
    expect(business.metrics.recorded_booked_hours.previous?.value).toBe(4)
    expect(business.metrics.hours_per_recorded_booking.current.value).toBe(1.25)
    expect(business.metrics.duration_coverage.current.value).toBe(100)
    expect(business.types[0].metrics.recorded_booked_hours.current.value).toBe(2.5)
    expect(business.series[0].metrics.recorded_booked_hours.current.value).toBe(2.5)
    const data = { ...reportingFixture(), business: { state: 'available' as const, data: business, asOf: context.asOf, notes: [] } }
    expect(() => validateReportingPacket({ context, section: 'business', result: data.business, notes: [] })).not.toThrow()
    const exported = collectReportExportRows(data, 'business').find(value => value.metric === 'Recorded booked hours')
    expect(exported).toMatchObject({ value: 2.5, previous_value: 4, unit: 'hours', coverage: 'complete', previous_coverage: 'complete' })
    const review = deriveExpertReview(data).findings.find(item => item.id === 'business_type:outcome-type%3A10')
    expect(review?.direction).toBe('mixed')
    expect(review?.observation.text).toContain('More bookings contain fewer recorded hours')
    expect(review?.observation.evidence.some(ref => ref.metric.key === 'recorded_booked_hours')).toBe(true)
    for (const html of [renderToStaticMarkup(<BusinessDetailReport data={data} />), renderToStaticMarkup(<BusinessOverview data={data} />)]) {
      expect(html).toContain('Recorded booked hours')
      expect(html).toContain('2.5 h')
      expect(html).toContain('Duration coverage')
      expect(html).toContain('current stored schedule')
    }
  })
  it('keeps incomplete current and prior duration samples separate from all appointments and payments', () => {
    const business = buildBusinessReport(context, [row(1, '90'), row(2, null), row(3, '600', { price: 0, amount_paid: 75 }),
      row(4, 300, { canceled: true })], [row(5, '180', { booking_date_et: context.comparison.from })])
    expect(business.metrics.recorded_booked_hours?.current).toMatchObject({ value: 1.5, coverage: { state: 'partial', numerator: 1, denominator: 2 } })
    expect(business.metrics.recorded_booked_hours.previous).toMatchObject({ value: 3, coverage: { state: 'complete', numerator: 1, denominator: 1 } })
    expect(business.metrics.hours_per_recorded_booking.current.value).toBe(1.5)
    expect(business.metrics.duration_coverage.current.value).toBe(50)
    expect(business.metrics.duration_recorded_bookings.current.value).toBe(1)
    expect(business.metrics.amount_paid.current.value).toBe(275)
  })
  it.each([undefined, null, '', ' ', '1 hour', '0', 0, -60, false, {}, [60], 'Infinity', Infinity, '1e2'])('does not coerce invalid duration into hours: %s', value => {
    const business = buildBusinessReport(context, [row(1, value)], [])
    expect(business.metrics.recorded_booked_hours?.current.value).toBeNull()
    expect(business.metrics.hours_per_recorded_booking.current.value).toBeNull()
    expect(business.metrics.duration_coverage.current.value).toBe(0)
    expect(business.metrics.amount_paid.current.value).toBe(100)
  })
  it('distinguishes a healthy empty booking cohort from a nonempty cohort without durations', () => {
    const business = buildBusinessReport(context, [], [row(1, null, { booking_date_et: context.comparison.from })])
    expect(business.metrics.recorded_booked_hours?.current.value).toBe(0)
    expect(business.metrics.recorded_booked_hours.previous?.value).toBeNull()
    expect(business.metrics.hours_per_recorded_booking.current.value).toBeNull()
    expect(business.metrics.duration_coverage.current.value).toBeNull()
  })
  it('does not interpret a smaller partial duration sample or wrong-source claim as an hours decline', () => {
    const current = [row(1, '60'), row(2, null)], previous = [row(3, '240', { booking_date_et: context.comparison.from })]
    const business = buildBusinessReport(context, current, previous)
    const data = { ...reportingFixture(), business: { state: 'available' as const, data: business, asOf: context.asOf, notes: [] } }
    const review = deriveExpertReview(data).findings.find(item => item.id === 'business_type:outcome-type%3A10')
    expect(review?.direction).toBe('improved')
    expect(review?.observation.text).not.toContain('More bookings contain fewer recorded hours')
    expect(review?.observation.text).toContain('does not establish a decline in booked hours')
    const wrong = structuredClone(data)
    wrong.business.data.types[0].metrics.recorded_booked_hours.current.source.system = 'meta'
    const rejected = deriveExpertReview(wrong)
    expect(rejected.input.rejectedSources).toContain('business')
    expect(rejected.findings.some(item => item.observation.evidence.some(ref => ref.metric.key === 'recorded_booked_hours'))).toBe(false)
  })
  it('does not call the whole service unchanged when counts and payments match but duration coverage is incomplete', () => {
    const current = [row(1, '60'), row(2, null)]
    const previous = [row(3, '120', { booking_date_et: context.comparison.from }), row(4, '120', { booking_date_et: context.comparison.from })]
    const business = buildBusinessReport(context, current, previous)
    const data = { ...reportingFixture(), business: { state: 'available' as const, data: business, asOf: context.asOf, notes: [] } }
    const review = deriveExpertReview(data).findings.find(item => item.id === 'business_type:outcome-type%3A10')
    expect(review?.status).toBe('mixed')
    expect(review?.nextInspection.question).toContain('duration')
    expect(review?.observation.text).not.toContain('Recorded hours fell')
  })
  it('makes the duration sample inspectable beside customer-group hours and averages', () => {
    const records: BusinessIntelligenceRow[] = [row(1, '60'), row(2, null)].map(item => ({ ...item,
      email: 'same@example.test', datetime: null, datetime_created: null }))
    const business = buildBusinessReport(context, records, [])
    const unavailable = { state: 'unavailable' as const, data: null, asOf: null, notes: [] }
    const data = { ...reportingFixture(), business: { state: 'partial' as const, asOf: context.asOf, notes: [], data: {
      ...business, intelligence: { customers: buildBusinessCustomers(context, records), leadTime: unavailable, upcoming: unavailable },
    } } }
    const html = renderToStaticMarkup(<BusinessDetailReport data={data} />)
    const customerSection = html.split('id="business-customers"')[1].split('id="business-lead-time"')[0]
    expect(customerSection).toContain('Bookings with recorded duration')
    expect(customerSection).toContain('Duration coverage')
    expect(customerSection).toContain('50.0%')
  })
  it('deduplicates replayed appointments and rejects conflicting durations', () => {
    const first = row(1, '60')
    expect(buildBusinessReport(context, [first, { ...first }], []).metrics.recorded_booked_hours?.current.value).toBe(1)
    expect(() => buildBusinessReport(context, [first, { ...first, appointment_duration: '120' }], [])).toThrow(/conflicting_duplicate/)
  })
  it('reports upcoming hours with their separate service-date window and no invented prior comparison', () => {
    const records: BusinessIntelligenceRow[] = [{ ...row(1, '180'), datetime: '2026-09-08T12:00:00-04:00',
      datetime_created: '2026-08-01T12:00:00-04:00', booking_date_et: '2026-08-01', email: null }]
    const upcoming = buildBusinessUpcoming(context, records, context.asOf)
    expect(upcoming.data?.metrics.recorded_booked_hours?.current).toMatchObject({ value: 3, unit: 'hours',
      coverage: { state: 'partial' }, window: { basis: 'service_date_et' }, comparison: { method: 'none' } })
    expect(upcoming.data?.metrics.recorded_booked_hours.previous).toBeNull()
    expect(upcoming.data?.days[0].metrics.recorded_booked_hours.current.value).toBe(3)
    expect(upcoming.data?.types[0].metrics.recorded_booked_hours.current.value).toBe(3)
    expect(buildBusinessUpcoming(context, [], context.asOf).data?.metrics.recorded_booked_hours.current.value).toBeNull()
  })
})
