import { describe, it, expect } from 'vitest'
import { parseAdParams, buildDecoratedAcuityUrl, ACUITY_SCHEDULER_URL } from '@/lib/outcomes/adapters/acuity/attribution-link'

describe('parseAdParams', () => {
  it('extracts recognized ad params from a landing URL', () => {
    const p = parseAdParams('https://example-studio.test/book/?utm_source=fb&utm_medium=paid_social&utm_campaign=summer&fbclid=IwAR9&junk=x')
    expect(p).toEqual({ utm_source: 'fb', utm_medium: 'paid_social', utm_campaign: 'summer', fbclid: 'IwAR9' })
  })
  it('returns empty for a bare URL or garbage', () => {
    expect(parseAdParams('https://example-studio.test/book/')).toEqual({})
    expect(parseAdParams('not a url')).toEqual({})
  })
})

describe('buildDecoratedAcuityUrl', () => {
  const fieldIds = { utm_source: 111, utm_medium: 222, utm_campaign: 333, fbclid: 444 }

  it('appends field:ID=value only for params that have both an id and a value; keeps the literal colon', () => {
    const url = buildDecoratedAcuityUrl(ACUITY_SCHEDULER_URL, { utm_source: 'fb', utm_campaign: 'summer', utm_term: 'ignored-no-id' }, fieldIds)
    expect(url).toContain('field:111=fb')
    expect(url).toContain('field:333=summer')
    expect(url).not.toContain('field%3A')      // literal colon, not percent-encoded
    expect(url).not.toContain('utm_term')        // no field id configured → skipped
    expect(url).not.toContain('field:222')       // no utm_medium value → skipped
  })

  it('preserves existing query params and does not duplicate an existing field prefill', () => {
    const url = buildDecoratedAcuityUrl('https://example-studio.as.me/?appointmentType=123&field:111=existing', { utm_source: 'fb' }, fieldIds)
    expect(url).toContain('appointmentType=123')
    expect((url.match(/field:111=/g) ?? []).length).toBe(1) // not duplicated
    expect(url).toContain('field:111=existing')             // original value kept
  })

  it('url-encodes values', () => {
    const url = buildDecoratedAcuityUrl(ACUITY_SCHEDULER_URL, { utm_campaign: 'summer sale & more' }, { utm_campaign: 333 })
    expect(url).toContain('field:333=summer+sale+%26+more')
  })

  it('returns the base unchanged on an invalid base URL', () => {
    expect(buildDecoratedAcuityUrl('not a url', { utm_source: 'fb' }, fieldIds)).toBe('not a url')
  })
})
