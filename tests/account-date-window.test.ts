import { describe, expect, it } from 'vitest'
import {
  accountDateRangeToHalfOpenInstants,
  accountDateStartInstant,
  inclusiveAccountDates,
} from '@/lib/economics/account-date-window'

describe('America/New_York economics windows', () => {
  it('resolves local midnight without assuming a fixed UTC offset', () => {
    expect(accountDateStartInstant('2026-01-15')).toBe('2026-01-15T05:00:00.000Z')
    expect(accountDateStartInstant('2026-07-15')).toBe('2026-07-15T04:00:00.000Z')
  })

  it('preserves 23-hour and 25-hour daylight-saving transition days', () => {
    expect(accountDateRangeToHalfOpenInstants({ start: '2026-03-08', end: '2026-03-08' }))
      .toEqual({ start: '2026-03-08T05:00:00.000Z', end: '2026-03-09T04:00:00.000Z' })
    expect(accountDateRangeToHalfOpenInstants({ start: '2026-11-01', end: '2026-11-01' }))
      .toEqual({ start: '2026-11-01T04:00:00.000Z', end: '2026-11-02T05:00:00.000Z' })
  })

  it('enumerates an exact inclusive account-date window', () => {
    expect(inclusiveAccountDates('2026-07-30', '2026-08-02'))
      .toEqual(['2026-07-30', '2026-07-31', '2026-08-01', '2026-08-02'])
    expect(() => inclusiveAccountDates('2026-08-02', '2026-08-01')).toThrow(/start follows end/i)
  })
})
