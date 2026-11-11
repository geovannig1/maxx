import { describe, expect, it } from 'vitest'
import { DEFAULT_OUTCOME_MONEY_CEILING, exceedsOutcomeMoneyCeiling } from '@/lib/outcomes/money-ceiling'

// Webhook and CSV money arrives as an exact decimal string (up to 15 integer and 6 fraction digits). The
// ceiling check compared it as a JS number, so a value a few millionths above a large ceiling rounded
// down onto it and passed. A decimal string is now compared exactly, digit by digit, never via float.

describe('outcome money ceiling compares decimal strings exactly', () => {
  const env = (ceiling?: string) => ({ OUTCOME_MONEY_CEILING: ceiling })

  it('refuses a value one millionth above a 15-digit ceiling, accepts the ceiling itself', () => {
    const ceiling = '999999999999999'
    expect(Number('999999999999999.000001')).toBe(999999999999999) // precondition: a double cannot tell them apart
    expect(exceedsOutcomeMoneyCeiling('999999999999999.000001', env(ceiling))).toBe(true)
    expect(exceedsOutcomeMoneyCeiling('999999999999999', env(ceiling))).toBe(false)
    expect(exceedsOutcomeMoneyCeiling('999999999999999.000000', env(ceiling))).toBe(false)
    expect(exceedsOutcomeMoneyCeiling('999999999999998.999999', env(ceiling))).toBe(false)
  })

  it('compares fractional ceilings and values of different lengths exactly', () => {
    expect(exceedsOutcomeMoneyCeiling('100.000001', env('100'))).toBe(true)
    expect(exceedsOutcomeMoneyCeiling('100.10', env('100.1'))).toBe(false)
    expect(exceedsOutcomeMoneyCeiling('100.100001', env('100.1'))).toBe(true)
    expect(exceedsOutcomeMoneyCeiling('99.999999', env('100'))).toBe(false)
    expect(exceedsOutcomeMoneyCeiling('1000', env('999.999999'))).toBe(true)
    expect(exceedsOutcomeMoneyCeiling('0', env('100'))).toBe(false)
  })

  it('keeps the default and the fallbacks (controls)', () => {
    expect(exceedsOutcomeMoneyCeiling(String(DEFAULT_OUTCOME_MONEY_CEILING), env())).toBe(false)
    expect(exceedsOutcomeMoneyCeiling('1000000000.000001', env())).toBe(true)
    // An unusable setting falls back to the default rather than lifting the ceiling.
    expect(exceedsOutcomeMoneyCeiling('1000000000.000001', env('-5'))).toBe(true)
    expect(exceedsOutcomeMoneyCeiling('1000000000.000001', env('lots'))).toBe(true)
    // An exponent setting still works.
    expect(exceedsOutcomeMoneyCeiling('1000.000001', env('1e3'))).toBe(true)
    expect(exceedsOutcomeMoneyCeiling('999', env('1e3'))).toBe(false)
    // A small exponent setting is a usable ceiling: it must not fall back to the default and lift it.
    expect(exceedsOutcomeMoneyCeiling('0.5', env('1e-7'))).toBe(true)
    expect(exceedsOutcomeMoneyCeiling('0.0000001', env('1e-7'))).toBe(false)
    expect(exceedsOutcomeMoneyCeiling('0.00000011', env('1.0e-7'))).toBe(true)
    // An exponent that overflows to Infinity is unusable: the default holds, it does not become a huge ceiling.
    expect(exceedsOutcomeMoneyCeiling('1000000000.5', env('1e400'))).toBe(true)
    // Numbers (already parsed by the reference adapter) and absent values are unchanged.
    expect(exceedsOutcomeMoneyCeiling(1500, env('1000'))).toBe(true)
    expect(exceedsOutcomeMoneyCeiling(null, env('1000'))).toBe(false)
    expect(exceedsOutcomeMoneyCeiling('', env('1000'))).toBe(false)
    expect(exceedsOutcomeMoneyCeiling('not money', env('1000'))).toBe(true)
  })
})
