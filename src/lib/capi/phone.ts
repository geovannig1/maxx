// Phone numbers for conversions matching, normalised to E.164 digits as Meta requires: the country
// calling code, then the national number, with no '+', no symbols, no leading zeros and no national
// trunk prefix. A hash of anything else never matches.
//
// The calling code for numbers written without one comes from the ad account's country
// (ad_accounts.country) when it is set, else from configuration (CONVERSIONS_PHONE_COUNTRY_CODE); see
// phoneCallingCodeFor. With neither, a national number is sent without a prefix rather than with another
// country's code.

import { COUNTRY_CALLING_CODES } from './country-calling-codes'

export const PHONE_CALLING_CODE_ENV = 'CONVERSIONS_PHONE_COUNTRY_CODE'

/** An ITU country calling code: one to three digits, never starting with 0. */
const CALLING_CODE = /^[1-9]\d{0,2}$/

/** Calling codes whose national numbers keep their leading 0 after the code (Italy, San Marino,
 *  Vatican City): the 0 there is part of the number, not a trunk prefix. */
const LEADING_ZERO_KEPT = new Set(['39', '378', '379'])

export function isPhoneCallingCode(value: string): boolean {
  return CALLING_CODE.test(value)
}

/** The configured default calling code, or null when unset. A malformed value fails loudly. */
export function configuredPhoneCallingCode(): string | null {
  const value = process.env.CONVERSIONS_PHONE_COUNTRY_CODE?.trim()
  if (!value) return null
  if (!isPhoneCallingCode(value)) {
    throw new Error(`${PHONE_CALLING_CODE_ENV} must be a country calling code of 1 to 3 digits without + (for example 44).`)
  }
  return value
}

/** The calling code of an ISO 3166-1 alpha-2 country, or null when the table does not know it. */
export function callingCodeForCountry(country: string): string | null {
  return Object.hasOwn(COUNTRY_CALLING_CODES, country) ? COUNTRY_CALLING_CODES[country] : null
}

/** The default calling code for an account: its country's code when the country is set and known,
 *  otherwise the configured one (null when unset). */
export function phoneCallingCodeFor(accountCountry: string | null | undefined): string | null {
  const fromCountry = accountCountry ? callingCodeForCountry(accountCountry) : null
  return fromCountry ?? configuredPhoneCallingCode()
}

/**
 * PURE. E.164 digits for one written phone number, or undefined when it holds no usable digits.
 * - `+…` or `00…`: the number already carries its country code, which is kept as written.
 * - a leading trunk 0 (`07700 900123`): removed, then `callingCode` is added.
 * - neither: taken to carry `callingCode` when it already starts with it, else `callingCode` is added.
 * With `callingCode` null, a national number keeps its digits without any prefix.
 */
export function normalizePhoneDigits(phone: string | null | undefined, callingCode: string | null): string | undefined {
  const written = (phone ?? '').replace(/\(0\)/g, '').trim()
  const digits = written.replace(/\D/g, '')
  if (written.startsWith('+')) return nonEmpty(digits.replace(/^0+/, ''))
  if (digits.startsWith('00')) return nonEmpty(digits.replace(/^0+/, ''))
  if (callingCode === null) return nonEmpty(digits.replace(/^0+/, ''))
  const national = LEADING_ZERO_KEPT.has(callingCode) ? digits : digits.replace(/^0+/, '')
  if (!national || /^0+$/.test(national)) return undefined
  if (national.length === digits.length && national.startsWith(callingCode)) return national
  return `${callingCode}${national}`
}

function nonEmpty(value: string): string | undefined {
  return value ? value : undefined
}
