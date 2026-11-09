import { describe, expect, it } from 'vitest'
import { buildBusinessCustomerFollowup } from '@/lib/reporting/business-customer-followup'
import { buildBusinessCustomers, type BusinessIntelligenceRow } from '@/lib/reporting/business-intelligence-metrics'
import { buildBusinessReport } from '@/lib/reporting/business-metrics'
import { BusinessCustomersSchema, type BusinessGroup, type ReportingContext } from '@/lib/reporting/contracts'
import { validateReportingPacket } from '@/lib/reporting/validation'

const context: ReportingContext = {
  account: { id: 'account-db', metaAccountId: 'act_123', name: 'Studio' },
  range: { from: '2026-09-10', to: '2026-09-12' },
  comparison: { from: '2026-09-07', to: '2026-09-09' },
  timezone: 'America/New_York', currency: 'USD', asOf: '2026-09-18T16:00:00Z',
}

const row = (id: number, email: string | null, date: string, values: Partial<BusinessIntelligenceRow> = {}): BusinessIntelligenceRow => ({
  id, price: 100, amount_paid: 100, canceled: false, business_state: null,
  booking_date_et: date, appointment_type: 'Studio Rental', appointment_type_id: 10,
  email, datetime_created: `${date}T12:00:00-04:00`, datetime: `${date}T14:00:00-04:00`,
  ...values,
})

const metrics = (groups: BusinessGroup[], id: string) => groups.find(group => group.id === id)!.metrics

