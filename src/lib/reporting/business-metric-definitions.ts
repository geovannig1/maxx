import { outcomeWords } from '@/config/outcome-nouns'
import { BUSINESS_DRIVER_DEFINITIONS } from './business-driver-definitions'

const OW = outcomeWords()

/** Canonical account measures shared by native construction and browser-safe interpretation. */
export const BUSINESS_ACCOUNT_METRIC_DEFINITIONS = {
  paid_bookings: { key: 'paid_bookings', label: `Paid ${OW.many}`, unit: 'count',
    definition: `Unique active ${OW.many} with a valid recorded collected value greater than zero. Partial payment coverage makes this an observed lower bound.` },
  amount_paid: { key: 'amount_paid', label: 'Amount paid', unit: 'money',
    definition: `Sum of valid recorded collected value values on unique active ${OW.many}. Partial payment coverage makes this an observed lower bound; it does not establish processor settlement.` },
  active_appointments: { key: 'active_appointments', label: `Active ${OW.many}`, unit: 'count',
    definition: `Unique active ${OW.many}, including positive-price and zero-price ${OW.many}.` },
  booked_value: { key: 'booked_value', label: 'Booked value', unit: 'money', definition: BUSINESS_DRIVER_DEFINITIONS.booked_value },
} as const
