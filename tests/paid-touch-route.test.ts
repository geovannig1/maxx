import { beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const state = vi.hoisted(() => ({
  account: {
    ok: true,
    account: { id: '00000000-0000-4000-8000-000000000721', accountId: 'act_1', accountName: 'Studio' },
  } as unknown,
  rateLimit: null as Response | null,
  persist: vi.fn(),
  recordAttempt: vi.fn(),
  recordOutcome: vi.fn(),
  recordDelivery: vi.fn(),
}))

vi.mock('@/lib/supabase/admin', () => ({ getAdminClient: () => ({ kind: 'admin' }) }))
vi.mock('@/lib/accounts/active-account', () => ({
  resolveOnlyActiveAccount: vi.fn(async () => state.account),
  activeAccountErrorCode: vi.fn((reason: string) => `ACTIVE_ACCOUNT_${reason.toUpperCase()}`),
  activeAccountErrorStatus: vi.fn((reason: string) => reason === 'unavailable' ? 503 : 409),
}))
vi.mock('@/lib/security/api-rate-limit', () => ({
  enforceApiRateLimit: vi.fn(async () => state.rateLimit),
}))
vi.mock('@/lib/attribution/paid-eligibility-ledger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/attribution/paid-eligibility-ledger')>()
  return {
    ...actual,
    recordPaidCaptureAttempt: state.recordAttempt,
    recordPaidCaptureOutcome: state.recordOutcome,
    recordSchedulerTokenDelivery: state.recordDelivery,
  }
})
const knownAd = vi.hoisted(() => ({ value: true }))
vi.mock('@/lib/attribution/paid-touch-guards', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/attribution/paid-touch-guards')>()
  return { ...actual, isKnownAccountAd: vi.fn(async () => knownAd.value) }
})
vi.mock('@/lib/attribution/paid-touch-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/attribution/paid-touch-store')>()
  return { ...actual, persistPaidTouchCapture: state.persist }
})

const validBody = {
  capture_id: '00000000-0000-4000-8000-000000000722',
  source: 'meta',
  fbclid: 'IwZXh0bgNhZW0CMTAAAR1',
  meta_campaign_id: '100000000000007',
  meta_adset_id: '100000000000008',
  meta_ad_id: '100000000000009',
  utm_source: 'meta',
  utm_medium: 'paid_social',
  utm_campaign: 'Cold Studio',
  utm_content: 'Proof reel',
  utm_term: 'Springfield creators',
  landing_url: 'https://example-studio.test/book/?utm_source=meta',
  referrer_url: 'https://l.facebook.com/',
  previous_token: null,
}

function request(
  body: unknown = validBody,
  headers: Record<string, string> = {},
): Request {
  return new Request('https://maxx.example/api/attribution/paid-touch', {
    method: 'POST',
    headers: {
      origin: 'https://example-studio.test',
      'content-type': 'application/json',
      'x-forwarded-for': '203.0.113.8',
      ...headers,
    },
    body: JSON.stringify(body),
  })
}

