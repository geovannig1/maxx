import { describe, it, expect } from 'vitest'
import { weekdayOf, nyDaysAgo, nyEndOfDayMs, nyToday } from '@/lib/utils/date-utils'

const DAY_MS = 86_400_000
const asUtc = (d: string) => Date.parse(d + 'T00:00:00Z')

describe('weekdayOf', () => {
  it('returns 0=Sunday..6=Saturday for a known date', () => {
    expect(weekdayOf('2026-06-26')).toBe(5) // Friday
    expect(weekdayOf('2026-06-27')).toBe(6) // Saturday
    expect(weekdayOf('2026-06-28')).toBe(0) // Sunday
  })
})

describe('nyDaysAgo', () => {
  it('returns YYYY-MM-DD format', () => {
    expect(nyDaysAgo(0)).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('is exactly N calendar days before today (NY)', () => {
    const gap = (asUtc(nyToday()) - asUtc(nyDaysAgo(7))) / DAY_MS
    expect(gap).toBe(7)
  })

  it('nyDaysAgo(0) equals nyToday()', () => {
    expect(nyDaysAgo(0)).toBe(nyToday())
  })
})

describe('nyEndOfDayMs', () => {
  // A YYYY-MM-DD is a wall-clock date. `${d}T23:59:59Z` labels a New York date with a UTC suffix,
  // landing 4-5h before the real end of the NY day — and during NY evening, before the present moment.
  it('resolves the final second of the NY day, not of the UTC day', () => {
    // EDT (UTC-4): 23:59:59 ET on Aug 18 is 03:59:59Z on Aug 19.
    expect(nyEndOfDayMs('2026-08-18')).toBe(Date.parse('2026-08-19T03:59:59Z'))
    // EST (UTC-5): 23:59:59 ET on Jan 15 is 04:59:59Z on Jan 16.
    expect(nyEndOfDayMs('2026-01-15')).toBe(Date.parse('2026-01-16T04:59:59Z'))
  })

  it('is never behind an instant that falls inside that NY day', () => {
    // 22:12 ET on Aug 18 — the window where the old UTC-suffixed literal went negative.
    expect(nyEndOfDayMs('2026-08-18')).toBeGreaterThan(Date.parse('2026-08-19T02:12:00Z'))
  })

  it('stays correct across the DST boundary', () => {
    // 2026-11-01 is the US fall-back day: the NY day runs 25 hours and ends on EST (UTC-5), so the
    // final second is 04:59:59Z on Nov 2 — an hour later than the EDT-based answer would be.
    expect(nyEndOfDayMs('2026-11-01')).toBe(Date.parse('2026-11-02T04:59:59Z'))
  })
})
