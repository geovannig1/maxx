import { describe, expect, it } from 'vitest'
import { assembleAttributionLadder, assembleDeliverySeries } from '@/lib/cockpit/series-loader'

const RANGE = {
  start: '2026-08-01', end: '2026-08-05',
  basis: 'closed_account_days' as const, timezone: 'America/New_York' as const,
}

describe('delivery series assembly', () => {
  it('produces a validated series whose coverage reconciles to the window', () => {
    const series = assembleDeliverySeries({
      metric: 'spend', range: RANGE, asOf: '2026-08-06T12:00:00.000Z', metaAccountId: 'act_123',
      inputs: {
        rows: [{ date: '2026-08-01', value: 100 }, { date: '2026-08-05', value: 60 }],
        attempts: [{ dateRangeStart: '2026-08-01', dateRangeEnd: '2026-08-03', status: 'success' }],
      },
    })
    expect(series.coverage).toEqual({ totalDays: 5, measuredDays: 2, noDeliveryDays: 2, notSyncedDays: 1 })
    expect(series.points.map((p) => p.state)).toEqual([
      'measured', 'missing_no_delivery', 'missing_no_delivery', 'missing_not_synced', 'measured',
    ])
    expect(Object.isFrozen(series)).toBe(true)
  })

  it('labels platform-modelled results as modelled and spend as measured', () => {
    const inputs = { rows: [], attempts: [] }
    const common = { range: RANGE, asOf: '2026-08-06T12:00:00.000Z', metaAccountId: 'act_123', inputs }
    expect(assembleDeliverySeries({ ...common, metric: 'spend' }).measurementKind).toBe('measured')
    expect(assembleDeliverySeries({ ...common, metric: 'results' }).measurementKind).toBe('modelled')
  })
})

