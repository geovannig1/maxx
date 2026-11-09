import { describe, it, expect } from 'vitest'
import { aggregateBusinessFacts, classifyBusinessState, type LedgerAppointmentLite } from '@/lib/outcomes/adapters/acuity/business-facts'
import { buildAcuityCapiEvent } from '@/lib/capi/acuity-capi'
import { reconcileAppointment, summarizeReconciliation, type AppointmentReconciliationInput } from '@/lib/outcomes/adapters/acuity/value-reconciliation'

// Golden semantics frozen BEFORE the v1.0.0 generic-outcomes refactor.
// Every later phase must reproduce these snapshots exactly. If a snapshot changes, the change is a
// deliberate, reviewed semantic decision recorded in ADR-058 — never an `-u` to make CI green.

const PRICES = [null, 0, 0.005, 125, 129.99] as const
const PAID = [undefined, null, 0, 50, 125] as const
const CANCELED = [null, false, true] as const
const ORIGINS = [undefined, null, 'website', 'staff_or_manual', 'origin_unknown'] as const

function population(): LedgerAppointmentLite[] {
  const rows: LedgerAppointmentLite[] = []
  let id = 1
  for (const price of PRICES) for (const amount_paid of PAID) for (const canceled of CANCELED) for (const origin of ORIGINS) {
    rows.push({ id: id++, price, amount_paid, canceled, web_origin_state: origin as LedgerAppointmentLite['web_origin_state'] })
  }
  return rows
}

describe('golden: business facts aggregation', () => {
  const rows = population()

  it('has the expected combinatorial population (control)', () => {
    expect(rows).toHaveLength(PRICES.length * PAID.length * CANCELED.length * ORIGINS.length)
  })

  it('classifies every row identically', () => {
    expect(rows.map((r) => `${r.id}:${classifyBusinessState(r)}`).join(',')).toMatchSnapshot()
  })

  it('aggregates the full population identically', () => {
    expect(aggregateBusinessFacts(rows)).toMatchSnapshot()
  })

  it('aggregates each slice identically (revenue completeness flips per slice)', () => {
    const slices = {
      empty: [],
      allPaidRecorded: rows.filter((r) => r.amount_paid != null),
      onlyActive: rows.filter((r) => !r.canceled),
      onlyCanceled: rows.filter((r) => r.canceled),
      zeroPriceOnly: rows.filter((r) => r.price === 0),
      explicitStateOverride: rows.slice(0, 20).map((r, i) => ({ ...r, business_state: (['active_value_bearing', 'active_zero_value', 'canceled'] as const)[i % 3] })),
    }
    expect(Object.fromEntries(Object.entries(slices).map(([k, v]) => [k, aggregateBusinessFacts(v)]))).toMatchSnapshot()
  })
})

describe('golden: conversions event built from a booking', () => {
  const NOW = Date.parse('2026-06-15T12:00:00.000Z')
  const created = (hoursAgo: number) => new Date(NOW - hoursAgo * 3_600_000).toISOString()
  const base = {
    id: 9001, firstName: ' Taylor ', lastName: 'Example', email: 'Customer.Fixture@Example.test', phone: '+1 (555) 555-0100',
    datetime: '2026-06-20T15:00:00-0400', datetimeCreated: created(2), price: '125.00', amountPaid: '0.00', type: 'Studio rental',
    appointmentTypeID: 7, scheduledBy: null,
  }
  // Every golden booking is a USD outcome: the event carries the outcome's own currency.
  const cases: Record<string, [Record<string, unknown>, Omit<Parameters<typeof buildAcuityCapiEvent>[1], 'currency'>]> = {
    happyPath: [base, { nowMs: NOW }],
    withFbpAndTouch: [base, { nowMs: NOW, fbp: 'fb.1.1700000000000.123', paidTouch: { fbclid: 'IwAR-fixture', observedAt: created(30) } }],
    touchAfterBookingIgnored: [base, { nowMs: NOW, paidTouch: { fbclid: 'IwAR-fixture', observedAt: created(1) } }],
    testEventCode: [base, { nowMs: NOW, testEventCode: 'TEST123' }],
    staffCreated: [{ ...base, scheduledBy: 'staff@example.test' }, { nowMs: NOW }],
    originUnknown: [Object.fromEntries(Object.entries(base).filter(([k]) => k !== 'scheduledBy')), { nowMs: NOW }],
    expired: [{ ...base, datetimeCreated: created(24 * 8) }, { nowMs: NOW }],
    futureSkewCapped: [{ ...base, datetimeCreated: new Date(NOW + 600_000).toISOString() }, { nowMs: NOW }],
    noId: [{ ...base, id: '' }, { nowMs: NOW }],
    zeroPrice: [{ ...base, price: '0.00' }, { nowMs: NOW }],
    unparseablePrice: [{ ...base, price: 'n/a' }, { nowMs: NOW }],
    noContact: [{ ...base, email: null, phone: null, firstName: null, lastName: null }, { nowMs: NOW }],
  }
  for (const [name, [appt, opts]] of Object.entries(cases)) {
    it(`builds "${name}" identically`, () => {
      expect(buildAcuityCapiEvent(appt as never, { currency: 'USD', ...opts })).toMatchSnapshot()
    })
  }
})

describe('golden: value reconciliation', () => {
  const T = Date.parse('2026-06-01T00:00:00.000Z')
  const obs = (kind: string, atMs: number, oldPrice: number | null, newPrice: number | null, oldCanceled: boolean | null, newCanceled: boolean | null) =>
    ({ changeKind: kind, observedAtMs: atMs, oldPrice, newPrice, oldCanceled, newCanceled })
  const inputs: AppointmentReconciliationInput[] = []
  let id = 1
  for (const initialProvenance of ['observed', 'migration_snapshot', null] as const)
    for (const capi of [null, T + 1000] as const)
      for (const capiAttempted of [false, true])
        for (const modeledDiffers of [false, true])
          for (const observations of [
            [],
            [obs('first_observation', T, null, 125, null, false)],
            [obs('first_observation', T, null, 125, null, false), obs('price_change', T + 5000, 125, 90, false, false)],
            [obs('price_change', T + 500, 125, 140, false, false)],
            [obs('status_change', T + 9000, 125, 125, false, true)],
            [obs('price_and_status_change', T + 9000, 125, 0, false, true)],
          ])
            inputs.push({ appointmentId: id++, initialProvenance, capiAcceptedAtMs: capi, capiAttempted, modeledDiffers, observations })

  it('classifies every case identically', () => {
    const results = inputs.map(reconcileAppointment)
    expect(results).toMatchSnapshot()
    expect(summarizeReconciliation(results)).toMatchSnapshot()
  })
})
