import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

// Fix 3: in production a cookie-session mutation that carries neither Sec-Fetch-Site nor Origin is
// refused. Every current browser sends at least one of them on a POST/PATCH/DELETE, so a request with
// neither is not a browser request from this app.
const mocks = vi.hoisted(() => ({ user: vi.fn() }))
vi.mock('@supabase/ssr', () => ({ createServerClient: () => ({ auth: { getUser: mocks.user } }) }))

const APP = 'https://app.example.test'
function production() {
  vi.stubEnv('NODE_ENV', 'production')
  vi.stubEnv('VERCEL_ENV', 'production')
}

beforeEach(() => {
  vi.resetModules()
  vi.stubEnv('OWNER_EMAIL', 'owner@example.test')
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://project.supabase.co')
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'anon-key-fixture')
  mocks.user.mockReset().mockResolvedValue({
    data: { user: { email: 'owner@example.test', email_confirmed_at: '2026-01-01T00:00:00Z' } }, error: null,
  })
})
afterEach(() => vi.unstubAllEnvs())

describe('rejectCrossOriginMutation', () => {
  it('production: refuses a mutation with neither Sec-Fetch-Site nor Origin', async () => {
    production()
    const { rejectCrossOriginMutation } = await import('@/lib/security/same-origin')
    expect(rejectCrossOriginMutation(new Request(`${APP}/api/settings`, { method: 'POST' }))?.status).toBe(403)
  })

  it('production control: a same-origin browser request passes (Sec-Fetch-Site alone, Origin alone, or both)', async () => {
    production()
    const { rejectCrossOriginMutation } = await import('@/lib/security/same-origin')
    const browserHeaders: Record<string, string>[] = [
      { 'sec-fetch-site': 'same-origin' },
      { origin: APP },
      { 'sec-fetch-site': 'same-origin', origin: APP },
    ]
    for (const headers of browserHeaders) {
      expect(rejectCrossOriginMutation(new Request(`${APP}/api/settings`, { method: 'POST', headers }))).toBeNull()
    }
  })

  it('production: cross-site and foreign-Origin requests are still refused', async () => {
    production()
    const { rejectCrossOriginMutation } = await import('@/lib/security/same-origin')
    expect(rejectCrossOriginMutation(new Request(`${APP}/x`, { method: 'POST', headers: { 'sec-fetch-site': 'cross-site' } }))?.status).toBe(403)
    expect(rejectCrossOriginMutation(new Request(`${APP}/x`, { method: 'POST', headers: { origin: 'https://evil.test' } }))?.status).toBe(403)
  })

  it('development control: header-less local tooling (curl, tests) keeps working', async () => {
    vi.stubEnv('NODE_ENV', 'development')
    vi.stubEnv('VERCEL_ENV', '')
    const { rejectCrossOriginMutation } = await import('@/lib/security/same-origin')
    expect(rejectCrossOriginMutation(new Request('http://localhost:3000/api/settings', { method: 'POST' }))).toBeNull()
  })
})

describe('proxy in production', () => {
  it('refuses a header-less cookie-session API mutation before reading the session', async () => {
    production()
    const { proxy } = await import('@/proxy')
    const res = await proxy(new NextRequest(`${APP}/api/settings`, { method: 'POST' }))
    expect(res.status).toBe(403)
    expect(mocks.user).not.toHaveBeenCalled()
  })

  it('control: a same-origin owner mutation still reaches the route', async () => {
    production()
    const { proxy } = await import('@/proxy')
    const res = await proxy(new NextRequest(`${APP}/api/settings`, { method: 'POST', headers: { 'sec-fetch-site': 'same-origin', origin: APP } }))
    expect(res.headers.get('x-middleware-next')).toBe('1')
  })

  it('does not apply to header-less GET', async () => {
    production()
    const { proxy } = await import('@/proxy')
    expect((await proxy(new NextRequest(`${APP}/api/settings`))).headers.get('x-middleware-next')).toBe('1')
  })

  it.each(['/api/cron/daily-sync', '/api/webhooks/acuity', '/api/sync/midday', '/api/attribution/paid-touch'])(
    'machine-authenticated / public endpoint %s is untouched by header-less POSTs',
    async (path) => {
      production()
      const { proxy } = await import('@/proxy')
      const res = await proxy(new NextRequest(`${APP}${path}`, { method: 'POST', headers: { authorization: 'Bearer cron-secret-fixture' } }))
      expect(res.headers.get('x-middleware-next')).toBe('1')
      expect(mocks.user).not.toHaveBeenCalled()
    },
  )
})