describe('attribution ladder assembly', () => {
  const bookings = [
    { id: 'a', business_state: 'active_value_bearing', price: 500, amount_paid: 450 },
    { id: 'b', business_state: 'active_value_bearing', price: 300, amount_paid: 300 },
    { id: 'c', business_state: 'active_zero_value', price: 0, amount_paid: 0 },
    { id: 'd', business_state: 'canceled', price: 900, amount_paid: 900 },
  ]
  const appointments = [
    { id: 'a', utm_source: 'fb', fbclid: 'abc' },
    { id: 'b', utm_source: 'fb', fbclid: null },
    { id: 'c', utm_source: 'fb', fbclid: 'zzz' },
    { id: 'd', utm_source: 'fb', fbclid: 'yyy' },
  ]

  it('folds rows into a nested ladder over the value-bearing population', () => {
    const ladder = assembleAttributionLadder({
      bookings, appointments, linkedAppointmentIds: ['a'],
      delivery: [{ bookings: 3, bookings_view_through: 2, appointment_value: 0, appointment_value_view_through: null }, { bookings: 1, bookings_view_through: 1, appointment_value: 0, appointment_value_view_through: null }],
    })
    expect(ladder.rungs.map((r) => r.count)).toEqual([2, 2, 1, 1])
    expect(ladder.zeroValueBookings).toBe(1)
    expect(ladder.money.bookedValue).toBe(800)
    expect(ladder.meta.results).toBe(4)
    expect(ladder.meta.viewThrough).toBe(3)
    expect(ladder.meta.clickImplied).toBe(1)
  })

  // Regression: rungs once mixed populations — rung 1 counted value-bearing bookings while the
  // lower rungs counted every non-cancelled appointment. A zero-value or cancelled booking
  // carrying a utm tag could then push a lower rung above a higher one. Live data happened to
  // nest; the shape did not guarantee it.
  it('never lets a zero-value or cancelled booking inflate a lower rung', () => {
    const ladder = assembleAttributionLadder({
      bookings: [
        { id: 'a', business_state: 'active_value_bearing', price: 500, amount_paid: 500 },
        { id: 'z1', business_state: 'active_zero_value', price: 0, amount_paid: 0 },
        { id: 'z2', business_state: 'active_zero_value', price: 0, amount_paid: 0 },
        { id: 'x', business_state: 'canceled', price: 100, amount_paid: 100 },
      ],
      // Every zero-value and cancelled booking carries a paid signal and a link.
      appointments: [
        { id: 'a', utm_source: null, fbclid: null },
        { id: 'z1', utm_source: 'fb', fbclid: 'k1' },
        { id: 'z2', utm_source: 'fb', fbclid: 'k2' },
        { id: 'x', utm_source: 'fb', fbclid: 'k3' },
      ],
      linkedAppointmentIds: ['z1', 'z2', 'x'],
      delivery: [],
    })
    expect(ladder.rungs.map((r) => r.count)).toEqual([1, 0, 0, 0])
  })

  it('counts a paid touch only when it belongs to a booking inside the window', () => {
    const ladder = assembleAttributionLadder({
      bookings: [{ id: 'a', business_state: 'active_value_bearing', price: 100, amount_paid: 100 }],
      appointments: [{ id: 'a', utm_source: 'fb', fbclid: 'abc' }],
      // A link for an appointment outside this window must not be counted.
      linkedAppointmentIds: ['a', 'out-of-window'],
      delivery: [],
    })
    expect(ladder.rungs.at(-1)!.count).toBe(1)
  })

  // The rule the money-surface contracts insist on.
  it('treats a missing checkout amount as unknown, not as zero', () => {
    const ladder = assembleAttributionLadder({
      bookings: [
        { id: 'a', business_state: 'active_value_bearing', price: 500, amount_paid: 450 },
        { id: 'b', business_state: 'active_value_bearing', price: 300, amount_paid: null },
      ],
      appointments: [], linkedAppointmentIds: [], delivery: [],
    })
    expect(ladder.money.collectedAmount).toBe(450)
    expect(ladder.money.collectedIsLowerBound).toBe(true)
    expect(ladder.money.amountPaidCoverage).toEqual({ known: 1, total: 2 })
  })

  it('reports no view-through split when Meta never supplied one', () => {
    const ladder = assembleAttributionLadder({
      bookings: [], appointments: [], linkedAppointmentIds: [],
      delivery: [{ bookings: 5, bookings_view_through: null, appointment_value: 0, appointment_value_view_through: null }],
    })
    expect(ladder.meta.viewThrough).toBeNull()
    expect(ladder.meta.clickImplied).toBeNull()
    expect(ladder.meta.viewThroughIsFloor).toBe(true)
  })

  it('marks a partial view-through split as a floor', () => {
    const ladder = assembleAttributionLadder({
      bookings: [], appointments: [], linkedAppointmentIds: [],
      delivery: [{ bookings: 4, bookings_view_through: 2, appointment_value: 0, appointment_value_view_through: null }, { bookings: 2, bookings_view_through: null, appointment_value: 0, appointment_value_view_through: null }],
    })
    expect(ladder.meta.viewThrough).toBe(2)
    expect(ladder.meta.viewThroughIsFloor).toBe(true)
  })

  it('survives an empty window without inventing numbers', () => {
    const ladder = assembleAttributionLadder({ bookings: [], appointments: [], linkedAppointmentIds: [], delivery: [] })
    expect(ladder.rungs.map((r) => r.count)).toEqual([0, 0, 0, 0])
    expect(ladder.meta.viewThrough).toBeNull()
    expect(ladder.money.collectedIsLowerBound).toBe(false)
  })

  // THE WIRING, not the pure function. buildAttributionLadder having a value split proves nothing
  // if the loader never reads the columns into it — exactly the "produced and never consumed"
  // defect caught in review, where two unit tests passed while production did the old
  // thing. These assert through assembleAttributionLadder, the real caller.
  it('sums the value split out of the delivery rows', () => {
    const ladder = assembleAttributionLadder({
      bookings: [], appointments: [], linkedAppointmentIds: [],
      delivery: [
        { bookings: 13, bookings_view_through: 8, appointment_value: 2300, appointment_value_view_through: 1500 },
        { bookings: 9, bookings_view_through: 4, appointment_value: 1500, appointment_value_view_through: 856 },
      ],
    })
    expect(ladder.meta.valueAmount).toBe(3800)
    expect(ladder.meta.viewThroughValue).toBe(2356)
    expect(ladder.meta.clickImpliedValue).toBe(1444)
  })

  it('tracks the value split reported-flag separately from the count split', () => {
    // Meta can break RESULTS out by window on a day it does not break VALUE out. Borrowing the
    // count's flag would assert a $0.00 view-through share that was never measured — the same
    // NULL-vs-0 laundering the `appointment_value_view_through` column comment documents.
    const ladder = assembleAttributionLadder({
      bookings: [], appointments: [], linkedAppointmentIds: [],
      delivery: [{ bookings: 9, bookings_view_through: 4, appointment_value: 1500, appointment_value_view_through: null }],
    })
    expect(ladder.meta.viewThrough).toBe(4)            // count split WAS reported
    expect(ladder.meta.valueAmount).toBe(1500)
    expect(ladder.meta.viewThroughValue).toBeNull() // value split was NOT — and stays null
    expect(ladder.meta.clickImpliedValue).toBeNull()
  })
})