describe('equal-horizon first-observed customer follow-up', () => {
  it('reverses the raw multiple-booking appearance at an equal 7-day horizon and excludes unproved repeats', () => {
    const rows = [
      // Prior cohort: two mature entrants, both repeat within seven calendar days.
      row(1, 'prior-a@example.com', '2026-09-07'),
      row(2, 'PRIOR-A@example.com', '2026-09-08', { price: 200 }),
      row(3, 'prior-b@example.com', '2026-09-08'),
      row(4, 'prior-b@example.com', '2026-09-09', { price: 150 }),
      // Current appears stronger by raw multiple-booking customers (3 versus 2).
      row(10, 'current-a@example.com', '2026-09-10'),
      row(11, 'current-a@example.com', '2026-09-10', { price: 900 }), // same day is not later sequence
      row(12, 'current-a@example.com', '2026-09-18', { price: 800 }), // after its seven-day deadline
      row(13, 'current-b@example.com', '2026-09-11'),
      row(14, ' CURRENT-B@example.com ', '2026-09-12', { price: 50 }),
      row(15, 'current-b@example.com', '2026-09-14', { canceled: true, price: 700 }),
      row(16, 'current-b@example.com', '2026-09-15', { price: 0 }),
      row(17, 'current-b@example.com', '2026-09-19', { price: 600 }), // after observation
      row(18, 'current-c@example.com', '2026-09-12'),
      row(19, 'current-c@example.com', '2026-09-12', { price: 400 }), // same day; entrant is not mature at 7d
      // Invalid identities never enter a customer cohort.
      row(20, null, '2026-09-10'),
      row(21, 'not-an-email', '2026-09-10'),
      row(22, 'future@example.com', '2026-09-19'),
      // An earlier retained booking means this identity is not first observed in the current cohort.
      row(30, 'existing@example.com', '2026-09-06'),
      row(31, 'existing@example.com', '2026-09-11'),
    ]

    const section = buildBusinessCustomers(context, rows, '2026-09-18')
    const customers = section.data!
    const followup = customers.followup!
    const seven = metrics(followup.horizons, '7_day')

    expect(customers.metrics.multiple_booking_customers.current.value).toBe(3)
    expect(customers.metrics.multiple_booking_customers.previous?.value).toBe(2)
    expect(followup.observedThrough).toBe('2026-09-18')
    expect(followup.horizons.map(group => [group.id, group.name])).toEqual([
      ['7_day', '7-day follow-up'], ['14_day', '14-day follow-up'], ['30_day', '30-day follow-up'],
    ])
    expect(Object.keys(seven).sort()).toEqual([
      'cohort_customers', 'eligible_customers', 'repeat_booked_value',
      'repeat_booked_value_per_eligible_customer', 'repeat_bookings', 'repeat_customers', 'repeat_rate',
    ])
    expect(seven.cohort_customers.current.value).toBe(3)
    expect(seven.eligible_customers.current.value).toBe(2)
    expect(seven.repeat_customers.current.value).toBe(1)
    expect(seven.repeat_rate.current.value).toBe(50)
    expect(seven.repeat_bookings.current.value).toBe(1)
    expect(seven.repeat_booked_value.current.value).toBe(50)
    expect(seven.repeat_booked_value_per_eligible_customer.current.value).toBe(25)
    expect(seven.cohort_customers.previous?.value).toBe(2)
    expect(seven.eligible_customers.previous?.value).toBe(2)
    expect(seven.repeat_customers.previous?.value).toBe(2)
    expect(seven.repeat_rate.previous?.value).toBe(100)
    expect(seven.repeat_bookings.previous?.value).toBe(2)
    expect(seven.repeat_booked_value.previous?.value).toBe(350)
    expect(seven.repeat_booked_value_per_eligible_customer.previous?.value).toBe(175)
    expect(seven.repeat_rate.current).toMatchObject({
      source: { system: 'outcomes', role: 'business_truth', evidencePlane: 'outcome_business' },
      entity: { level: 'business', id: 'account-db:customers:followup:7_day' },
      attributionScope: 'all_sources', measurementKind: 'derived',
      window: { start: '2026-09-10', end: '2026-09-12', basis: 'booking_created_date_et', timezone: 'America/New_York' },
      coverage: { state: 'complete', numerator: 2, denominator: 2 },
      maturity: { state: 'partial', matureThrough: '2026-09-11' },
    })
    expect(seven.repeat_rate.previous).toMatchObject({
      window: { start: '2026-09-07', end: '2026-09-09' },
      maturity: { state: 'settled', matureThrough: '2026-09-11' },
    })
    expect(seven.repeat_rate.current.inputClaimIds).toEqual(expect.arrayContaining([
      seven.repeat_customers.current.claimId, seven.eligible_customers.current.claimId,
    ]))
    expect(JSON.stringify(followup)).not.toMatch(/@example|"email"|ltv|profit|paid attribution/i)
    expect(section.notes.join(' ')).toMatch(/retained ledger.*not.*acquisition/i)
    expect(section.notes.join(' ')).toMatch(/current mutable ledger facts/i)
  })

  it('makes denominator-based metrics unavailable when a horizon has no eligible entrants', () => {
    const followup = buildBusinessCustomerFollowup(context, [row(1, 'new@example.com', '2026-09-12')], '2026-09-12')
    for (const horizon of followup.horizons) {
      expect(horizon.metrics.cohort_customers.current.value).toBe(1)
      expect(horizon.metrics.eligible_customers.current.value).toBe(0)
      expect(horizon.metrics.repeat_rate.current).toMatchObject({
        value: null, availability: { state: 'unavailable' }, coverage: { state: 'complete', numerator: 0, denominator: 0 },
      })
      expect(horizon.metrics.repeat_booked_value_per_eligible_customer.current.value).toBeNull()
    }
  })

  it.each(['2026-02-30', '2026-09-18T00:00:00Z', 'invalid'])(
    'rejects invalid observation dates and conflicting IDs without leaking identity (%s)', observedThrough => {
      expect(() => buildBusinessCustomerFollowup(context, [], observedThrough)).toThrow('business_followup_observation_date_invalid')
      const original = row(1, 'private@example.com', '2026-09-10')
      expect(() => buildBusinessCustomerFollowup(context, [original, { ...original, price: 999 }], '2026-09-18'))
        .toThrow(/^outcome_conflicting_duplicate_id:1$/)
    },
  )

  it('is optional for legacy packets and validates exact horizon, metric, entity and cohort-window identities when present', () => {
    const rows = [row(1, 'new@example.com', '2026-09-10'), row(2, 'new@example.com', '2026-09-12')]
    const customers = buildBusinessCustomers(context, rows, '2026-09-18')
    expect(BusinessCustomersSchema.safeParse(customers.data).success).toBe(true)
    const unavailable = { state: 'unavailable' as const, data: null, asOf: null, notes: [] }
    const packet = (data: typeof customers.data) => ({ section: 'business' as const, context, notes: [], result: {
      state: 'partial' as const, asOf: context.asOf, notes: [], data: {
        ...buildBusinessReport(context, rows, []),
        intelligence: { customers: { ...customers, data }, leadTime: unavailable, upcoming: unavailable },
      },
    } })

    expect(validateReportingPacket(packet(customers.data)).section).toBe('business')
    const legacy = structuredClone(customers.data!)
    delete legacy.followup
    expect(validateReportingPacket(packet(legacy)).section).toBe('business')

    const malformed = structuredClone(customers.data!)
    malformed.followup!.horizons[0].metrics.repeat_rate.current.entity.id = 'account-db:customers'
    expect(() => validateReportingPacket(packet(malformed))).toThrow(/claim entity/i)

    const missingMetric = structuredClone(customers.data!)
    delete missingMetric.followup!.horizons[0].metrics.repeat_bookings
    expect(() => validateReportingPacket(packet(missingMetric))).toThrow(/follow-up metric/i)

    const duplicate = structuredClone(customers.data!)
    duplicate.followup!.horizons[1] = structuredClone(duplicate.followup!.horizons[0])
    expect(BusinessCustomersSchema.safeParse(duplicate).success).toBe(false)

    const wrongWindow = structuredClone(customers.data!)
    wrongWindow.followup!.horizons[0].metrics.repeat_rate.current.window.end = context.range.from
    expect(() => validateReportingPacket(packet(wrongWindow))).toThrow(/claim window/i)
  })
})
