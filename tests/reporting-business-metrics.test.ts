import { describe, expect, it } from 'vitest'
import { buildBusinessReport, type BusinessLedgerRow } from '@/lib/reporting/business-metrics'
import { BusinessReportSchema } from '@/lib/reporting/contracts'
import { validateReportingPacket } from '@/lib/reporting/validation'

const context = {
  account: { id: 'account-db', metaAccountId: 'act_123', name: 'Studio' },
  range: { from: '2026-09-02', to: '2026-09-04' },
  comparison: { from: '2026-08-30', to: '2026-09-01' },
  timezone: 'America/New_York' as const,
  currency: 'USD' as const,
  asOf: '2026-09-05T16:00:00Z',
}

const row = (values: Partial<BusinessLedgerRow> & Pick<BusinessLedgerRow, 'id'>): BusinessLedgerRow => ({
  price: 125,
  amount_paid: 125,
  canceled: false,
  business_state: null,
  booking_date_et: '2026-09-02',
  appointment_type: 'Hourly Studio Rental',
  ...values,
})

describe('business reporting metrics', () => {
  it('keeps the canonical price classifier separate from the positive-payment paid count', () => {
    const current = [
      row({ id: 1, price: 125, amount_paid: 0 }),
      row({ id: 2, price: 125, amount_paid: null }),
      row({ id: 3, price: 0, amount_paid: 75, appointment_type: "Holiday Mini Photo Session" }),
      row({ id: 4, price: 500, amount_paid: 500, canceled: true }),
      row({ id: 3, price: 0, amount_paid: 75, appointment_type: "Holiday Mini Photo Session" }),
    ]
    const report = buildBusinessReport(context, current, [])

    expect(report.metrics.active_appointments.current.value).toBe(3)
    expect(report.metrics.value_bearing_bookings.current.value).toBe(2)
    expect(report.metrics.paid_bookings.current.value).toBe(1)
    expect(report.metrics.paid_bookings.current.coverage).toEqual({
      state: 'partial', numerator: 2, denominator: 3,
    })
    expect(report.metrics.amount_paid.current.value).toBe(75)
    expect(report.metrics.unknown_payment_count.current.value).toBe(1)
    expect(report.metrics.payment_coverage.current.value).toBeCloseTo(66.666, 2)
    expect(JSON.stringify(report)).not.toMatch(/cancel|refund|customer returns/i)
    expect(BusinessReportSchema.safeParse(report).success).toBe(true)
  })

  it('retains explicit zero, null-payment coverage and prior-period claims', () => {
    const current = [row({ id: 1, amount_paid: 0 })]
    const previous = [row({ id: 2, amount_paid: 125, booking_date_et: '2026-08-30' })]
    const report = buildBusinessReport(context, current, previous)

    expect(report.metrics.paid_bookings.current.value).toBe(0)
    expect(report.metrics.amount_paid.current.value).toBe(0)
    expect(report.metrics.paid_bookings.previous?.value).toBe(1)
    expect(report.metrics.paid_bookings.previous?.window).toMatchObject({
      start: context.comparison.from, end: context.comparison.to,
    })
    expect(report.metrics.payment_coverage.current.value).toBe(100)
  })

  it('does not turn an entirely unobserved payment instrument into measured zero', () => {
    const report = buildBusinessReport(context, [row({ id: 1, amount_paid: null })], [])

    expect(report.metrics.paid_bookings.current.value).toBeNull()
    expect(report.metrics.amount_paid.current.value).toBeNull()
    expect(report.metrics.paid_bookings.current.coverage).toEqual({
      state: 'partial', numerator: 0, denominator: 1,
    })
    expect(report.metrics.unknown_payment_count.current.value).toBe(1)
    expect(report.metrics.payment_coverage.current.value).toBe(0)
  })

  it('rejects conflicting duplicate appointment IDs while allowing identical replay rows', () => {
    const original = row({ id: 1, amount_paid: 100 })
    expect(() => buildBusinessReport(context, [original, { ...original }], [])).not.toThrow()
    expect(() => buildBusinessReport(context, [original, { ...original, amount_paid: 500 }], []))
      .toThrow('outcome_conflicting_duplicate_id')
  })

  it('zero-fills healthy calendar days and leaves unverified appointment types unknown', () => {
    const report = buildBusinessReport(context, [
      row({ id: 1, appointment_type: 'Afternoon Studio Rental' }),
      row({ id: 2, appointment_type: "Holiday Mini Photo Session", booking_date_et: '2026-09-04' }),
      row({ id: 3, appointment_type: 'Mystery Package', booking_date_et: '2026-09-04' }),
    ], [])

    expect(report.series.map(point => point.date)).toEqual(['2026-09-02', '2026-09-03', '2026-09-04'])
    expect(report.series[1].metrics.active_appointments.current.value).toBe(0)
    expect(report.types.map(type => [type.name, type.category])).toEqual([
      ['Afternoon Studio Rental', 'rental'],
      ["Holiday Mini Photo Session", 'photography'],
      ['Mystery Package', 'unknown'],
    ])
    expect(JSON.stringify(report)).not.toMatch(/email|phone|first_name|last_name/i)
  })

  it('compares the full union of current and prior appointment types with native zero and missing-payment semantics', () => {
    const report = buildBusinessReport(context, [
      row({ id: 1, appointment_type: 'Current only', amount_paid: null }),
      row({ id: 2, appointment_type: 'Shared', amount_paid: 0 }),
    ], [
      row({ id: 3, appointment_type: 'Prior only', booking_date_et: '2026-08-30', amount_paid: 90 }),
      row({ id: 4, appointment_type: 'Shared', booking_date_et: '2026-08-31', amount_paid: 125 }),
    ])
    expect(report.types.map(type => type.name)).toEqual(['Current only', 'Prior only', 'Shared'])
    const [current, prior, shared] = report.types
    expect(current.metrics.amount_paid.current.value).toBeNull()
    expect(current.metrics.amount_paid.previous?.value).toBe(0)
    expect(prior.metrics.amount_paid.current.value).toBe(0)
    expect(prior.metrics.amount_paid.previous?.value).toBe(90)
    expect(shared.metrics.amount_paid.current.value).toBe(0)
    expect(shared.metrics.amount_paid.previous?.value).toBe(125)
    expect(prior.metrics.paid_bookings.previous).toMatchObject({
      entity: { id: 'account-db:type:Prior only' },
      window: { start: context.comparison.from, end: context.comparison.to },
    })
  })

  it('preserves native service identities across shared labels, renames, prior-only services and legacy names', () => {
    const report = buildBusinessReport(context, [
      row({ id: 1, appointment_type_id: 10, appointment_type: 'Shared', amount_paid: 100 }),
      row({ id: 2, appointment_type_id: 20, appointment_type: 'Shared', amount_paid: 200 }),
      row({ id: 3, appointment_type_id: 30, appointment_type: 'Updated', amount_paid: 300 }),
      row({ id: 4, appointment_type_id: null, appointment_type: 'Legacy', amount_paid: 40 }),
      row({ id: 5, appointment_type: 'outcome-type:30', amount_paid: 50 }),
      row({ id: 6, appointment_type_id: 50, appointment_type: 'Variant B', amount_paid: 60 }),
      row({ id: 7, appointment_type_id: 50, appointment_type: 'Variant A', amount_paid: 70 }),
    ], [
      row({ id: 8, appointment_type_id: 30, appointment_type: 'Original', amount_paid: 150, booking_date_et: '2026-08-30' }),
      row({ id: 9, appointment_type_id: 40, appointment_type: 'Prior only', amount_paid: 75, booking_date_et: '2026-08-30' }),
      row({ id: 10, appointment_type: 'Legacy', amount_paid: 45, booking_date_et: '2026-08-30' }),
      row({ id: 11, appointment_type_id: 10, appointment_type: 'Shared', amount_paid: 80, booking_date_et: '2026-08-30' }),
    ])
    const types = new Map(report.types.map(type => [type.id, type]))
    expect(types.size).toBe(7)
    expect(types.get('outcome-type:10')?.metrics.amount_paid.current.value).toBe(100)
    expect(types.get('outcome-type:20')?.metrics.amount_paid.current.value).toBe(200)
    expect(types.get('outcome-type:30')).toMatchObject({ name: 'Updated', metrics: {
      amount_paid: { current: { value: 300 }, previous: { value: 150 } },
    } })
    expect(types.get('outcome-type:40')).toMatchObject({ name: 'Prior only', metrics: {
      amount_paid: { current: { value: 0 }, previous: { value: 75 } },
    } })
    expect(types.get('outcome-type:50')).toMatchObject({ name: 'Variant A / Variant B', metrics: { amount_paid: { current: { value: 130 } } } })
    expect(types.get('Legacy')?.metrics.amount_paid.previous?.value).toBe(45)
    expect(types.get('outcome-label:outcome-type:30')?.metrics.amount_paid.current.value).toBe(50)
    expect(validateReportingPacket({ section: 'business', context, notes: [], result: {
      state: 'available', asOf: context.asOf, notes: [], data: report,
    } }).section).toBe('business')
  })

  it('rejects conflicting native service IDs on a duplicate appointment', () => {
    const original = row({ id: 1, appointment_type_id: 10 })
    expect(() => buildBusinessReport(context, [original, { ...original, appointment_type_id: 20 }], []))
      .toThrow('outcome_conflicting_duplicate_id:1')
  })

  it.each([0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects invalid present native service ID %s', appointment_type_id => {
    expect(() => buildBusinessReport(context, [row({ id: 1, appointment_type_id })], []))
      .toThrow('outcome_invalid_appointment_type_id')
  })
})
