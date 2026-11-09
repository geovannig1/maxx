import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const authState = vi.hoisted(() => ({ email: null as string | null }))

vi.mock('@supabase/ssr', () => ({
  createServerClient: () => ({
    auth: {
      getUser: async () => ({
        data: { user: authState.email ? { email: authState.email, email_confirmed_at: '2026-01-01T00:00:00Z' } : null },
      }),
    },
  }),
}))

describe('API owner gate in proxy', () => {
  beforeEach(() => {
    vi.resetModules()
    authState.email = null
    process.env.OWNER_EMAIL = 'owner@example.com'
    // A configured install (without these the proxy serves only /setup).
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://project.supabase.co')
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'anon-key-fixture')
  })

  afterEach(() => {
    delete process.env.OWNER_EMAIL
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it('returns JSON 401 before a protected API route for an unauthenticated caller', async () => {
    const { proxy } = await import('@/proxy')
    const response = await proxy(new NextRequest('http://localhost/api/ads'))

    expect(response.status).toBe(401)
    expect(await response.json()).toMatchObject({ error: 'Unauthorized' })
  })

  it('returns JSON 403 before a protected API route for an authenticated non-owner', async () => {
    authState.email = 'other@example.com'
    const { proxy } = await import('@/proxy')
    const response = await proxy(new NextRequest('http://localhost/api/ads'))

    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ error: 'Forbidden — owner only.' })
  })

  it('allows the owner through to the protected API route', async () => {
    authState.email = 'owner@example.com'
    const { proxy } = await import('@/proxy')
    const response = await proxy(new NextRequest('http://localhost/api/ads'))

    expect(response.status).toBe(200)
    expect(response.headers.get('x-middleware-next')).toBe('1')
  })

  it.each([
    '/api/cron/daily-sync',
    '/api/webhooks/acuity',
    '/api/sync/midday',
    // ADR-056 capture: anonymous marketing-site visitors, so no owner session can exist. Shipped
    // without this entry, which made the endpoint permanently unreachable in production — the
    // handler tests all pass because they invoke the handler directly and never cross the proxy.
    '/api/attribution/paid-touch',
  ])(
    'leaves machine-authenticated endpoint %s to its route-level secret/owner guard',
    async (pathname) => {
      const { proxy } = await import('@/proxy')
      const response = await proxy(new NextRequest(`http://localhost${pathname}`))
      expect(response.status).toBe(200)
      expect(response.headers.get('x-middleware-next')).toBe('1')
    },
  )

  it('passes the paid-touch CORS preflight through so the browser can complete it', async () => {
    const { proxy } = await import('@/proxy')
    const response = await proxy(new NextRequest('http://localhost/api/attribution/paid-touch', {
      method: 'OPTIONS',
      headers: { origin: 'https://example-studio.test' },
    }))
    expect(response.status).toBe(200)
    expect(response.headers.get('x-middleware-next')).toBe('1')
  })

  it.each([
    '/api/attribution',
    '/api/attribution/',
    '/api/attribution/paid-touch/extra',
    '/api/attribution/something-else',
  ])('keeps %s owner-gated — the capture bypass is an exact match, not a prefix', async (pathname) => {
    const { proxy } = await import('@/proxy')
    const response = await proxy(new NextRequest(`http://localhost${pathname}`))
    expect(response.status).toBe(401)
  })
})
