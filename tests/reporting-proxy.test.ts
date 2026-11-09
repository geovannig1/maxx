import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
const mocks = vi.hoisted(() => ({ user: vi.fn() }))
vi.mock('@supabase/ssr', () => ({ createServerClient: () => ({ auth: { getUser: mocks.user } }) }))
import { proxy } from '@/proxy'

describe('reporting session verification at the proxy', () => {
  beforeEach(() => {
    vi.stubEnv('OWNER_EMAIL', 'owner@example.test')
    // A configured install (without these the proxy serves only /setup).
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://project.supabase.co')
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'anon-key-fixture')
    mocks.user.mockReset().mockResolvedValue({ data: { user: { email: 'owner@example.test', email_confirmed_at: '2026-01-01T00:00:00Z' } }, error: null })
  })
  afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs() })
  it('bounds unavailable authentication before the route without granting access', async () => {
    vi.useFakeTimers()
    mocks.user.mockReturnValue(new Promise(() => {}))
    let response: Response | undefined
    const finished = proxy(new NextRequest('http://localhost/api/reporting')).then(value => { response = value })
    await vi.advanceTimersByTimeAsync(10_001)
    expect(response?.status).toBe(503)
    await finished
    expect(response!.headers.get('x-middleware-next')).toBeNull()
    expect(response!.headers.get('cache-control')).toContain('no-store')
  })
  it('does not turn provider outages into sign-in requests or expose provider details', async () => {
    mocks.user.mockResolvedValue({ data: { user: null }, error: { status: 503, message: 'private-token' } })
    const response = await proxy(new NextRequest('http://localhost/api/reporting'))
    expect(response.status).toBe(503)
    expect(await response.text()).not.toContain('private-token')
    expect(response.headers.get('x-middleware-next')).toBeNull()
  })
  it('still distinguishes an owner, a non-owner and no session', async () => {
    expect((await proxy(new NextRequest('http://localhost/api/reporting'))).headers.get('x-middleware-next')).toBe('1')
    mocks.user.mockResolvedValue({ data: { user: { email: 'other@example.test', email_confirmed_at: '2026-01-01T00:00:00Z' } } })
    expect((await proxy(new NextRequest('http://localhost/api/reporting'))).status).toBe(403)
    mocks.user.mockResolvedValue({ data: { user: null }, error: { status: 400 } })
    expect((await proxy(new NextRequest('http://localhost/api/reporting'))).status).toBe(401)
  })
})
