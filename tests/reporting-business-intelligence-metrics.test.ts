import { describe, expect, it } from 'vitest'
import {
  buildBusinessCustomers, buildBusinessLeadTime, buildBusinessUpcoming,
} from '@/lib/reporting/business-intelligence-metrics'
import {
  BusinessCustomersSchema, BusinessLeadTimeSchema, BusinessUpcomingSchema, reportSectionSchema,
  type BusinessGroup, type ReportingContext,
} from '@/lib/reporting/contracts'
import { buildBusinessReport, type BusinessLedgerRow } from '@/lib/reporting/business-metrics'
import { validateReportingPacket } from '@/lib/reporting/validation'

const context: ReportingContext = {
  account: { id: 'account-db', metaAccountId: 'act_123', name: 'Studio' },
  range: { from: '2026-09-02', to: '2026-09-04' },
  comparison: { from: '2026-08-30', to: '2026-09-01' },
  timezone: 'America/New_York', currency: 'USD', asOf: '2026-09-05T16:00:00Z',
}
interface Row extends BusinessLedgerRow {
  email: string | null; datetime: string | null; datetime_created: string | null
  appointment_type_id?: number | null
}
const row = (values: Partial<Row> & Pick<Row, 'id'>): Row => ({
  price: 125, amount_paid: 125, canceled: false, business_state: null,
  booking_date_et: '2026-09-02', appointment_type: 'Studio Rental', appointment_type_id: 10,
  email: 'person@example.com', datetime_created: '2026-09-02T12:00:00-04:00',
  datetime: '2026-09-09T12:00:00-04:00', ...values,
})
const group = (groups: BusinessGroup[], id: string) => groups.find(value => value.id === id)!.metrics

describe('retained-ledger customer cohorts', () => {
  it('uses normalized identities, strict before-cohort history, and all unidentified monetary contributions', () => {
    const rows = [
      row({ id: 1, email: ' ALICE@example.com ', booking_date_et: '2026-08-29' }),
      row({ id: 2, email: 'bob@example.com', booking_date_et: '2026-08-30' }),
      row({ id: 3, email: 'alice@example.com' }),
      row({ id: 4, email: 'alice@example.com', booking_date_et: '2026-09-04' }),
      row({ id: 5, email: 'BOB@example.com' }),
      row({ id: 6, email: 'carol@example.com' }),
      row({ id: 7, email: 'carol@example.com' }),
      row({ id: 8, email: null, amount_paid: null }),
      row({ id: 9, email: 'not-an-email', amount_paid: 25 }),
      row({ id: 10, email: 'carol@example.com', price: 0, booking_date_et: '2026-08-29' }),
      row({ id: 11, email: 'carol@example.com', canceled: true, booking_date_et: '2026-08-29' }),
      row({ id: 12, email: 'carol@example.com', booking_date_et: 'not-a-date' }),
      row({ id: 13, email: 'outside@example.com', booking_date_et: '2026-09-05' }),
    ]
    const section = buildBusinessCustomers(context, [...rows, { ...rows[2] }])
    const data = section.data!
    expect(section.state).toBe('partial')
    expect(data.metrics.identified_customers.current.value).toBe(3)
    expect(data.metrics.prior_booking_customers.current.value).toBe(2)
    expect(data.metrics.first_observed_customers.current.value).toBe(1)
    expect(data.metrics.unidentified_bookings.current.value).toBe(2)
    expect(data.metrics.multiple_booking_customers.current.value).toBe(2)
    expect(data.metrics.identified_customers.previous?.value).toBe(1)
    expect(data.metrics.prior_booking_customers.previous?.value).toBe(0)
    expect(data.metrics.first_observed_customers.previous?.value).toBe(1)
    expect(data.groups.map(value => value.id)).toEqual(['prior_booking', 'first_observed', 'unidentified'])
    expect(group(data.groups, 'prior_booking').bookings.current.value).toBe(3)
    expect(group(data.groups, 'first_observed').bookings.current.value).toBe(2)
    expect(group(data.groups, 'unidentified').customers.current.value).toBeNull()
    expect(group(data.groups, 'unidentified').customers.current.coverage).toEqual({ state: 'partial', numerator: 0, denominator: 2 })
    expect(group(data.groups, 'first_observed').customers.current.coverage).toEqual({ state: 'partial', numerator: 2, denominator: 2 })
    expect(group(data.groups, 'unidentified').bookings.current.value).toBe(2)
    expect(group(data.groups, 'unidentified').booked_value.current.value).toBe(250)
    expect(group(data.groups, 'unidentified').amount_paid.current).toMatchObject({
      value: 25, coverage: { state: 'partial', numerator: 1, denominator: 2 },
      entity: { level: 'business', id: 'account-db:customers:unidentified' },
    })
    expect(data).toMatchObject({ historyFrom: '2026-08-29', historyTo: context.range.to,
      identityBasis: 'normalized_email', historyCoverage: 'retained_ledger' })
    expect(section.notes.join(' ')).toMatch(/not.*newly acquired/i)
    expect(section.notes.join(' ')).toMatch(/current.*ledger/i)
    expect(JSON.stringify(section)).not.toMatch(/alice@|bob@|carol@|person@|"email"|datetime_created|canceled|refund/i)
    expect(reportSectionSchema(BusinessCustomersSchema).safeParse(section).success).toBe(true)
  })

  it('never turns a same-day tie into prior history or a missing identity into a customer', () => {
    const data = buildBusinessCustomers(context, [row({ id: 1 }), row({ id: 2 }),
      row({ id: 3, email: ' ' }), row({ id: 4, email: 'missing@domain' }),
      row({ id: 5, email: 'with space@example.com' }),
    ]).data!
    expect(data.metrics.prior_booking_customers.current.value).toBe(0)
    expect(data.metrics.first_observed_customers.current.value).toBe(1)
    expect(data.metrics.multiple_booking_customers.current.value).toBe(1)
    expect(data.metrics.unidentified_bookings.current.value).toBe(3)
    expect(data.metrics.identified_customers.current.coverage.state).toBe('partial')
  })

  it('keeps empty observed cohorts distinct from unknown payment fields', () => {
    const empty = buildBusinessCustomers(context, []).data!
    expect(empty.historyFrom).toBeNull()
    expect(empty.metrics.identified_customers.current.value).toBe(0)
    expect(group(empty.groups, 'prior_booking').amount_paid.current.value).toBe(0)
    const unknown = buildBusinessCustomers(context, [row({ id: 1, amount_paid: null })]).data!
    expect(group(unknown.groups, 'first_observed').amount_paid.current.value).toBeNull()
    expect(group(unknown.groups, 'first_observed').paid_bookings.current.value).toBeNull()
  })
})

