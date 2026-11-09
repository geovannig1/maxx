import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  accountCurrency,
  accountTimezone,
  businessDateOf,
  businessLocaleFromAccount,
  DEFAULT_BUSINESS_CURRENCY,
  DEFAULT_BUSINESS_TIMEZONE,
  isIanaTimeZone,
  isIsoCurrency,
} from '@/config/business-config'

// one configuration source for the business timezone and currency. The active ad
// account is authoritative on the server; the environment is the validated fallback; they must agree.

afterEach(() => vi.unstubAllEnvs())

describe('business locale configuration', () => {
  it('defaults when nothing is configured', () => {
    vi.stubEnv('NEXT_PUBLIC_ACCOUNT_TIMEZONE', '')
    vi.stubEnv('NEXT_PUBLIC_ACCOUNT_CURRENCY', '')
    expect(accountTimezone()).toBe(DEFAULT_BUSINESS_TIMEZONE)
    expect(accountCurrency()).toBe(DEFAULT_BUSINESS_CURRENCY)
  })

  it('reads a valid configured timezone and currency', () => {
    vi.stubEnv('NEXT_PUBLIC_ACCOUNT_TIMEZONE', 'Europe/Berlin')
    vi.stubEnv('NEXT_PUBLIC_ACCOUNT_CURRENCY', 'EUR')
    expect(accountTimezone()).toBe('Europe/Berlin')
    expect(accountCurrency()).toBe('EUR')
  })

  it('refuses an invalid configured value instead of silently using the default', () => {
    vi.stubEnv('NEXT_PUBLIC_ACCOUNT_TIMEZONE', 'Mars/Olympus_Mons')
    expect(() => accountTimezone()).toThrow(/NEXT_PUBLIC_ACCOUNT_TIMEZONE/)
    vi.stubEnv('NEXT_PUBLIC_ACCOUNT_CURRENCY', 'eur')
    expect(() => accountCurrency()).toThrow(/NEXT_PUBLIC_ACCOUNT_CURRENCY/)
    vi.stubEnv('NEXT_PUBLIC_ACCOUNT_CURRENCY', 'XYZ')
    expect(() => accountCurrency()).toThrow(/ISO 4217/)
  })

  it('validators accept real values and reject look-alikes', () => {
    expect(isIanaTimeZone('Asia/Kolkata')).toBe(true)
    expect(isIanaTimeZone('UTC')).toBe(true)
    expect(isIanaTimeZone(' Europe/Berlin')).toBe(false)
    expect(isIanaTimeZone('')).toBe(false)
    expect(isIanaTimeZone(42)).toBe(false)
    expect(isIsoCurrency('JPY')).toBe(true)
    expect(isIsoCurrency('usd')).toBe(false)
    expect(isIsoCurrency('US')).toBe(false)
  })
})

describe('business locale from the active ad account', () => {
  it('uses the account values when they agree with configuration', () => {
    vi.stubEnv('NEXT_PUBLIC_ACCOUNT_TIMEZONE', 'Europe/Berlin')
    vi.stubEnv('NEXT_PUBLIC_ACCOUNT_CURRENCY', 'EUR')
    expect(businessLocaleFromAccount({ timezone_name: 'Europe/Berlin', currency: 'eur' }))
      .toEqual({ timezone: 'Europe/Berlin', currency: 'EUR', source: 'ad_account' })
  })

  it('falls back to configuration when no account row was read', () => {
    vi.stubEnv('NEXT_PUBLIC_ACCOUNT_TIMEZONE', 'Asia/Tokyo')
    vi.stubEnv('NEXT_PUBLIC_ACCOUNT_CURRENCY', 'JPY')
    expect(businessLocaleFromAccount(null)).toEqual({ timezone: 'Asia/Tokyo', currency: 'JPY', source: 'configuration' })
    expect(businessLocaleFromAccount({})).toEqual({ timezone: 'Asia/Tokyo', currency: 'JPY', source: 'configuration' })
  })

  it('refuses an account whose timezone or currency disagrees with configuration', () => {
    vi.stubEnv('NEXT_PUBLIC_ACCOUNT_TIMEZONE', '')
    vi.stubEnv('NEXT_PUBLIC_ACCOUNT_CURRENCY', '')
    expect(() => businessLocaleFromAccount({ timezone_name: 'Europe/Berlin', currency: 'USD' }))
      .toThrow(/set NEXT_PUBLIC_ACCOUNT_TIMEZONE=Europe\/Berlin/)
    expect(() => businessLocaleFromAccount({ timezone_name: DEFAULT_BUSINESS_TIMEZONE, currency: 'GBP' }))
      .toThrow(/set NEXT_PUBLIC_ACCOUNT_CURRENCY=GBP/)
  })

  it('refuses an invalid account value', () => {
    expect(() => businessLocaleFromAccount({ timezone_name: 'Not/AZone', currency: 'USD' })).toThrow(/IANA/)
    expect(() => businessLocaleFromAccount({ timezone_name: DEFAULT_BUSINESS_TIMEZONE, currency: 'DOLLARS' })).toThrow(/ISO 4217/)
  })
})

describe('business date in the configured zone', () => {
  it('uses the configured zone, not UTC and not the server clock', () => {
    vi.stubEnv('NEXT_PUBLIC_ACCOUNT_TIMEZONE', 'Asia/Kolkata')
    // 20:30 UTC is 02:00 the next day in Kolkata.
    expect(businessDateOf('2026-03-10T20:30:00Z')).toBe('2026-03-11')
    expect(businessDateOf('2026-03-10T20:30:00Z', 'UTC')).toBe('2026-03-10')
    expect(businessDateOf('not a date')).toBe('')
  })

  it('remembers accepted timezones only, so repeated claim validation stops constructing formatters', () => {
    const Original = Intl.DateTimeFormat
    let constructed = 0
    Intl.DateTimeFormat = function (...args: ConstructorParameters<typeof Intl.DateTimeFormat>) {
      constructed += 1
      return new Original(...args)
    } as unknown as typeof Intl.DateTimeFormat
    try {
      expect([isIanaTimeZone('Pacific/Chatham'), isIanaTimeZone('Pacific/Chatham'), isIanaTimeZone('Pacific/Chatham')]).toEqual([true, true, true])
      expect(constructed).toBe(1)
      expect([isIanaTimeZone('Mars/Olympus_Mons'), isIanaTimeZone('Mars/Olympus_Mons')]).toEqual([false, false])
      expect(constructed).toBe(3)
      expect(isIanaTimeZone(' Pacific/Chatham')).toBe(false)
      expect(constructed).toBe(3)
    } finally {
      Intl.DateTimeFormat = Original
    }
  })
})
