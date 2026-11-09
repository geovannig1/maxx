import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
const mocks = vi.hoisted(() => ({ user: vi.fn() }))
vi.mock('@supabase/ssr', () => ({ createServerClient: () => ({ auth: { getUser: mocks.user } }) }))
import { proxy } from '@/proxy'

// Every cookie-session API mutation is same-origin only, enforced once in the proxy; the public
// capture endpoint and the machine-authenticated routes are untouched; a signed-in non-owner no
// longer loops between /login and /dashboard.
function req(path: string, init: { method?: string; headers?: Record<string, string> } = {}) {
  return new NextRequest(`https://app.example.test${path}`, { method: init.method ?? 'GET', headers: init.headers })
}

describe('proxy same-origin guard for API mutations', () => {
  beforeEach(() => {
    vi.stubEnv('OWNER_EMAIL', 'owner@example.test')
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://db.example.test')
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'anon-key-fixture')
    mocks.user.mockReset().mockResolvedValue({ data: { user: { email: 'owner@example.test', email_confirmed_at: '2026-01-01T00:00:00Z' } }, error: null })
  })
  afterEach(() => vi.unstubAllEnvs())

  it('refuses a cross-site POST before touching the session', async () => {
    const res = await proxy(req('/api/settings', { method: 'POST', headers: { 'sec-fetch-site': 'cross-site' } }))
    expect(res.status).toBe(403)
    expect(mocks.user).not.toHaveBeenCalled()
  })

  it('refuses a foreign Origin and a sibling-subdomain same-site request', async () => {
    expect((await proxy(req('/api/approvals/1', { method: 'PATCH', headers: { origin: 'https://evil.example.test' } }))).status).toBe(403)
    expect((await proxy(req('/api/approvals/1', { method: 'PATCH', headers: { 'sec-fetch-site': 'same-site' } }))).status).toBe(403)
  })

  it('lets a same-origin owner mutation through to the route', async () => {
    const res = await proxy(req('/api/settings', { method: 'POST', headers: { origin: 'https://app.example.test', 'sec-fetch-site': 'same-origin' } }))
    expect(res.headers.get('x-middleware-next')).toBe('1')
  })

  it('does not apply to GET, to the public paid-touch capture, or to machine-authenticated routes', async () => {
    expect((await proxy(req('/api/settings', { headers: { 'sec-fetch-site': 'cross-site' } }))).headers.get('x-middleware-next')).toBe('1')
    for (const path of ['/api/attribution/paid-touch', '/api/webhooks/acuity', '/api/cron/daily-sync']) {
      const res = await proxy(req(path, { method: 'POST', headers: { 'sec-fetch-site': 'cross-site', origin: 'https://www.example.test' } }))
      expect(res.headers.get('x-middleware-next')).toBe('1')
    }
  })
})

describe('proxy sign-in routing', () => {
  beforeEach(() => {
    vi.stubEnv('OWNER_EMAIL', 'owner@example.test')
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://db.example.test')
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'anon-key-fixture')
  })
  afterEach(() => vi.unstubAllEnvs())

  it('sends the owner from /login to the dashboard', async () => {
    mocks.user.mockResolvedValue({ data: { user: { email: 'owner@example.test', email_confirmed_at: '2026-01-01T00:00:00Z' } }, error: null })
    const res = await proxy(req('/login'))
    expect(res.status).toBe(307)
    expect(res.headers.get('location')).toBe('https://app.example.test/dashboard')
  })

  it('keeps a signed-in non-owner on /login instead of looping', async () => {
    mocks.user.mockResolvedValue({ data: { user: { email: 'intruder@example.test', email_confirmed_at: '2026-01-01T00:00:00Z' } }, error: null })
    const onLogin = await proxy(req('/login?error=unauthorized'))
    expect(onLogin.headers.get('x-middleware-next')).toBe('1')
    const onDashboard = await proxy(req('/dashboard'))
    expect(onDashboard.status).toBe(307)
    expect(onDashboard.headers.get('location')).toBe('https://app.example.test/login?error=unauthorized')
  })
})