describe('booking-to-service lead time', () => {
  it('interpolates quantiles and accounts for every valid boundary and excluded timestamp', () => {
    const created = Date.parse('2026-09-02T12:00:00-04:00')
    const rows = [0, 0.999, 1, 7, 14, 30, 31].map((days, index) => row({
      id: index + 1, datetime: new Date(created + days * 86_400_000).toISOString(),
    }))
    const section = buildBusinessLeadTime(context, [...rows, { ...rows[0] },
      row({ id: 8, datetime: null }),
      row({ id: 9, datetime_created: '2026-09-02T12:00:00' }),
      row({ id: 10, datetime: '2026-09-01T12:00:00-04:00' }),
      row({ id: 11, datetime: '2026-02-30T12:00:00Z' }),
      row({ id: 12, canceled: true }), row({ id: 13, price: 0 }),
      row({ id: 14, booking_date_et: '2026-09-05' }),
      row({ id: 15, booking_date_et: '2026-08-30', datetime_created: '2026-08-30T12:00:00Z', datetime: '2026-09-01T12:00:00Z' }),
    ])
    const data = section.data!
    expect(data.metrics.eligible_bookings.current.value).toBe(11)
    expect(data.metrics.dated_bookings.current.value).toBe(7)
    expect(data.metrics.median_lead_days.current.value).toBe(7)
    expect(data.metrics.p25_lead_days.current.value).toBeCloseTo(0.9995)
    expect(data.metrics.p75_lead_days.current.value).toBe(22)
    expect(data.metrics.p90_lead_days.current.value).toBeCloseTo(30.4)
    expect(data.metrics.median_lead_days.current).toMatchObject({ unit: 'days',
      coverage: { state: 'partial', numerator: 7, denominator: 11 },
      entity: { id: 'account-db:lead_time' },
    })
    expect(data.metrics.median_lead_days.previous?.value).toBe(2)
    expect(data.buckets.map(value => [value.id, value.metrics.bookings.current.value])).toEqual([
      ['under_1', 2], ['1_7', 1], ['7_14', 1], ['14_30', 1], ['30_plus', 2],
    ])
    expect(data.buckets[0].metrics.bookings.current.entity.id).toBe('account-db:lead_time:under_1')
    expect(section.notes.join(' ')).toMatch(/not.*ad.touch/i)
    expect(reportSectionSchema(BusinessLeadTimeSchema).safeParse(section).success).toBe(true)
  })

  it('measures absolute elapsed days across a DST boundary without rounding into a different bucket', () => {
    const dstContext = { ...context, range: { from: '2026-11-01', to: '2026-11-01' },
      comparison: { from: '2026-10-31', to: '2026-10-31' } }
    const section = buildBusinessLeadTime(dstContext, [row({ id: 1, booking_date_et: '2026-11-01',
      datetime_created: '2026-11-01T00:30:00-04:00', datetime: '2026-11-02T00:30:00-05:00' })])
    expect(section.data!.metrics.median_lead_days.current.value).toBeCloseTo(25 / 24)
    expect(group(section.data!.buckets, '1_7').bookings.current.value).toBe(1)
  })

  it('withholds quantiles when every duration is unavailable while retaining the sample denominator', () => {
    const section = buildBusinessLeadTime(context, [row({ id: 1, datetime_created: null })])
    expect(section.state).toBe('partial')
    expect(section.data!.metrics.median_lead_days.current.value).toBeNull()
    expect(section.data!.metrics.median_lead_days.current.coverage).toEqual({ state: 'partial', numerator: 0, denominator: 1 })
    expect(section.data!.metrics.eligible_bookings.current.value).toBe(1)
    expect(section.data!.metrics.dated_bookings.current.value).toBe(0)
  })
})

