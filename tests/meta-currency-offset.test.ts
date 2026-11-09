import { describe, expect, it } from 'vitest'
import { fromMetaMinorUnits, metaCurrencyOffset, toMetaMinorUnits } from '@/lib/platforms/meta/currency-offset'
import { toMinorUnits } from '@/lib/utils/format-currency'

// Meta budget fields use Meta's offset table (developers.facebook.com/docs/marketing-api/currencies),
// which differs from ISO 4217 / Intl digits. Display digits must never drive a Meta budget value.

describe('Meta currency offsets', () => {
  it('uses offset 1 for the currencies Meta keeps in whole units', () => {
    for (const currency of ['CLP', 'COP', 'CRC', 'HUF', 'ISK', 'IDR', 'JPY', 'KRW', 'PYG', 'TWD', 'VND']) {
      expect(metaCurrencyOffset(currency)).toBe(1)
      expect(toMetaMinorUnits(1234, currency)).toBe(1234)
    }
  })

  it('differs from ISO where Meta does (TWD/CRC two ISO digits, BHD/JOD three)', () => {
    expect(toMinorUnits(50, 'TWD')).toBe(5000)
    expect(toMetaMinorUnits(50, 'TWD')).toBe(50)
    expect(toMetaMinorUnits(50, 'CRC')).toBe(50)
    expect(toMinorUnits(12.5, 'BHD')).toBe(12500)
    expect(toMetaMinorUnits(12.5, 'BHD')).toBe(1250)
    expect(fromMetaMinorUnits(1250, 'JOD')).toBe(12.5)
    expect(toMetaMinorUnits(12.34, 'USD')).toBe(1234)
  })

  it('refuses a currency Meta does not list, and a non-finite amount', () => {
    expect(metaCurrencyOffset('KWD')).toBeNull()
    expect(() => toMetaMinorUnits(10, 'KWD')).toThrow(/meta_currency_unsupported/)
    expect(() => fromMetaMinorUnits(10, 'KWD')).toThrow(/meta_currency_unsupported/)
    expect(() => toMetaMinorUnits(Number.NaN, 'USD')).toThrow(/not_finite/)
  })
})
