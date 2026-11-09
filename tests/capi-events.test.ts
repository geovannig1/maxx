import { describe, it, expect } from 'vitest'
import { createHash } from 'crypto'
import { hashEmail, hashPhone, hashName, parsePrice } from '@/lib/capi/conversion-events'

// Meta-spec PII hashing for the CAPI relay: never raw, never empty-string hashes, correct normalization.
// (The Acuity→CAPI 3-event builder was retired 2026-07-17 — the webhook now feeds the ledger only; see
// tests/acuity-webhook.test.ts + tests/acuity-ledger.test.ts.)

const sha = (s: string) => createHash('sha256').update(s).digest('hex')

describe('PII hashing (Meta normalization spec)', () => {
  it('email: trim + lowercase before hashing; never hashes blanks', () => {
    expect(hashEmail('  Sam@Example.COM ')).toBe(sha('sam@example.com'))
    expect(hashEmail('')).toBeUndefined()
    expect(hashEmail(null)).toBeUndefined()
  })
  it('phone: digits only, US country code added to bare 10-digit numbers', () => {
    // The default calling code is configuration since the v1 release (tests/capi-phone-e164.test.ts covers others).
    const saved = process.env.CONVERSIONS_PHONE_COUNTRY_CODE
    process.env.CONVERSIONS_PHONE_COUNTRY_CODE = '1'
    try {
      expect(hashPhone('(555) 555-0142')).toBe(sha('15555550142'))
      expect(hashPhone('+1 555 555 0142')).toBe(sha('15555550142'))
      expect(hashPhone('n/a')).toBeUndefined()
    } finally {
      if (saved === undefined) delete process.env.CONVERSIONS_PHONE_COUNTRY_CODE
      else process.env.CONVERSIONS_PHONE_COUNTRY_CODE = saved
    }
  })
  it('names: trim + lowercase', () => {
    expect(hashName(' Sam ')).toBe(sha('sam'))
    expect(hashName(undefined)).toBeUndefined()
  })
})

describe('parsePrice', () => {
  it('parses Acuity string prices; rejects negatives/garbage', () => {
    expect(parsePrice('125.00')).toBe(125)
    expect(parsePrice(275)).toBe(275)
    expect(parsePrice('-5')).toBeNull()
    expect(parsePrice('abc')).toBeNull()
    expect(parsePrice(null)).toBeNull()
  })
})
