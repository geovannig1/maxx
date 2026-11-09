import { beforeEach, describe, expect, it, vi } from 'vitest'

// The per-client limit keys on X-Forwarded-For / X-Real-IP, which a script outside Vercel can rotate
// freely. A global bucket with a constant actor key bounds total forged writes regardless of how many
// client addresses are claimed. This fake limiter counts per (bucket, actor) and enforces the limit
// the route passes, so the test exercises the route's real limits rather than a stubbed verdict.
const state = vi.hoisted(() => ({
  counts: new Map<string, number>(),
  calls: [] as Array<{ bucket: string; actorKey: string; limit: number; windowSeconds: number }>,
  persist: vi.fn(),
  recordAttempt: vi.fn(),
  recordOutcome: vi.fn(),
  recordDelivery: vi.fn(),
}))

vi.mock('@/lib/supabase/admin', () => ({ getAdminClient: () => ({ kind: 'admin' }) }))
vi.mock('@/lib/accounts/active-account', () => ({
  resolveOnlyActiveAccount: vi.fn(async () => ({
    ok: true,
    account: { id: '00000000-0000-4000-8000-000000000721', accountId: 'act_1', accountName: 'Studio' },
  })),
  activeAccountErrorCode: vi.fn(() => 'ACTIVE_ACCOUNT_UNAVAILABLE'),
  activeAccountErrorStatus: vi.fn(() => 503),
}))
vi.mock('@/lib/security/api-rate-limit', () => ({
  enforceApiRateLimit: vi.fn(async (options: { bucket: string; actorKey: string; limit: number; windowSeconds: number }) => {
    state.calls.push(options)
    const key = `${options.bucket}|${options.actorKey}`
    const used = (state.counts.get(key) ?? 0) + 1
    state.counts.set(key, used)
    return used > options.limit
      ? Response.json({ error: 'Too many requests. Try again later.', code: 'RATE_LIMITED' }, { status: 429 })
      : null
  }),
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

const captureBody = {
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

function request(method: 'POST' | 'PATCH', body: unknown, clientAddress: string): Request {
  return new Request('https://maxx.example/api/attribution/paid-touch', {
    method,
    headers: {
      origin: 'https://example-studio.test',
      'content-type': 'application/json',
      'x-forwarded-for': clientAddress,
    },
    body: JSON.stringify(body),
  })
}

/** A distinct, syntactically valid client address per request, as a header-spoofing script would send. */
function freshAddress(n: number): string {
  return `198.51.${Math.floor(n / 250) % 250}.${(n % 250) + 1}`
}

/** A distinct, valid v4-shaped token id per visitor. */
function distinctTokenId(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`
}

/** The per-token limit must sit far below the global acknowledgement cap to bound a replay. */
const GLOBAL_ACK_CAP_FLOOR = 100

function globalCall(bucket: string) {
  const calls = state.calls.filter((call) => call.bucket === bucket)
  expect(calls.length).toBeGreaterThan(0)
  expect(new Set(calls.map((call) => call.actorKey)).size).toBe(1)
  return calls[0]
}

describe('paid-touch global write cap', () => {
  beforeEach(() => {
    vi.resetModules()
    process.env.PAID_TOUCH_ALLOWED_ORIGINS = 'https://example-studio.test'
    process.env.PAID_TOUCH_ALLOWED_LANDING_HOSTS = 'example-studio.test'
    process.env.PAID_TOUCH_TOKEN_SECRET = 'route-secret-at-least-thirty-two-bytes-long'
    state.counts.clear()
    state.calls.length = 0
    state.persist.mockReset()
    state.persist.mockResolvedValue({
      touchId: '00000000-0000-4000-8000-000000000723',
      tokenId: '00000000-0000-4000-8000-000000000724',
      firstTouchId: '00000000-0000-4000-8000-000000000723',
      lastTouchId: '00000000-0000-4000-8000-000000000723',
      observedAt: '2026-07-30T21:00:00.000Z',
      expiresAt: '2026-10-28T21:00:00.000Z',
      identityComplete: true,
      token: ['pt1', '00000000-0000-4000-8000-000000000724', 'signature'].join('.'),
    })
    state.recordAttempt.mockReset()
    state.recordAttempt.mockResolvedValue({ attemptId: '00000000-0000-4000-8000-000000000725', receivedAt: '2026-07-30T20:59:59.000Z' })
    state.recordOutcome.mockReset()
    state.recordOutcome.mockResolvedValue('00000000-0000-4000-8000-000000000726')
    state.recordDelivery.mockReset()
    state.recordDelivery.mockResolvedValue('00000000-0000-4000-8000-000000000727')
  })

  it('POST: rejects fresh client addresses with 429 once the global capture bucket is exhausted', async () => {
    const { POST } = await import('@/app/api/attribution/paid-touch/route')

    // Control: a normal request under every cap succeeds and is counted against the global bucket.
    const first = await POST(request('POST', captureBody, freshAddress(0)))
    expect(first.status).toBe(200)
    const cap = globalCall('paid_touch_capture_global')
    expect(cap.actorKey).not.toMatch(/198\.51\./)

    for (let n = 1; n < cap.limit; n++) {
      const ok = await POST(request('POST', captureBody, freshAddress(n)))
      expect(ok.status).toBe(200)
    }
    const persistedBeforeCap = state.persist.mock.calls.length
    expect(persistedBeforeCap).toBe(cap.limit)

    const blocked = await POST(request('POST', captureBody, freshAddress(cap.limit)))
    expect(blocked.status).toBe(429)
    expect(blocked.headers.get('access-control-allow-origin')).toBe('https://example-studio.test')
    expect(state.persist.mock.calls.length).toBe(persistedBeforeCap)
    expect(state.recordAttempt.mock.calls.length).toBe(persistedBeforeCap)
  })

  // Each acknowledgement carries a DISTINCT valid token, as distinct real visitors would. Replaying
  // one token is bounded separately by the per-token bucket (see the replay case below).
  it('PATCH: distinct valid tokens from fresh addresses succeed up to the global cap, then get 429', async () => {
    const { PATCH } = await import('@/app/api/attribution/paid-touch/route')
    const { issuePaidTouchToken } = await import('@/lib/attribution/paid-touch-contract')
    const ackFor = (n: number) => ({
      capture_id: captureBody.capture_id,
      token: issuePaidTouchToken(distinctTokenId(n), process.env.PAID_TOUCH_TOKEN_SECRET!),
      delivery_status: 'scheduler_decorated',
    })

    const first = await PATCH(request('PATCH', ackFor(0), freshAddress(0)))
    expect(first.status).toBe(200)
    const cap = globalCall('paid_touch_delivery_ack_global')

    for (let n = 1; n < cap.limit; n++) {
      expect((await PATCH(request('PATCH', ackFor(n), freshAddress(n)))).status).toBe(200)
    }
    const recorded = state.recordDelivery.mock.calls.length
    expect(recorded).toBe(cap.limit)

    const blocked = await PATCH(request('PATCH', ackFor(cap.limit), freshAddress(cap.limit)))
    expect(blocked.status).toBe(429)
    expect(state.recordDelivery.mock.calls.length).toBe(recorded)
  })

  // Security review: one genuine token replayed from rotating X-Forwarded-For values used to pass the
  // per-client limit on every request and fill the global acknowledgement bucket by itself.
  it('PATCH: one token replayed from rotating addresses is cut off by a per-token limit before the global bucket', async () => {
    const { PATCH } = await import('@/app/api/attribution/paid-touch/route')
    const { issuePaidTouchToken } = await import('@/lib/attribution/paid-touch-contract')
    const tokenId = distinctTokenId(1)
    const token = issuePaidTouchToken(tokenId, process.env.PAID_TOUCH_TOKEN_SECRET!)
    const ack = { capture_id: captureBody.capture_id, token, delivery_status: 'scheduler_decorated' }

    // Control: the first acknowledgement for a fresh token succeeds.
    expect((await PATCH(request('PATCH', ack, freshAddress(0)))).status).toBe(200)
    const perToken = state.calls.filter((call) => call.bucket === 'paid_touch_delivery_ack_token')
    expect(perToken).toHaveLength(1)
    expect(perToken[0].actorKey).toBe(tokenId)
    const limit = perToken[0].limit
    expect(limit).toBeLessThan(GLOBAL_ACK_CAP_FLOOR)

    const replays = 200
    const statuses: number[] = []
    for (let n = 1; n < replays; n++) {
      statuses.push((await PATCH(request('PATCH', ack, freshAddress(n)))).status)
    }
    expect(statuses.slice(0, limit - 1).every((status) => status === 200)).toBe(true)
    expect(statuses.slice(limit - 1).every((status) => status === 429)).toBe(true)

    // The replayed token spent at most `limit` global units and wrote at most `limit` rows.
    expect(state.calls.filter((call) => call.bucket === 'paid_touch_delivery_ack_global')).toHaveLength(limit)
    expect(state.recordDelivery).toHaveBeenCalledTimes(limit)

    // The per-token check runs after verification: invalid tokens never reach it.
    const before = state.calls.filter((call) => call.bucket === 'paid_touch_delivery_ack_token').length
    const forged = { ...ack, token: token.slice(0, -2) + (token.endsWith('AA') ? 'BB' : 'AA') }
    expect((await PATCH(request('PATCH', forged, freshAddress(replays)))).status).toBe(400)
    expect(state.calls.filter((call) => call.bucket === 'paid_touch_delivery_ack_token')).toHaveLength(before)

    // Control: a different valid token is unaffected by the first token's exhaustion.
    const other = issuePaidTouchToken(distinctTokenId(2), process.env.PAID_TOUCH_TOKEN_SECRET!)
    expect((await PATCH(request('PATCH', { ...ack, token: other }, freshAddress(replays + 1)))).status).toBe(200)
  })

  // Security review fix 2: the global bucket was consumed before body, schema and account validation,
  // so `{}` from rotating addresses could fill it and lock out real visitors.
  it('POST: invalid bodies from rotating addresses do not consume the global capture budget', async () => {
    const { POST } = await import('@/app/api/attribution/paid-touch/route')
    const invalidShapes: unknown[] = [{}, { capture_id: 'x' }, { ...captureBody, landing_url: 'https://evil.test/' }, []]
    let n = 0
    for (; n < 2_050; n++) {
      const response = await POST(request('POST', invalidShapes[n % invalidShapes.length], freshAddress(n)))
      expect(response.status).toBe(400)
    }
    expect(state.calls.filter((call) => call.bucket === 'paid_touch_capture_global')).toHaveLength(0)

    const valid = await POST(request('POST', captureBody, freshAddress(n)))
    expect(valid.status).toBe(200)
    expect(state.persist).toHaveBeenCalledTimes(1)
    expect(state.calls.filter((call) => call.bucket === 'paid_touch_capture_global')).toHaveLength(1)
  })

  it('POST: a request rejected for account scope does not consume the global capture budget', async () => {
    const active = await import('@/lib/accounts/active-account')
    vi.mocked(active.resolveOnlyActiveAccount).mockResolvedValueOnce({ ok: false, reason: 'ambiguous' } as never)
    const { POST } = await import('@/app/api/attribution/paid-touch/route')
    expect((await POST(request('POST', captureBody, freshAddress(1)))).status).toBe(503)
    expect(state.calls.filter((call) => call.bucket === 'paid_touch_capture_global')).toHaveLength(0)
  })

  it('PATCH: invalid acknowledgements from rotating addresses do not consume the global budget', async () => {
    const { PATCH } = await import('@/app/api/attribution/paid-touch/route')
    const { issuePaidTouchToken } = await import('@/lib/attribution/paid-touch-contract')
    const token = issuePaidTouchToken('00000000-0000-4000-8000-000000000724', process.env.PAID_TOUCH_TOKEN_SECRET!)
    const invalidShapes: unknown[] = [{}, { capture_id: captureBody.capture_id, token: 'forged', delivery_status: 'scheduler_decorated' }, []]
    let n = 0
    for (; n < 4_050; n++) {
      expect((await PATCH(request('PATCH', invalidShapes[n % invalidShapes.length], freshAddress(n)))).status).toBe(400)
    }
    expect(state.calls.filter((call) => call.bucket === 'paid_touch_delivery_ack_global')).toHaveLength(0)

    const ack = { capture_id: captureBody.capture_id, token, delivery_status: 'scheduler_decorated' }
    expect((await PATCH(request('PATCH', ack, freshAddress(n)))).status).toBe(200)
    expect(state.recordDelivery).toHaveBeenCalledTimes(1)
  })

  it('a client already over its own limit does not drain the global budget', async () => {
    const { POST } = await import('@/app/api/attribution/paid-touch/route')
    for (let n = 0; n < 40; n++) await POST(request('POST', captureBody, '203.0.113.9'))
    const globalCalls = state.calls.filter((call) => call.bucket === 'paid_touch_capture_global')
    // 30 per-client admissions reach the global bucket; the 10 rejected ones do not.
    expect(globalCalls).toHaveLength(30)
  })
})
