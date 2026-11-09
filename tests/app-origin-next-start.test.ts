import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

// Browser finding: under `next start`, request.url always has host `localhost`, whatever host the
// browser used. Same-origin checks and auth redirects must use APP_URL (the operator's public origin),
// never the client's Host/X-Forwarded-Host, and must still refuse a foreign Origin.

const APP = 'https://app.example.test'
const INTERNAL = 'http://localhost:3917'

vi.mock('next/headers', () => ({ cookies: async () => ({ getAll: () => [], set: vi.fn() }) }))
const auth = vi.hoisted(() => ({ exchange: vi.fn(), signOut: vi.fn() }))
vi.mock('@supabase/ssr', () => ({
  createServerClient: () => ({ auth: { exchangeCodeForSession: auth.exchange, signOut: auth.signOut } }),
}))

beforeEach(() => {
  vi.resetModules()
  auth.exchange.mockReset().mockResolvedValue({ error: null })
  auth.signOut.mockReset().mockResolvedValue({ error: null })
  vi.stubEnv('NODE_ENV', 'production')
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://project.supabase.co')
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'anon-key-fixture')
  vi.stubEnv('APP_URL', `${APP}/`)
})
afterEach(() => vi.unstubAllEnvs())

const mutation = (origin: string, extra: Record<string, string> = {}) =>
  new Request(`${INTERNAL}/api/settings`, {
    method: 'POST', headers: { origin, 'sec-fetch-site': 'same-origin', host: 'app.example.test', ...extra },
  })

describe('same-origin check behind next start', () => {
  it('accepts the configured public origin although request.url says localhost', async () => {
    const { rejectCrossOriginMutation } = await import('@/lib/security/same-origin')
    expect(rejectCrossOriginMutation(mutation(APP))).toBeNull()
  })

  it('still refuses a foreign Origin, and does not trust a spoofed X-Forwarded-Host', async () => {
    const { rejectCrossOriginMutation } = await import('@/lib/security/same-origin')
    expect(rejectCrossOriginMutation(mutation('https://evil.example'))?.status).toBe(403)
    expect(rejectCrossOriginMutation(mutation('https://evil.example', { 'x-forwarded-host': 'evil.example' }))?.status).toBe(403)
    expect(rejectCrossOriginMutation(mutation(APP, { 'sec-fetch-site': 'cross-site' }))?.status).toBe(403)
  })

  it('without APP_URL the public origin is not assumed (fail closed)', async () => {
    vi.stubEnv('APP_URL', '')
    const { rejectCrossOriginMutation } = await import('@/lib/security/same-origin')
    expect(rejectCrossOriginMutation(mutation(APP))?.status).toBe(403)
  })
})

describe('auth redirects behind next start', () => {
  it('the magic-link callback redirects to the configured origin, not localhost', async () => {
    const { GET } = await import('@/app/auth/callback/route')
    const ok = await GET(new NextRequest(`${INTERNAL}/auth/callback?code=c&next=%2Fdashboard`))
    expect(ok.headers.get('location')).toBe(`${APP}/dashboard`)
    auth.exchange.mockResolvedValue({ error: { code: 'x', status: 400 } })
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const failed = await GET(new NextRequest(`${INTERNAL}/auth/callback?code=c`))
    expect(failed.headers.get('location')).toBe(`${APP}/login?error=auth`)
  })

  it('sign-out accepts the genuinely same-origin POST and redirects to the configured /login', async () => {
    const { POST } = await import('@/app/auth/signout/route')
    const res = await POST(new NextRequest(`${INTERNAL}/auth/signout`, {
      method: 'POST', headers: { origin: APP, 'sec-fetch-site': 'same-origin' },
    }))
    expect(res.status).toBe(303)
    expect(auth.signOut).toHaveBeenCalledTimes(1)
    expect(res.headers.get('location')).toBe(`${APP}/login`)
  })
})

describe('app origin resolution', () => {
  it('uses APP_URL, then Vercel hosts for the allow-list, and ignores a non-http APP_URL', async () => {
    const { allowedAppOrigins, appOrigin } = await import('@/lib/security/app-origin')
    const req = new Request(`${INTERNAL}/x`)
    expect(appOrigin(req, { APP_URL: `${APP}/path` })).toBe(APP)
    expect(appOrigin(req, {})).toBe(INTERNAL)
    expect(appOrigin(req, { APP_URL: 'javascript:alert(1)' })).toBe(INTERNAL)
    expect([...allowedAppOrigins(req, { VERCEL: '1', VERCEL_PROJECT_PRODUCTION_URL: 'maxx.example.test', VERCEL_URL: 'maxx-abc.vercel.app' })].sort())
      .toEqual(['http://localhost:3917', 'https://maxx-abc.vercel.app', 'https://maxx.example.test'])
    expect([...allowedAppOrigins(req, { VERCEL_URL: 'maxx-abc.vercel.app' })]).toEqual([INTERNAL])
  })
})
