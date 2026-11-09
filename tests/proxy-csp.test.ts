import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { getScriptNonceFromHeader } from 'next/dist/server/app-render/get-script-nonce-from-header'

// src/proxy.ts sets the one Content-Security-Policy. Every page response gets a fresh script
// nonce, and the same nonce is forwarded to the render in the request's CSP header (where Next.js
// reads it to stamp its scripts) and as x-nonce (where the root layout reads it). API responses get
// a strict policy with no nonce, and their requests are not given one.

const state = vi.hoisted(() => ({ user: null as Record<string, unknown> | null }))
vi.mock('@supabase/ssr', () => ({
  createServerClient: () => ({ auth: { getUser: async () => ({ data: { user: state.user }, error: null }) } }),
}))

const OWNER = { email: 'owner@example.test', email_confirmed_at: '2026-01-01T00:00:00Z' }

beforeEach(() => {
  vi.resetModules()
  state.user = null
  vi.stubEnv('OWNER_EMAIL', 'owner@example.test')
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://abcdefghijkl.supabase.co')
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'anon-key-fixture')
})
afterEach(() => vi.unstubAllEnvs())

async function call(path: string, init?: { method?: string; headers?: Record<string, string> }) {
  const { proxy } = await import('@/proxy')
  return proxy(new NextRequest(`https://app.example.test${path}`, init))
}

const policyOf = (response: Response) => response.headers.get('content-security-policy') ?? ''
/** What the proxy forwards to the render (NextResponse.next({ request }) encodes it this way). */
const forwarded = (response: Response, name: string) => response.headers.get(`x-middleware-request-${name}`)

describe('proxy Content-Security-Policy on pages', () => {
  it('a passed-through page gets a nonce policy, and the render receives the same nonce twice', async () => {
    state.user = OWNER
    const res = await call('/dashboard')
    expect(res.headers.get('x-middleware-next')).toBe('1')
    const nonce = getScriptNonceFromHeader(policyOf(res))
    expect(nonce).toMatch(/^[A-Za-z0-9+/]+={0,2}$/)
    expect(policyOf(res)).toContain(`script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`)
    expect(forwarded(res, 'x-nonce')).toBe(nonce)
    expect(forwarded(res, 'content-security-policy')).toBe(policyOf(res))
    expect(res.headers.get('x-middleware-override-headers')?.split(',')).toEqual(expect.arrayContaining(['x-nonce', 'content-security-policy']))
  })

  it('every request gets a fresh nonce', async () => {
    state.user = OWNER
    const nonces = new Set<string | undefined>()
    for (let i = 0; i < 5; i++) nonces.add(getScriptNonceFromHeader(policyOf(await call('/dashboard'))))
    expect(nonces.size).toBe(5)
    expect(nonces.has(undefined)).toBe(false)
  })

  it('outside development, scripts never get \'unsafe-inline\' or \'unsafe-eval\'', async () => {
    state.user = OWNER
    const script = policyOf(await call('/dashboard')).split(';').map((d) => d.trim()).find((d) => d.startsWith('script-src')) ?? ''
    expect(script).toMatch(/^script-src 'self' 'nonce-/)
    expect(script).not.toContain("'unsafe-inline'")
    expect(script).not.toContain("'unsafe-eval'")
  })

  it('redirects from page routes carry the page policy too (sign-in and owner-gate redirects)', async () => {
    const login = await call('/dashboard')
    expect(login.headers.get('location')).toBe('https://app.example.test/login?next=%2Fdashboard')
    expect(getScriptNonceFromHeader(policyOf(login))).toBeTruthy()
    state.user = { email: 'someone@example.test', email_confirmed_at: '2026-01-01T00:00:00Z' }
    expect(getScriptNonceFromHeader(policyOf(await call('/dashboard')))).toBeTruthy()
  })

  it('/setup served without a session (Supabase unconfigured) still forwards the nonce to the render', async () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', '')
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', '')
    const res = await call('/setup')
    expect(res.headers.get('x-middleware-next')).toBe('1')
    const nonce = getScriptNonceFromHeader(policyOf(res))
    expect(nonce).toBeTruthy()
    expect(forwarded(res, 'x-nonce')).toBe(nonce)
  })

  it('/setup in public mode (production without OWNER_EMAIL) forwards the nonce too', async () => {
    vi.stubEnv('OWNER_EMAIL', '')
    vi.stubEnv('VERCEL_ENV', 'production')
    const res = await call('/setup')
    expect(res.headers.get('x-middleware-next')).toBe('1')
    expect(forwarded(res, 'x-nonce')).toBe(getScriptNonceFromHeader(policyOf(res)))
  })

  it('a forged x-nonce from the client is replaced, never trusted', async () => {
    state.user = OWNER
    const res = await call('/dashboard', { headers: { 'x-nonce': 'attacker', 'content-security-policy': "script-src 'nonce-attacker'" } })
    const nonce = getScriptNonceFromHeader(policyOf(res))
    expect(nonce).not.toBe('attacker')
    expect(forwarded(res, 'x-nonce')).toBe(nonce)
    expect(forwarded(res, 'content-security-policy')).toBe(policyOf(res))
  })
})

describe('proxy Content-Security-Policy on API routes', () => {
  it('owner API responses, refusals and machine routes get the strict no-nonce policy', async () => {
    state.user = OWNER
    const allowed = await call('/api/settings')
    expect(allowed.headers.get('x-middleware-next')).toBe('1')
    const refused = await call('/api/settings', { method: 'POST', headers: { 'sec-fetch-site': 'cross-site' } })
    expect(refused.status).toBe(403)
    state.user = null
    const unauthorized = await call('/api/settings')
    expect(unauthorized.status).toBe(401)
    const machine = await call('/api/cron/daily-sync')
    for (const res of [allowed, refused, unauthorized, machine]) {
      expect(policyOf(res)).toBe("default-src 'none'; frame-ancestors 'none'")
      expect(forwarded(res, 'x-nonce')).toBeNull()
    }
  })
})
