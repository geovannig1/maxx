import { outcomeWords } from '@/config/outcome-nouns'

const OW = outcomeWords()
const recorded = `Active positive-price ${OW.many} with a valid positive whole-minute duration recorded in the current source payload. Current stored schedule, not the originally scheduled hours, attendance or available capacity. No catalog, padding, add-on or price-based reconstruction.`

/** Exact native definitions shared by source construction and driver interpretation. */
export const BUSINESS_DRIVER_DEFINITIONS = {
  value_bearing_bookings: `Unique active ${OW.many} classified by the canonical outcome business classifier as price greater than zero.`,
  booked_value: `Scheduled price summed over unique active value-bearing ${OW.many}; distinct from recorded collected value.`,
  recorded_booked_hours: `Sum of recorded ${OW.one} duration minutes divided by 60. Missing duration leaves an observed subtotal. ${recorded}`,
  hours_per_recorded_booking: `Recorded hours divided by the count of ${OW.many} with usable duration, not all ${OW.many}. ${recorded}`,
  duration_recorded_bookings: `Count of ${OW.many} with usable duration. ${recorded}`,
  duration_coverage: `${OW.Many} with usable duration divided by all active positive-price ${OW.many} in the retained cohort, multiplied by 100. ${recorded}`,
} as const
