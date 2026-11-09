import { format, parseISO } from 'date-fns'
import { accountTimezone } from '@/config/business-config'

// All "today/yesterday/window" math must be in the ACCOUNT timezone (NEXT_PUBLIC_ACCOUNT_TIMEZONE,
// see src/config/business-config.ts), not the server's UTC — otherwise sync windows, pacing, and learning drift
// by a day near midnight and across DST. The ny*/et* names are historical; they mean "account tz".
const ACCOUNT_TZ = accountTimezone()

/** Current date in the account timezone as YYYY-MM-DD. */
export function nyToday(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: ACCOUNT_TZ })
}

/** YYYY-MM-DD for `n` days before NY today (date-only arithmetic; tz-agnostic). */
export function nyDaysAgo(n: number): string {
  const d = new Date(nyToday() + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() - n)
  return d.toISOString().slice(0, 10)
}

/** Current hour (0-23) in the account timezone. */
export function nyHour(): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: ACCOUNT_TZ, hour: 'numeric', hour12: false }).formatToParts(new Date())
  return parseInt(parts.find((p) => p.type === 'hour')?.value ?? '0', 10) % 24
}

/** Current fractional hour-of-day (0-24) in the account timezone, for pacing math. */
export function nyHoursElapsed(): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: ACCOUNT_TZ, hour: 'numeric', minute: 'numeric', hour12: false }).formatToParts(new Date())
  const h = parseInt(parts.find((p) => p.type === 'hour')?.value ?? '0', 10) % 24
  const m = parseInt(parts.find((p) => p.type === 'minute')?.value ?? '0', 10)
  return h + m / 60
}

/** Day of week (0=Sun..6=Sat) in the account timezone. */
export function nyWeekday(): number {
  const wd = new Date().toLocaleDateString('en-US', { timeZone: ACCOUNT_TZ, weekday: 'short' }).slice(0, 3)
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(wd)
}

/** Day of week (0=Sun..6=Sat) for a YYYY-MM-DD date string (tz-agnostic). */
export function weekdayOf(dateStr: string): number {
  return new Date(dateStr + 'T00:00:00Z').getUTCDay()
}

/** ET calendar date (YYYY-MM-DD) of an absolute instant (offset-aware ISO string or Date).
 *  The input's own offset fixes the instant; we then render it in the account timezone. Used to
 *  map an source creation time (returned with its own offset) to the ET booking day that a given
 *  day's ad spend drove. Returns '' for an unparseable input. */
export function etDateOf(instant: string | Date): string {
  const d = typeof instant === 'string' ? new Date(instant) : instant
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-CA', { timeZone: ACCOUNT_TZ })
}

// (getDateRange/DatePreset removed — dead code with zero callers that duplicated date-windows.ts
// resolveDateWindow and date-range.ts resolveDatePreset; three parallel resolvers invited drift.)

export function formatDisplayDate(dateStr: string): string {
  return format(parseISO(dateStr), 'MMM d, yyyy')
}

export function formatShortDate(dateStr: string): string {
  return format(parseISO(dateStr), 'MMM d')
}

export function yesterday(): string {
  return nyDaysAgo(1)
}

/** UTC epoch ms for the final second of a YYYY-MM-DD day in the account timezone.
 *
 *  A YYYY-MM-DD is a WALL-CLOCK date, so turning it into an instant needs that date's UTC offset.
 *  Writing `${d}T23:59:59Z` instead labels a New York date with a UTC suffix, which lands 4-5h BEFORE
 *  the real end of the NY day — and from 20:00 ET until midnight that is behind the present moment, so
 *  anything synced "just now" measures as negative age. The offset is probed per date, so EDT and EST
 *  are both correct across the DST boundary. */
export function nyEndOfDayMs(dateStr: string): number {
  // 12:00Z is 07:00/08:00 ET year-round — far from both midnight boundaries, so the hour reads cleanly.
  const probe = new Date(`${dateStr}T12:00:00Z`)
  const etHour = Number(
    new Intl.DateTimeFormat('en-US', { timeZone: ACCOUNT_TZ, hour: 'numeric', hour12: false }).format(probe),
  )
  return Date.parse(`${dateStr}T23:59:59Z`) + (12 - etHour) * 3_600_000
}
