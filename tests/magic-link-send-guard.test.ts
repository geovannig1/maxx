import { describe, expect, it } from 'vitest'

import {
  getMagicLinkSendGuard,
  recordMagicLinkRequest,
  recordMagicLinkRateLimit,
} from '@/lib/auth/magic-link-send-guard'

const HOUR = 60 * 60 * 1000

describe('magic-link send guard', () => {
  it('allows the first request and applies Supabase’s one-minute per-user cooldown afterwards', () => {
    const now = 1_000_000
    const requests = recordMagicLinkRequest([], now)

    expect(getMagicLinkSendGuard([], now)).toEqual({ canRequest: true, retryAt: null })
    expect(getMagicLinkSendGuard(requests, now + 59_999)).toEqual({
      canRequest: false,
      retryAt: now + 60_000,
    })
    expect(getMagicLinkSendGuard(requests, now + 60_000)).toEqual({ canRequest: true, retryAt: null })
  })

  it('keeps a browser below the two-email-per-hour built-in SMTP ceiling', () => {
    const now = 2_000_000
    const requests = recordMagicLinkRequest(
      recordMagicLinkRequest([], now),
      now + 61_000,
    )

    expect(getMagicLinkSendGuard(requests, now + 61_000)).toEqual({
      canRequest: false,
      retryAt: now + HOUR,
    })
    expect(getMagicLinkSendGuard(requests, now + HOUR)).toEqual({ canRequest: true, retryAt: null })
  })

  it('treats an upstream rate-limit response as a full local hour rather than inviting retries', () => {
    const now = 3_000_000
    const requests = recordMagicLinkRateLimit(now)

    expect(getMagicLinkSendGuard(requests, now + 10 * 60 * 1000)).toEqual({
      canRequest: false,
      retryAt: now + HOUR,
    })
  })

  it('discards malformed and expired stored timestamps', () => {
    const now = 4_000_000

    expect(getMagicLinkSendGuard([Number.NaN, -1, now - HOUR], now)).toEqual({
      canRequest: true,
      retryAt: null,
    })
  })
})