describe('recorded upcoming service-date workload', () => {
  const observedAt = '2026-09-06T02:00:00Z' // still September 5 in ET
  it('uses the observation-time ET horizon, native amounts and observed dates without prior pickup claims', () => {
    const rows = [
      row({ id: 1, datetime: '2026-09-06T04:00:00Z', amount_paid: 0 }),
      row({ id: 2, datetime: '2026-10-04T03:59:59Z', amount_paid: null, appointment_type: 'Photo Session', appointment_type_id: 20 }),
      row({ id: 3, datetime: '2026-09-06T03:59:59Z' }),
      row({ id: 4, datetime: '2026-10-04T04:00:00Z' }),
      row({ id: 5, datetime: '2026-09-07T12:00:00', amount_paid: 500 }),
      row({ id: 6, canceled: true }), row({ id: 7, price: 0 }),
    ]
    const section = buildBusinessUpcoming(context, [...rows, { ...rows[0] }], observedAt)
    const data = section.data!
    expect(section.state).toBe('partial')
    expect(section.asOf).toBe(observedAt)
    expect(data.range).toEqual({ from: '2026-09-06', to: '2026-10-03' })
    expect(data.metrics.recorded_bookings.current.value).toBe(2)
    expect(data.metrics.booked_value.current.value).toBe(250)
    expect(data.metrics.amount_paid.current.value).toBe(0)
    expect(data.metrics.unknown_payment_count.current.value).toBe(1)
    expect(data.days.map(point => point.date)).toEqual(['2026-09-06', '2026-10-03'])
    expect(data.types.map(type => type.name)).toEqual(['Photo Session', 'Studio Rental'])
    expect(data.days[0].metrics.recorded_bookings.current.entity.id).toBe('account-db:upcoming:day:2026-09-06')
    expect(data.types[0].metrics.booked_value.current.entity.id).toBe('account-db:upcoming:type:outcome-type:20')
    for (const metrics of [data.metrics, ...data.days.map(day => day.metrics), ...data.types.map(type => type.metrics)]) {
      for (const metric of Object.values(metrics)) {
        expect(metric.previous).toBeNull()
        expect(metric.current.comparison).toEqual({ method: 'none', window: null })
        expect(metric.current.coverage.state).toBe('partial')
        expect(metric.current.window.basis).toBe('service_date_et')
        expect(metric.current.asOf).toBe(observedAt)
      }
    }
    expect(section.notes.join(' ')).toMatch(/completeness.*unverified/i)
    expect(section.notes.join(' ')).toMatch(/not.*open slots/i)
    expect(JSON.stringify(section)).not.toMatch(/person@example|datetime_created|canceled|refund/i)
    expect(reportSectionSchema(BusinessUpcomingSchema).safeParse(section).success).toBe(true)
  })

  it('withholds empty future reads and unknown payment values without inventing available capacity', () => {
    const empty = buildBusinessUpcoming(context, [], observedAt)
    expect(empty.state).toBe('partial')
    expect(empty.data!.days).toEqual([])
    expect(empty.data!.types).toEqual([])
    expect(Object.values(empty.data!.metrics).every(metric => metric.current.value === null)).toBe(true)
    const unknown = buildBusinessUpcoming(context, [row({ id: 1, amount_paid: null })], observedAt).data!
    expect(unknown.metrics.amount_paid.current.value).toBeNull()
    expect(unknown.metrics.recorded_bookings.current.value).toBe(1)
    expect(unknown.metrics.unknown_payment_count.current.value).toBe(1)
  })

  it.each(['2026-09-06T02:00:00', '2026-02-30T02:00:00Z', 'invalid'])('rejects invalid observation time %s', value => {
    expect(() => buildBusinessUpcoming(context, [], value)).toThrow('business_observation_time_invalid')
  })

  it('keeps same-label native IDs distinct and combines observed labels for one native service without losing legacy records', () => {
    const rows = [
      row({ id: 1, appointment_type_id: 10, appointment_type: 'Shared', amount_paid: 10 }),
      row({ id: 2, appointment_type_id: 20, appointment_type: 'Shared', amount_paid: 20 }),
      row({ id: 3, appointment_type_id: 30, appointment_type: 'Original', amount_paid: 30 }),
      row({ id: 4, appointment_type_id: 30, appointment_type: 'Updated', amount_paid: 40 }),
      row({ id: 5, appointment_type_id: null, appointment_type: 'Shared', amount_paid: 50 }),
      row({ id: 6, appointment_type_id: undefined, appointment_type: 'outcome-type:30', amount_paid: 60 }),
    ]
    const upcoming = buildBusinessUpcoming(context, rows, observedAt)
    const types = new Map(upcoming.data!.types.map(type => [type.id, type]))
    expect(types.size).toBe(5)
    expect(types.get('outcome-type:10')?.metrics.amount_paid.current.value).toBe(10)
    expect(types.get('outcome-type:20')?.metrics.amount_paid.current.value).toBe(20)
    expect(types.get('outcome-type:30')).toMatchObject({ name: 'Original / Updated', metrics: { amount_paid: { current: { value: 70 } } } })
    expect(types.get('Shared')?.metrics.amount_paid.current.value).toBe(50)
    expect(types.get('outcome-label:outcome-type:30')?.metrics.amount_paid.current.value).toBe(60)
    const report = { ...buildBusinessReport(context, rows, []), intelligence: {
      customers: buildBusinessCustomers(context, rows), leadTime: buildBusinessLeadTime(context, rows), upcoming,
    } }
    expect(validateReportingPacket({ section: 'business', context, notes: [], result: {
      state: 'partial', asOf: observedAt, notes: [], data: report,
    } }).section).toBe('business')
  })
})

