import { afterEach, describe, expect, it } from 'vitest'
import { callingCodeForCountry, isPhoneCallingCode, PHONE_CALLING_CODE_ENV, phoneCallingCodeFor } from '@/lib/capi/phone'
import { COUNTRY_CALLING_CODES } from '@/lib/capi/country-calling-codes'

// The default phone calling code comes from the ad account's country (ad_accounts.country, migration
// 0004) when it is set, and from configuration (CONVERSIONS_PHONE_COUNTRY_CODE) when it is null.

const saved = process.env[PHONE_CALLING_CODE_ENV]
afterEach(() => {
  if (saved === undefined) delete process.env[PHONE_CALLING_CODE_ENV]
  else process.env[PHONE_CALLING_CODE_ENV] = saved
})

describe('callingCodeForCountry', () => {
  it('maps ISO 3166-1 alpha-2 codes to ITU calling codes', () => {
    expect(callingCodeForCountry('US')).toBe('1')
    expect(callingCodeForCountry('CA')).toBe('1')
    expect(callingCodeForCountry('GB')).toBe('44')
    expect(callingCodeForCountry('DE')).toBe('49')
    expect(callingCodeForCountry('IT')).toBe('39')
    expect(callingCodeForCountry('BR')).toBe('55')
    expect(callingCodeForCountry('IN')).toBe('91')
    expect(callingCodeForCountry('AU')).toBe('61')
    expect(callingCodeForCountry('JP')).toBe('81')
    expect(callingCodeForCountry('MX')).toBe('52')
    expect(callingCodeForCountry('AE')).toBe('971')
    expect(callingCodeForCountry('KZ')).toBe('7')
  })

  it('returns null for an unknown, lower-case or malformed code', () => {
    for (const bad of ['ZZ', 'gb', 'GBR', '', 'G']) expect(callingCodeForCountry(bad), bad).toBeNull()
  })

  it('every table entry is an alpha-2 key with a valid calling code', () => {
    const entries = Object.entries(COUNTRY_CALLING_CODES)
    expect(entries.length).toBeGreaterThan(200)
    for (const [country, code] of entries) {
      expect(country, country).toMatch(/^[A-Z]{2}$/)
      expect(isPhoneCallingCode(code), `${country} ${code}`).toBe(true)
    }
  })
})

describe('phoneCallingCodeFor', () => {
  it('uses the account country when it is set, even with configuration present', () => {
    process.env[PHONE_CALLING_CODE_ENV] = '1'
    expect(phoneCallingCodeFor('GB')).toBe('44')
  })

  it('falls back to configuration when the country is null', () => {
    process.env[PHONE_CALLING_CODE_ENV] = '49'
    expect(phoneCallingCodeFor(null)).toBe('49')
    expect(phoneCallingCodeFor(undefined)).toBe('49')
  })

  it('falls back to configuration for a country the table does not know', () => {
    process.env[PHONE_CALLING_CODE_ENV] = '33'
    expect(phoneCallingCodeFor('ZZ')).toBe('33')
  })

  it('is null with neither a country nor configuration (no prefix is added)', () => {
    delete process.env[PHONE_CALLING_CODE_ENV]
    expect(phoneCallingCodeFor(null)).toBeNull()
  })
})
