import { describe, expect, it } from 'vitest'
import { parseExactDecimal, parseIsoInstant, startOfDayIn } from '@/lib/outcomes/adapters/csv/values'

describe('parseExactDecimal', () => {
  it('reads an empty cell as NULL (not observed), never 0', () => {
    expect(parseExactDecimal('')).toEqual({ ok: true, value: null })
    expect(parseExactDecimal('   ')).toEqual({ ok: true, value: null })
  })

  it('reads "0" as an observed zero, distinct from empty', () => {
    expect(parseExactDecimal('0')).toEqual({ ok: true, value: '0' })
    expect(parseExactDecimal('0.00')).toEqual({ ok: true, value: '0' })
  })

  it.each([
    ['120', '120'], ['120.5', '120.5'], ['120.50', '120.5'], ['120.00', '120'], ['0.010', '0.01'],
    ['999999999999999.999999', '999999999999999.999999'], [' 42.10 ', '42.1'],
  ])('keeps %s exact as the canonical string %s', (raw, value) => {
    expect(parseExactDecimal(raw)).toEqual({ ok: true, value })
  })

  it.each([
    ['1,200.00', 'decimal_separator'], ['1.200,50', 'decimal_separator'], ['1,5', 'decimal_separator'],
    ['1 200', 'decimal_separator'], ["1'200", 'decimal_separator'], ['1_200', 'decimal_separator'],
    ['-5', 'decimal_negative'], ['-0.01', 'decimal_negative'],
    ['1.1234567', 'decimal_too_precise'], ['1234567890123456', 'decimal_too_large'],
    ['$120', 'decimal_invalid'], ['120 USD', 'decimal_invalid'], ['+5', 'decimal_invalid'], ['1e3', 'decimal_invalid'],
    ['.5', 'decimal_invalid'], ['5.', 'decimal_invalid'], ['007', 'decimal_invalid'], ['1.2.3', 'decimal_invalid'],
    ['NaN', 'decimal_invalid'], ['Infinity', 'decimal_invalid'],
  ])('refuses %s with %s', (raw, code) => {
    expect(parseExactDecimal(raw)).toEqual({ ok: false, code })
  })

  // Property: every decimal written as integer digits + up to 6 fraction digits survives exactly,
  // including values a JavaScript number cannot hold (no float conversion happens anywhere).
  it('round-trips 2,000 random decimals without rounding', () => {
    let s = 7
    const rand = (n: number) => { s = (s * 48271) % 2147483647; return s % n }
    for (let i = 0; i < 2000; i++) {
      const int = rand(10) === 0 ? '0' : String(1 + rand(10 ** 9)) + (rand(2) ? String(rand(10 ** 6)).padStart(6, '0') : '')
      const fracLen = rand(7)
      const frac = Array.from({ length: fracLen }, () => String(rand(10))).join('')
      const raw = fracLen ? `${int}.${frac}` : int
      const result = parseExactDecimal(raw)
      expect(result.ok, raw).toBe(true)
      const value = (result as { value: string }).value
      const expected = frac.replace(/0+$/, '') ? `${int}.${frac.replace(/0+$/, '')}` : int
      expect(value, raw).toBe(expected)
    }
  })
})

describe('parseIsoInstant', () => {
  const NY = 'America/New_York'

  it('reads an empty cell as NULL', () => {
    expect(parseIsoInstant('', NY)).toEqual({ ok: true, value: null, dateOnly: false })
  })

  it('reads a full timestamp with Z or an offset as that instant, in any business timezone', () => {
    expect(parseIsoInstant('2026-03-08T14:30:00Z', NY)).toEqual({ ok: true, value: '2026-03-08T14:30:00.000Z', dateOnly: false })
    expect(parseIsoInstant('2026-03-08T14:30-05:00', 'Asia/Tokyo')).toEqual({ ok: true, value: '2026-03-08T19:30:00.000Z', dateOnly: false })
    expect(parseIsoInstant('2026-03-08T14:30:00.123+05:30', NY)).toEqual({ ok: true, value: '2026-03-08T09:00:00.123Z', dateOnly: false })
  })

  it('reads a date-only value as the start of that day in the business timezone', () => {
    expect(parseIsoInstant('2026-07-01', NY)).toEqual({ ok: true, value: '2026-07-01T04:00:00.000Z', dateOnly: true })
    expect(parseIsoInstant('2026-01-01', NY)).toEqual({ ok: true, value: '2026-01-01T05:00:00.000Z', dateOnly: true })
    expect(parseIsoInstant('2026-07-01', 'Europe/Berlin')).toEqual({ ok: true, value: '2026-06-30T22:00:00.000Z', dateOnly: true })
    expect(parseIsoInstant('2026-07-01', 'UTC')).toEqual({ ok: true, value: '2026-07-01T00:00:00.000Z', dateOnly: true })
  })

  it('handles the DST change days: the day starts at local midnight on both sides', () => {
    // New York springs forward 2026-03-08 02:00 and falls back 2026-11-01 02:00.
    expect(parseIsoInstant('2026-03-08', NY)).toMatchObject({ value: '2026-03-08T05:00:00.000Z' })
    expect(parseIsoInstant('2026-03-09', NY)).toMatchObject({ value: '2026-03-09T04:00:00.000Z' })
    expect(parseIsoInstant('2026-11-01', NY)).toMatchObject({ value: '2026-11-01T04:00:00.000Z' })
    expect(parseIsoInstant('2026-11-02', NY)).toMatchObject({ value: '2026-11-02T05:00:00.000Z' })
  })

  it('uses the first instant of the day where local midnight does not exist', () => {
    // America/Santiago springs forward at local midnight (00:00 -> 01:00) on 2026-09-06.
    const start = startOfDayIn('2026-09-06', 'America/Santiago')
    const local = new Date(start).toLocaleString('en-CA', { timeZone: 'America/Santiago', hourCycle: 'h23' })
    expect(local).toMatch(/^2026-09-06, 01:00:00/)
    expect(new Date(new Date(start).getTime() - 60_000).toLocaleDateString('en-CA', { timeZone: 'America/Santiago' })).toBe('2026-09-05')
  })

  it('keeps a 23:30 local date-time on its own business date', () => {
    const r = parseIsoInstant('2026-07-01T23:30:00-04:00', NY)
    expect(r).toMatchObject({ ok: true, value: '2026-07-02T03:30:00.000Z' })
  })

  it.each([
    ['2026-03-08T14:30:00', 'datetime_missing_offset'],
    ['2026-03-08T14:30', 'datetime_missing_offset'],
    ['2026-03-08 14:30:00Z', 'date_invalid'],
    ['03/08/2026', 'date_invalid'],
    ['08/03/2026', 'date_invalid'],
    ['2026-3-8', 'date_invalid'],
    ['2026-02-30', 'date_invalid'],
    ['2026-13-01', 'date_invalid'],
    ['2026-03-08T24:00:00Z', 'date_invalid'],
    ['2026-03-08T14:60:00Z', 'date_invalid'],
    ['2026-03-08T14:30:00.1234Z', 'date_invalid'],
    ['2026-03-08T14:30:00+25:00', 'date_invalid'],
    ['1773000000', 'date_invalid'],
  ])('refuses %s with %s', (raw, code) => {
    expect(parseIsoInstant(raw, NY)).toEqual({ ok: false, code })
  })
})