describe('public paid-touch capture route', () => {
  beforeEach(() => {
    vi.resetModules()
    process.env.PAID_TOUCH_ALLOWED_ORIGINS = 'https://example-studio.test,https://www.example-studio.test'
    process.env.PAID_TOUCH_ALLOWED_LANDING_HOSTS = 'example-studio.test,www.example-studio.test'
    process.env.PAID_TOUCH_TOKEN_SECRET = 'route-secret-at-least-thirty-two-bytes-long'
    state.account = {
      ok: true,
      account: { id: '00000000-0000-4000-8000-000000000721', accountId: 'act_1', accountName: 'Studio' },
    }
    state.rateLimit = null
    knownAd.value = true
    delete process.env.PAID_TOUCH_GLOBAL_CAPTURES_PER_HOUR
    state.persist.mockReset()
    state.recordAttempt.mockReset()
    state.recordAttempt.mockResolvedValue({
      attemptId: '00000000-0000-4000-8000-000000000725',
      receivedAt: '2026-07-30T20:59:59.000Z',
    })
    state.recordOutcome.mockReset()
    state.recordOutcome.mockResolvedValue('00000000-0000-4000-8000-000000000726')
    state.recordDelivery.mockReset()
    state.recordDelivery.mockResolvedValue('00000000-0000-4000-8000-000000000727')
    state.persist.mockResolvedValue({
      touchId: '00000000-0000-4000-8000-000000000723',
      tokenId: '00000000-0000-4000-8000-000000000724',
      firstTouchId: '00000000-0000-4000-8000-000000000723',
      lastTouchId: '00000000-0000-4000-8000-000000000723',
      observedAt: '2026-07-30T21:00:00.000Z',
      expiresAt: '2026-10-28T21:00:00.000Z',
      identityComplete: true,
      token: `pt1.00000000-0000-4000-8000-000000000724.signature`,
    })
  })

  it('accepts only the configured site, derives the account, and returns the opaque token', async () => {
    const { POST } = await import('@/app/api/attribution/paid-touch/route')
    const response = await POST(request())

    expect(response.status).toBe(200)
    expect(response.headers.get('access-control-allow-origin')).toBe('https://example-studio.test')
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(state.persist).toHaveBeenCalledWith(
      { kind: 'admin' },
      '00000000-0000-4000-8000-000000000721',
      expect.objectContaining({
        capture_id: validBody.capture_id,
        landing_url: 'https://example-studio.test/book/',
        identity_complete: true,
      }),
      process.env.PAID_TOUCH_TOKEN_SECRET,
    )
    expect(state.recordAttempt).toHaveBeenCalledOnce()
    expect(state.recordOutcome).toHaveBeenCalledTimes(2)
    expect(await response.json()).toEqual({
      data: {
        token: `pt1.00000000-0000-4000-8000-000000000724.signature`,
        expires_at: '2026-10-28T21:00:00.000Z',
        identity_complete: true,
      },
      conversion_sent: false,
    })
  })

  it('rejects missing/untrusted origins and supports preflight only for an allowlisted origin', async () => {
    const { OPTIONS, POST } = await import('@/app/api/attribution/paid-touch/route')
    const missing = await POST(request(validBody, { origin: '' }))
    expect(missing.status).toBe(403)
    const attacker = await POST(request(validBody, { origin: 'https://attacker.example' }))
    expect(attacker.status).toBe(403)
    expect(state.persist).not.toHaveBeenCalled()

    const preflight = await OPTIONS(new Request('https://maxx.example/api/attribution/paid-touch', {
      method: 'OPTIONS', headers: { origin: 'https://example-studio.test' },
    }))
    expect(preflight.status).toBe(204)
    expect(preflight.headers.get('access-control-allow-origin')).toBe('https://example-studio.test')
  })

  it('fails closed when signing/origin/landing configuration is absent', async () => {
    delete process.env.PAID_TOUCH_TOKEN_SECRET
    const { POST } = await import('@/app/api/attribution/paid-touch/route')
    const response = await POST(request())
    expect(response.status).toBe(503)
    expect(state.persist).not.toHaveBeenCalled()
  })

  it('accepts a signed browser acknowledgement only for the matching governed scheduler token', async () => {
    const { PATCH } = await import('@/app/api/attribution/paid-touch/route')
    const tokenId = '00000000-0000-4000-8000-000000000724'
    const { issuePaidTouchToken } = await import('@/lib/attribution/paid-touch-contract')
    const token = issuePaidTouchToken(tokenId, process.env.PAID_TOUCH_TOKEN_SECRET!)
    const response = await PATCH(request({
      capture_id: validBody.capture_id,
      token,
      delivery_status: 'scheduler_decorated',
    }))

    expect(response.status).toBe(200)
    expect(state.recordDelivery).toHaveBeenCalledWith(
      { kind: 'admin' },
      expect.objectContaining({
        adAccountId: '00000000-0000-4000-8000-000000000721',
        browserCaptureId: validBody.capture_id,
        tokenId,
        deliveryStatus: 'scheduler_decorated',
      }),
    )
  })

  it('rejects wrong media types, oversized bodies, and invalid evidence before persistence', async () => {
    const { POST } = await import('@/app/api/attribution/paid-touch/route')
    expect((await POST(request(validBody, { 'content-type': 'text/plain' }))).status).toBe(415)
    expect((await POST(request(validBody, { 'content-length': '20000' }))).status).toBe(413)
    expect((await POST(request({ ...validBody, ad_account_id: 'attacker', extra: true }))).status).toBe(400)
    expect(state.persist).not.toHaveBeenCalled()
  })

  it('does not admit malformed public input into the capture ledger', async () => {
    const { POST } = await import('@/app/api/attribution/paid-touch/route')

    expect((await POST(request({ ...validBody, extra: true }))).status).toBe(400)
    expect(state.recordAttempt).not.toHaveBeenCalled()
    expect(state.recordOutcome).not.toHaveBeenCalled()
  })

  it('rate-limits on an opaque actor key before account resolution or persistence', async () => {
    state.rateLimit = Response.json({ error: 'Too many requests.' }, { status: 429 })
    const { enforceApiRateLimit } = await import('@/lib/security/api-rate-limit')
    const { POST } = await import('@/app/api/attribution/paid-touch/route')
    const response = await POST(request())

    expect(response.status).toBe(429)
    expect(enforceApiRateLimit).toHaveBeenCalledWith(expect.objectContaining({
      bucket: 'paid_touch_capture', limit: 30, windowSeconds: 3600,
      actorKey: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
    }))
    expect(JSON.stringify(vi.mocked(enforceApiRateLimit).mock.calls)).not.toContain('203.0.113.8')
    expect(state.persist).not.toHaveBeenCalled()
  })

  it('fails closed when active account ownership is ambiguous', async () => {
    state.account = { ok: false, reason: 'ambiguous' }
    const { POST } = await import('@/app/api/attribution/paid-touch/route')
    const response = await POST(request())
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ code: 'ACTIVE_ACCOUNT_AMBIGUOUS' })
    expect(state.persist).not.toHaveBeenCalled()
  })

  it('has no Meta conversion sender or outbound fetch in the capture surface', () => {
    const source = fs.readFileSync(path.resolve(
      process.cwd(), 'src/app/api/attribution/paid-touch/route.ts',
    ), 'utf8')
    expect(source).not.toMatch(/sendAcuityCapiEvent|AppointmentConfirmed|graph\.facebook|\bfetch\s*\(/)
  })

  it('keeps a capture for an ad not yet synced, under its own smaller hourly bucket', async () => {
    // A newly launched ad is unknown until the next sync; its landings must not be dropped.
    knownAd.value = false
    const { enforceApiRateLimit } = await import('@/lib/security/api-rate-limit')
    const limiter = vi.mocked(enforceApiRateLimit)
    limiter.mockClear()
    const { POST } = await import('@/app/api/attribution/paid-touch/route')
    const response = await POST(request())
    expect(response.status).toBe(200)
    expect(state.persist).toHaveBeenCalledTimes(1)
    expect(limiter).toHaveBeenCalledWith(expect.objectContaining({
      bucket: 'paid_touch_capture_unknown_ad', limit: 200,
    }))
  })

  it('refuses an unknown-ad capture before any write once the unknown-ad bucket is spent', async () => {
    knownAd.value = false
    process.env.PAID_TOUCH_UNKNOWN_AD_CAPTURES_PER_HOUR = '5'
    const { enforceApiRateLimit } = await import('@/lib/security/api-rate-limit')
    const limiter = vi.mocked(enforceApiRateLimit)
    limiter.mockClear()
    limiter.mockImplementation(async (opts: { bucket: string }) => (
      opts.bucket === 'paid_touch_capture_unknown_ad'
        ? Response.json({ error: 'Too many requests.' }, { status: 429 })
        : null
    ))
    try {
      const { POST } = await import('@/app/api/attribution/paid-touch/route')
      const response = await POST(request())
      expect(response.status).toBe(429)
      expect(limiter).toHaveBeenCalledWith(expect.objectContaining({ bucket: 'paid_touch_capture_unknown_ad', limit: 5 }))
      expect(state.recordAttempt).not.toHaveBeenCalled()
      expect(state.persist).not.toHaveBeenCalled()
      // Control: a known ad does not touch the unknown-ad bucket and is stored.
      knownAd.value = true
      limiter.mockClear()
      const known = await POST(request())
      expect(known.status).toBe(200)
      expect(limiter.mock.calls.map(([o]) => (o as { bucket: string }).bucket)).not.toContain('paid_touch_capture_unknown_ad')
    } finally {
      limiter.mockImplementation(async () => state.rateLimit)
      delete process.env.PAID_TOUCH_UNKNOWN_AD_CAPTURES_PER_HOUR
    }
  })

  it('buckets IPv6 clients by /64 and reads the global capture cap from the environment', async () => {
    process.env.PAID_TOUCH_GLOBAL_CAPTURES_PER_HOUR = '250'
    const { enforceApiRateLimit } = await import('@/lib/security/api-rate-limit')
    const limiter = vi.mocked(enforceApiRateLimit)
    limiter.mockClear()
    const { POST } = await import('@/app/api/attribution/paid-touch/route')
    await POST(request(validBody, { 'x-forwarded-for': '2001:db8:1:2::a' }))
    await POST(request(validBody, { 'x-forwarded-for': '2001:0db8:0001:0002:ffff:1:2:3' }))
    await POST(request(validBody, { 'x-forwarded-for': '2001:db8:1:3::a' }))
    const perClient = limiter.mock.calls.map(([o]) => o).filter((o) => o.bucket === 'paid_touch_capture').map((o) => o.actorKey)
    expect(perClient[0]).toBe(perClient[1])
    expect(perClient[2]).not.toBe(perClient[0])
    expect(limiter.mock.calls.map(([o]) => o).find((o) => o.bucket === 'paid_touch_capture_global')?.limit).toBe(250)
  })
})