describe('source-private duplicate and immutability controls', () => {
  it.each(['email', 'datetime', 'datetime_created', 'appointment_type_id'] as const)(
    'rejects conflicting %s on a replayed appointment ID without disclosing private values', field => {
      const original = row({ id: 1 })
      const conflict = { ...original, [field]: field === 'appointment_type_id' ? 999 : 'private-conflict@example.com' }
      for (const build of [buildBusinessCustomers, buildBusinessLeadTime,
        (ctx: ReportingContext, rows: Row[]) => buildBusinessUpcoming(ctx, rows, context.asOf)]) {
        expect(() => build(context, [original, conflict])).toThrow(/^outcome_conflicting_duplicate_id:1$/)
      }
    },
  )
  it('does not mutate private source rows or the selected report context', () => {
    const original = Object.freeze(row({ id: 1, email: ' PERSON@example.com ' }))
    const rows = Object.freeze([original])
    const before = JSON.stringify({ context, rows })
    buildBusinessCustomers(context, rows)
    buildBusinessLeadTime(context, rows)
    buildBusinessUpcoming(context, rows, context.asOf)
    expect(JSON.stringify({ context, rows })).toBe(before)
  })

  it('produces source-bound claims accepted by the real packet validator for all three sections', () => {
    const current = [row({ id: 1, amount_paid: null })]
    const previous = [row({ id: 2, booking_date_et: context.comparison.from, email: null })]
    const report = { ...buildBusinessReport(context, current, previous), intelligence: {
      customers: buildBusinessCustomers(context, [...current, ...previous]),
      leadTime: buildBusinessLeadTime(context, [...current, ...previous]),
      upcoming: buildBusinessUpcoming(context, current, context.asOf),
    } }
    const packet = { section: 'business', context, notes: [], result: { state: 'partial', asOf: context.asOf, notes: [], data: report } }
    expect(validateReportingPacket(packet).section).toBe('business')
  })
})
