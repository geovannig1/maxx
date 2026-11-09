import { isBookingLikeOutcome } from '@/config/outcome-nouns'

// Measures that exist only for a scheduled, time-bound outcome (a booking has a duration; an order or
// a lead does not). Screens drop them for a business whose outcome is not booking-like, so it never
// sees a "Recorded hours" tile that can only ever read unavailable or zero.
export const BOOKING_ONLY_METRIC_KEYS: ReadonlySet<string> = new Set([
  'recorded_booked_hours', 'hours_per_recorded_booking', 'duration_recorded_bookings', 'duration_coverage',
])

/** The field list as this business should see it: booking-only measures only when outcomes are bookings. */
export function visibleBusinessFields<T extends readonly [string, string]>(fields: ReadonlyArray<T>): T[] {
  return isBookingLikeOutcome() ? [...fields] : fields.filter(([key]) => !BOOKING_ONLY_METRIC_KEYS.has(key))
}
