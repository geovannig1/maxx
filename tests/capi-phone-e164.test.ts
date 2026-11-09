import { afterEach, describe, expect, it } from 'vitest'
import { createHash } from 'crypto'
import { hashPhone } from '@/lib/capi/conversion-events'
import { configuredPhoneCallingCode, normalizePhoneDigits, PHONE_CALLING_CODE_ENV } from '@/lib/capi/phone'
import { envSpec, validateEnv } from '@/config/env'

// Meta matches a phone hash only when the number was normalised to E.164 digits: country calling code,
// no '+', no leading zeros, no trunk prefix. The default calling code is configuration; with none set, a
// national number is sent without a prefix rather than with someone else's country code.

const sha = (s: string) => createHash('sha256').update(s).digest('hex')

/** The legacy hasher, copied verbatim, to prove the US configuration did not change a byte. */
function legacyHashPhone(phone: string | null | undefined): string | undefined {
  const digits = (phone ?? '').replace(/\D/g, '')
  if (!digits) return undefined
  const withCountry = digits.length === 10 ? `1${digits}` : digits
  return sha(withCountry)
}

const saved = process.env[PHONE_CALLING_CODE_ENV]
afterEach(() => {
  if (saved === undefined) delete process.env[PHONE_CALLING_CODE_ENV]
  else process.env[PHONE_CALLING_CODE_ENV] = saved
})

describe('phone normalisation to E.164 digits', () => {
  it('US (1): every common written form hashes exactly as before', () => {
    const forms = ['(555) 555-0142', '555-555-0142', '5555550142', '555.555.0142', '+1 555 555 0142', '+15555550142',
      '1-555-555-0142', '1 (555) 555-0142', '15555550142', '+1 (555) 555-0100']
    for (const form of forms) {
      expect(hashPhone(form, '1'), form).toBe(legacyHashPhone(form))
      expect(normalizePhoneDigits(form, '1'), form).toMatch(/^1555555\d{4}$/)
    }
  })

  it('GB (44): the trunk 0 is removed and 44 added', () => {
    expect(normalizePhoneDigits('07700 900123', '44')).toBe('447700900123')
    expect(normalizePhoneDigits('020 7946 0958', '44')).toBe('442079460958')
    expect(hashPhone('07700 900123', '44')).toBe(sha('447700900123'))
    // Control: the legacy hasher kept the 0 and never added 44, so it could not match.
    expect(legacyHashPhone('07700 900123')).not.toBe(sha('447700900123'))
  })

  it('DE (49): the trunk 0 is removed and 49 added, even when the area code begins with 49', () => {
    expect(normalizePhoneDigits('030 1234567', '49')).toBe('49301234567')
    expect(normalizePhoneDigits('0171 1234567', '49')).toBe('491711234567')
    expect(normalizePhoneDigits('0491 12345', '49')).toBe('4949112345')
  })

  it('a number that already carries a country code keeps it, whatever the configured default', () => {
    expect(normalizePhoneDigits('+44 7700 900123', '49')).toBe('447700900123')
    expect(normalizePhoneDigits('0044 7700 900123', '49')).toBe('447700900123')
    expect(normalizePhoneDigits('+49 (0)30 1234567', '1')).toBe('49301234567')
    expect(normalizePhoneDigits('447700900123', '44')).toBe('447700900123')
    expect(normalizePhoneDigits('+44 7700 900123', null)).toBe('447700900123')
  })

  it('IT (39): the leading 0 belongs to the number and is kept', () => {
    expect(normalizePhoneDigits('06 1234 5678', '39')).toBe('390612345678')
  })

  it('no configured code: no prefix is guessed; leading zeros are still removed', () => {
    expect(normalizePhoneDigits('(555) 555-0142', null)).toBe('5555550142')
    expect(normalizePhoneDigits('07700 900123', null)).toBe('7700900123')
    // Control: the legacy hasher guessed the US code for every 10-digit number.
    expect(hashPhone('(555) 555-0142', null)).not.toBe(legacyHashPhone('(555) 555-0142'))
  })

  it('blank or digit-free input is never hashed', () => {
    for (const code of ['1', '44', null]) {
      expect(hashPhone('n/a', code)).toBeUndefined()
      expect(hashPhone('', code)).toBeUndefined()
      expect(hashPhone(null, code)).toBeUndefined()
      expect(hashPhone('+', code)).toBeUndefined()
      expect(hashPhone('000', code)).toBeUndefined()
    }
  })
})

describe(`${PHONE_CALLING_CODE_ENV}`, () => {
  it('is read from configuration by default', () => {
    delete process.env[PHONE_CALLING_CODE_ENV]
    expect(configuredPhoneCallingCode()).toBeNull()
    expect(hashPhone('(555) 555-0142')).toBe(sha('5555550142'))
    process.env[PHONE_CALLING_CODE_ENV] = '44'
    expect(configuredPhoneCallingCode()).toBe('44')
    expect(hashPhone('07700 900123')).toBe(sha('447700900123'))
  })

  it('a malformed value fails loudly and is reported by the environment check', () => {
    for (const bad of ['0', '+44', '1234', 'uk', '4 4']) {
      process.env[PHONE_CALLING_CODE_ENV] = bad
      expect(() => configuredPhoneCallingCode(), bad).toThrow(PHONE_CALLING_CODE_ENV)
      expect(validateEnv({ [PHONE_CALLING_CODE_ENV]: bad }).map((issue) => issue.name), bad).toContain(PHONE_CALLING_CODE_ENV)
    }
    // Control: valid values pass the same check.
    for (const good of ['1', '44', '49', '971']) {
      expect(validateEnv({ [PHONE_CALLING_CODE_ENV]: good }).map((issue) => issue.name), good).not.toContain(PHONE_CALLING_CODE_ENV)
    }
    expect(envSpec(PHONE_CALLING_CODE_ENV)?.group).toBe('outcomes')
  })
})
