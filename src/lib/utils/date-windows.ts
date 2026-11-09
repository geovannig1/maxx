import { nyToday, nyDaysAgo } from './date-utils'

export type DateWindow =
  | 'yesterday'
  | 'last_3_days'
  | 'last_7_days'
  | 'previous_7_days'
  | 'last_30_days'
  | 'month_to_date'

export interface DateRange {
  since: string
  until: string
}

/** Converts a named date window to an absolute since/until range (YYYY-MM-DD), in the account timezone (src/config/business-config.ts). */
export function resolveDateWindow(window: DateWindow): DateRange {
  switch (window) {
    case 'yesterday': {
      const d = nyDaysAgo(1)
      return { since: d, until: d }
    }
    case 'last_3_days':
      return { since: nyDaysAgo(3), until: nyDaysAgo(1) }
    case 'last_7_days':
      return { since: nyDaysAgo(7), until: nyDaysAgo(1) }
    case 'previous_7_days':
      return { since: nyDaysAgo(14), until: nyDaysAgo(8) }
    case 'last_30_days':
      return { since: nyDaysAgo(30), until: nyDaysAgo(1) }
    case 'month_to_date':
      return { since: nyToday().slice(0, 8) + '01', until: nyDaysAgo(1) }
    default:
      throw new Error(`Unknown date window: ${window}`)
  }
}

/** Returns true if the string is a valid DateWindow. */
export function isDateWindow(value: string): value is DateWindow {
  return ['yesterday', 'last_3_days', 'last_7_days', 'previous_7_days', 'last_30_days', 'month_to_date'].includes(value)
}
