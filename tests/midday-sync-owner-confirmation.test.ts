import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// /api/sync/midday is exempt from src/proxy.ts (it also accepts a cron secret), so its session
// fallback is the only place the owner's confirmed-email requirement can be enforced. It must pass
// the Supabase user, not just the email, to the owner gate.
const state = vi.hoisted(() => ({
  user: null as Record<string, unknown> | null,
  limiter: vi.fn(async () => Response.json({ error: 'limited', code: 'RATE_LIMITED' }, { status: 429 })),
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: state.user } }) } }),
}))
vi.mock('@/lib/security/api-rate-limit', () => ({ enforceApiRateLimit: state.limiter }))
vi.mock('@/lib/supabase/admin', () => ({
  getAdminClient: () => { throw new Error('database should not be reached in this test') },
}))

function sessionRequest() {
  return new Request('https://maxx.example/api/sync/midday', {
    headers: { origin: 'https://maxx.example', 'sec-fetch-site': 'same-origin', host: 'maxx.example' },
  })
}

describe('midday sync session fallback requires a confirmed owner email', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.stubEnv('OWNER_EMAIL', 'owner@example.test')
    vi.stubEnv('CRON_SECRET', 'test-only-secret-that-is-long-enough-for-hmac')
    state.limiter.mockClear()
  })
  afterEach(() => vi.unstubAllEnvs())

  it('denies an unconfirmed user who carries the owner email', async () => {
    state.user = { id: 'u1', email: 'owner@example.test', email_confirmed_at: null }
    const { GET } = await import('@/app/api/sync/midday/route')
    const response = await GET(sessionRequest())
    expect(response.status).toBe(403)
    expect(state.limiter).not.toHaveBeenCalled()
  })

  it('control: a confirmed owner passes the owner gate (reaches the rate limiter)', async () => {
    state.user = { id: 'u1', email: 'owner@example.test', email_confirmed_at: '2026-01-01T00:00:00Z' }
    const { GET } = await import('@/app/api/sync/midday/route')
    const response = await GET(sessionRequest())
    expect(state.limiter).toHaveBeenCalledOnce()
    expect(response.status).toBe(429)
  })
})
