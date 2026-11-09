import { describe, it, expect } from 'vitest'
import { computeAccountBookingsRollup } from '@/lib/sync/upsert-insights'

// Meta returns no indicator-named `results` at ACCOUNT level, so account rows sync bookings=0 while
// campaign rows carry the real count (observed: account=0 while campaign, adset and ad rows each carried the count) —
// and every account-level reader (account summary, daily/weekly reports) showed 0 to the owner.

describe('computeAccountBookingsRollup', () => {
  it('raises the account row to the campaign-level sum for the same date', () => {
    const updates = computeAccountBookingsRollup(
      [{ id: 'a1', date_start: '2026-07-11', spend: 100, leads: 0, bookings: 0, appointment_value: null }],
      [
        { date_start: '2026-07-11', leads: 2, bookings: 2, appointment_value: 125 },
        { date_start: '2026-07-11', leads: 1, bookings: 1, appointment_value: 0 },
      ],
    )
    expect(updates).toEqual([{ id: 'a1', leads: 3, bookings: 3, appointment_value: 125, cost_per_lead: 100 / 3, cost_per_booking: 100 / 3, bookings_view_through: null, appointment_value_view_through: null }])
  })

  it('uses campaign leads when account actions omit them even if bookings do not need raising', () => {
    expect(computeAccountBookingsRollup(
      [{ id: 'a1', date_start: '2026-07-15', spend: 60, leads: 0, bookings: 1, appointment_value: 300 }],
      [{ date_start: '2026-07-15', leads: 3, bookings: 1, appointment_value: 300, bookings_view_through: 0, appointment_value_view_through: null }],
    )).toEqual([{
      id: 'a1', leads: 3, bookings: 1, appointment_value: 300,
      cost_per_lead: 20, cost_per_booking: 60, bookings_view_through: 0, appointment_value_view_through: null,
    }])
  })

  it('raises bookings_view_through with the campaign sum (null-aware: all-null stays null)', () => {
    const updates = computeAccountBookingsRollup(
      [{ id: 'a1', date_start: '2026-07-15', spend: 64, leads: 0, bookings: 0, appointment_value: null }],
      [
        { date_start: '2026-07-15', leads: 0, bookings: 2, appointment_value: null, bookings_view_through: 2 },
        { date_start: '2026-07-15', leads: 0, bookings: 1, appointment_value: null, bookings_view_through: 1 },
      ],
    )
    expect(updates[0].bookings_view_through).toBe(3)
    // Mixed known/unknown remains unavailable; the unknown booking cannot be relabelled click-through.
    const mixed = computeAccountBookingsRollup(
      [{ id: 'a1', date_start: '2026-07-15', spend: 64, leads: 0, bookings: 0, appointment_value: null }],
      [
        { date_start: '2026-07-15', leads: 0, bookings: 2, appointment_value: null, bookings_view_through: 2 },
        { date_start: '2026-07-15', leads: 0, bookings: 1, appointment_value: null, bookings_view_through: null },
      ],
    )
    expect(mixed[0].bookings_view_through).toBeNull()
  })

  it('keeps modeled value unavailable when any booking-bearing campaign has no value split', () => {
    const updates = computeAccountBookingsRollup(
      [{ id: 'a1', date_start: '2026-07-15', spend: 64, leads: 0, bookings: 0, appointment_value: null }],
      [
        { date_start: '2026-07-15', leads: 0, bookings: 2, appointment_value: 200, bookings_view_through: 1 },
        { date_start: '2026-07-15', leads: 0, bookings: 1, appointment_value: null, bookings_view_through: 0 },
      ],
    )
    expect(updates[0].appointment_value).toBeNull()
  })

  it('uses campaign outcomes as authority even when an account-level action aggregate is higher', () => {
    expect(
      computeAccountBookingsRollup(
        [{ id: 'a1', date_start: '2026-07-11', spend: 100, leads: 4, bookings: 3, appointment_value: 200 }],
        [{ date_start: '2026-07-11', leads: 3, bookings: 2, appointment_value: 125 }],
      ),
    ).toEqual([{
      id: 'a1', leads: 3, bookings: 2, appointment_value: 125,
      cost_per_lead: 100 / 3, cost_per_booking: 50, bookings_view_through: null, appointment_value_view_through: null,
    }])
  })

  it('leaves dates with no campaign rows untouched and handles zero spend', () => {
    const updates = computeAccountBookingsRollup(
      [
        { id: 'a1', date_start: '2026-07-10', spend: 0, leads: 0, bookings: 0, appointment_value: null },
        { id: 'a2', date_start: '2026-07-11', spend: 0, leads: 0, bookings: 0, appointment_value: null },
      ],
      [{ date_start: '2026-07-11', leads: 0, bookings: 2, appointment_value: 0 }],
    )
    expect(updates).toEqual([{ id: 'a2', leads: 0, bookings: 2, appointment_value: 0, cost_per_lead: null, cost_per_booking: null, bookings_view_through: null, appointment_value_view_through: null }])
  })
})
