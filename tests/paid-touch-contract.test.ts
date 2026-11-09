import { describe, expect, it } from 'vitest'
import {
  hashPaidTouchToken,
  issuePaidTouchToken,
  normalizePaidTouchCapture,
  verifyPaidTouchToken,
} from '@/lib/attribution/paid-touch-contract'
import { CANONICAL_UTM_PARAMS, CANONICAL_UTM_STRING, validateUrlTags } from '@/lib/tracking/utm-validator'

const ACCOUNT = '00000000-0000-4000-8000-000000000067'
const TOKEN_ID = '00000000-0000-4000-8000-000000000068'
const SECRET = ['test-only', 'secret-that-is-long-enough-for-hmac'].join('-')

function capture(overrides: Record<string, unknown> = {}) {
  return {
    capture_id: '00000000-0000-4000-8000-000000000069',
    source: 'meta',
    fbclid: 'IwZXh0bgNhZW0CMTAAAR1',
    meta_campaign_id: '100000000000007',
    meta_adset_id: '100000000000008',
    meta_ad_id: '100000000000009',
    utm_source: 'meta',
    utm_medium: 'paid_social',
    utm_campaign: 'Cold | Studio Tour',
    utm_content: 'Proof-led reel',
    utm_term: 'Springfield creators',
    landing_url: 'https://example-studio.test/book/?fbclid=secret-ish#book',
    referrer_url: 'https://l.facebook.com/tr/?tracking=value',
    previous_token: null,
    ...overrides,
  }
}

describe('paid-touch capture contract', () => {
  it('normalizes a production-shaped Meta touch without retaining query strings or fragments', () => {
    const parsed = normalizePaidTouchCapture(capture(), ['example-studio.test'])
    expect(parsed).toMatchObject({
      source: 'meta',
      landing_url: 'https://example-studio.test/book/',
      referrer_url: 'https://l.facebook.com/tr/',
      identity_complete: true,
    })
  })

  it('retains an incomplete touch diagnostically but does not call its identity complete', () => {
    const parsed = normalizePaidTouchCapture(capture({ meta_ad_id: null }), ['example-studio.test'])
    expect(parsed.identity_complete).toBe(false)
  })

  it('rejects an unapproved landing host, malformed Meta IDs, unexpected fields, and a non-paid medium', () => {
    expect(() => normalizePaidTouchCapture(capture({ landing_url: 'https://evil.example/book/' }), ['example-studio.test'])).toThrow()
    expect(() => normalizePaidTouchCapture(capture({ meta_ad_id: '{{ad.id}}' }), ['example-studio.test'])).toThrow()
    expect(() => normalizePaidTouchCapture(capture({ customer_email: 'client@example.com' }), ['example-studio.test'])).toThrow()
    expect(() => normalizePaidTouchCapture(capture({ utm_medium: 'organic' }), ['example-studio.test'])).toThrow()
  })
})

describe('opaque paid-touch token', () => {
  it('round-trips one token id and stores only a one-way digest', () => {
    const token = issuePaidTouchToken(TOKEN_ID, SECRET)
    expect(token).not.toContain(ACCOUNT)
    expect(verifyPaidTouchToken(token, SECRET)).toEqual({ ok: true, tokenId: TOKEN_ID })
    expect(hashPaidTouchToken(token)).toMatch(/^sha256:[0-9a-f]{64}$/)
  })

  it('rejects a changed signature, wrong secret, malformed token, and invalid token id', () => {
    const token = issuePaidTouchToken(TOKEN_ID, SECRET)
    expect(verifyPaidTouchToken(`${token}x`, SECRET)).toMatchObject({ ok: false })
    expect(verifyPaidTouchToken(token, 'different-secret-that-is-also-long-enough')).toMatchObject({ ok: false })
    expect(verifyPaidTouchToken('pt1.not-a-uuid.signature', SECRET)).toMatchObject({ ok: false })
    expect(() => issuePaidTouchToken('not-a-uuid', SECRET)).toThrow()
  })
})

describe('Meta URL identity contract', () => {
  it('keeps readable UTMs and adds immutable campaign/ad-set/ad ids', () => {
    expect(CANONICAL_UTM_PARAMS).toMatchObject({
      utm_source: 'meta',
      utm_medium: 'paid_social',
      utm_campaign: '{{campaign.name}}',
      utm_content: '{{ad.name}}',
      utm_term: '{{adset.name}}',
      meta_campaign_id: '{{campaign.id}}',
      meta_adset_id: '{{adset.id}}',
      meta_ad_id: '{{ad.id}}',
    })
    expect(validateUrlTags(CANONICAL_UTM_STRING).verdict).toBe('correct')
  })
})
