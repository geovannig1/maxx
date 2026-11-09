import { afterEach, describe, expect, it, vi } from 'vitest'
import { configuredOutcomeNoun, outcomeNoun, parseOutcomeNoun, withIndefiniteArticle, OUTCOME_NOUN_ENV } from '@/config/outcome-nouns'
import { sourceCompletenessLabel } from '@/lib/outcomes/completeness-label'
import { validateEnv } from '@/config/env'

// Screen wording: a business names its outcomes once ("booking/bookings", "order/orders",
// "lead/leads"); every screen reads that name through one helper. Unset means "outcome/outcomes".

afterEach(() => vi.unstubAllEnvs())

describe('outcome noun configuration', () => {
  it('defaults to outcome/outcomes when unset', () => {
    vi.stubEnv(OUTCOME_NOUN_ENV, '')
    expect(configuredOutcomeNoun()).toEqual({ singular: 'outcome', plural: 'outcomes' })
    expect(outcomeNoun()).toBe('outcomes')
    expect(outcomeNoun({ plural: false })).toBe('outcome')
  })

  it('reads singular/plural from configuration', () => {
    vi.stubEnv(OUTCOME_NOUN_ENV, 'order/orders')
    expect(outcomeNoun()).toBe('orders')
    expect(outcomeNoun({ plural: false })).toBe('order')
    expect(outcomeNoun({ capitalize: true })).toBe('Orders')
    expect(outcomeNoun({ count: 1 })).toBe('order')
    expect(outcomeNoun({ count: 0 })).toBe('orders')
    expect(outcomeNoun({ count: 2, capitalize: true })).toBe('Orders')
  })

  it('puts the English indefinite article before a configured singular (an outcome, a booking)', () => {
    expect(withIndefiniteArticle('outcome')).toBe('an outcome')
    expect(withIndefiniteArticle('booking')).toBe('a booking')
    expect(withIndefiniteArticle('Order')).toBe('an Order')
    expect(withIndefiniteArticle('qualified lead')).toBe('a qualified lead')
  })

  it('keeps irregular plurals exactly as configured', () => {
    vi.stubEnv(OUTCOME_NOUN_ENV, 'inquiry/inquiries')
    expect(outcomeNoun()).toBe('inquiries')
    vi.stubEnv(OUTCOME_NOUN_ENV, ' Anfrage / Anfragen ')
    expect(outcomeNoun({ plural: false })).toBe('Anfrage')
  })

  it('accepts multi-word and non-ASCII names, refuses malformed values', () => {
    expect(parseOutcomeNoun('qualified lead/qualified leads')).toEqual({ singular: 'qualified lead', plural: 'qualified leads' })
    expect(parseOutcomeNoun('réservation/réservations')).toEqual({ singular: 'réservation', plural: 'réservations' })
    for (const bad of ['booking', 'a/b/c', '/bookings', 'booking/', '<b>/x', 'x'.repeat(41) + '/y']) {
      expect(parseOutcomeNoun(bad)).toBeNull()
    }
  })

  it('fails loudly on an invalid configured value instead of silently using the default', () => {
    vi.stubEnv(OUTCOME_NOUN_ENV, 'bookings')
    expect(() => outcomeNoun()).toThrow(OUTCOME_NOUN_ENV)
  })

  it('is part of the validated environment schema (valid accepted, invalid named)', () => {
    expect(validateEnv({ [OUTCOME_NOUN_ENV]: 'sale/sales' }).filter((i) => i.name === OUTCOME_NOUN_ENV)).toEqual([])
    expect(validateEnv({ [OUTCOME_NOUN_ENV]: 'sales' }).filter((i) => i.name === OUTCOME_NOUN_ENV).map((i) => i.code)).toEqual(['invalid'])
  })
})

describe('source completeness label', () => {
  it('names a push-only source by how its outcomes arrive', () => {
    expect(sourceCompletenessLabel('push_as_received', 'webhook')).toBe('As received')
    expect(sourceCompletenessLabel('push_as_received', 'csv')).toBe('As imported')
    expect(sourceCompletenessLabel('reconciled', 'csv')).toBe('Reconciled')
  })

  it('never prints the internal state name', () => {
    for (const kind of ['webhook', 'csv', 'other']) {
      expect(sourceCompletenessLabel('push_as_received', kind)).not.toMatch(/push|_/)
    }
  })
})

describe('timezone short name (replaces the hard-coded "ET")', () => {
  it('uses the generic short name, stable across daylight saving', async () => {
    const { timezoneShortName } = await import('@/config/timezone-label')
    expect(timezoneShortName('America/New_York', 'en-US')).toBe('ET')
    expect(timezoneShortName('America/Chicago', 'en-US')).toBe('CT')
    expect(timezoneShortName('UTC', 'en-US')).toBe('UTC')
  })

  it('falls back to the IANA id when the locale has no compact name', async () => {
    const { timezoneShortName } = await import('@/config/timezone-label')
    expect(timezoneShortName('Asia/Tokyo', 'en-US')).toBe('Asia/Tokyo')
  })

  it('follows the configured timezone (not a fixed "ET")', async () => {
    const { accountTimezoneShortName } = await import('@/config/timezone-label')
    vi.stubEnv('NEXT_PUBLIC_ACCOUNT_TIMEZONE', 'America/Chicago')
    vi.stubEnv('NEXT_PUBLIC_ACCOUNT_LOCALE', 'en-US')
    expect(accountTimezoneShortName()).toBe('CT')
    vi.stubEnv('NEXT_PUBLIC_ACCOUNT_TIMEZONE', 'Europe/Berlin')
    vi.stubEnv('NEXT_PUBLIC_ACCOUNT_LOCALE', 'de-DE')
    expect(accountTimezoneShortName()).toBe('MEZ')
  })
})
