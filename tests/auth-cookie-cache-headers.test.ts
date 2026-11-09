import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

// A response that carries Set-Cookie for a Supabase session must not be cacheable by a CDN or proxy,
// or one user's session could be served to another. @supabase/ssr 0.12.4 passes the headers to use as
// setAll's SECOND argument (dist/main/cookies.js applyServerStorage):
//   { 'Cache-Control': 'private, no-cache, no-store, must-revalidate, max-age=0', Expires: '0', Pragma: 'no-cache' }
// and passes {} from its other write paths. These tests replay both payloads through each server
// client factory that owns a response and check the response headers.
const LIBRARY_HEADERS = {
  'Cache-Control': 'private, no-cache, no-store, must-revalidate, max-age=0',
  Expires: '0',
  Pragma: 'no-cache',
}
const SESSION_WRITE = [{ name: 'sb-project-auth-token', value: 'session', options: { path: '/', maxAge: 400 * 24 * 3600 } }]

type SetAll = (cookies: typeof SESSION_WRITE, headers: Record<string, string>) => void
const state = vi.hoisted(() => ({
  setAll: null as null | SetAll,
  writeHeaders: {} as Record<string, string> | null, // null: the library writes no cookie this request
  exchangeError: null as null | { code: string; status: number },
}))

function libraryWrite() {
  if (state.writeHeaders !== null) state.setAll!(SESSION_WRITE, state.writeHeaders)
}

vi.mock('@supabase/ssr', () => ({
  createServerClient: (_url: string, _key: string, options: { cookies: { setAll: SetAll } }) => {
    state.setAll = options.cookies.setAll
    const user = { email: 'owner@example.test', email_confirmed_at: '2026-01-01T00:00:00Z' }
    return {
      auth: {
        getUser: async () => { libraryWrite(); return { data: { user }, error: null } },
        exchangeCodeForSession: async () => { libraryWrite(); return { error: state.exchangeError } },
        signOut: async () => { libraryWrite(); return { error: null } },
      },
    }
  },
}))

vi.mock('next/headers', () => ({
  cookies: async () => ({ getAll: () => [], set: () => undefined }),
}))

const APP = 'https://app.example.test'

function expectNotCacheable(res: Response) {
  const cacheControl = res.headers.get('cache-control') ?? ''
  expect(cacheControl).toContain('no-store')
  expect(cacheControl).toContain('private')
  expect(res.headers.get('expires')).toBe('0')
  expect(res.headers.get('pragma')).toBe('no-cache')
}

beforeEach(() => {
  vi.resetModules()
  state.setAll = null
  state.writeHeaders = LIBRARY_HEADERS
  state.exchangeError = null
  vi.stubEnv('OWNER_EMAIL', 'owner@example.test')
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://project.supabase.co')
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'anon-key-fixture')
})
afterEach(() => vi.unstubAllEnvs())

describe('proxy: session refresh responses are not cacheable', () => {
  it('a page response that refreshes the session carries the library cache headers with Set-Cookie', async () => {
    const { proxy } = await import('@/proxy')
    const res = await proxy(new NextRequest(`${APP}/dashboard`))
    expect(res.headers.get('set-cookie')).toContain('sb-project-auth-token=session')
    expectNotCacheable(res)
  })

  it('an owner API response that refreshes the session carries them too', async () => {
    const { proxy } = await import('@/proxy')
    const res = await proxy(new NextRequest(`${APP}/api/campaigns`))
    expect(res.headers.get('set-cookie')).toContain('sb-project-auth-token=session')
    expectNotCacheable(res)
  })

  it('a cookie write that arrives with no headers ({}) is still made non-cacheable', async () => {
    state.writeHeaders = {}
    const { proxy } = await import('@/proxy')
    const res = await proxy(new NextRequest(`${APP}/dashboard`))
    expect(res.headers.get('set-cookie')).toContain('sb-project-auth-token=session')
    expectNotCacheable(res)
  })

  it('control: a request that writes no cookie gets no cache headers from the proxy', async () => {
    state.writeHeaders = null
    const { proxy } = await import('@/proxy')
    const res = await proxy(new NextRequest(`${APP}/dashboard`))
    expect(res.headers.get('set-cookie')).toBeNull()
    expect(res.headers.get('cache-control')).toBeNull()
  })
})

describe('auth callback: the session-creating redirect is not cacheable', () => {
  it('successful code exchange', async () => {
    const { GET } = await import('@/app/auth/callback/route')
    const res = await GET(new NextRequest(`${APP}/auth/callback?code=one-time-code`))
    expect(res.headers.get('location')).toBe(`${APP}/dashboard`)
    expectNotCacheable(res)
  })

  it('failed code exchange (the library may still clear verifier cookies)', async () => {
    state.exchangeError = { code: 'flow_state_not_found', status: 400 }
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { GET } = await import('@/app/auth/callback/route')
    const res = await GET(new NextRequest(`${APP}/auth/callback?code=one-time-code`))
    expect(res.headers.get('location')).toBe(`${APP}/login?error=auth`)
    expectNotCacheable(res)
  })
})

describe('sign-out: the cookie-clearing redirect applies the library cache headers', () => {
  it('carries Cache-Control, Expires and Pragma', async () => {
    const { POST } = await import('@/app/auth/signout/route')
    const res = await POST(new NextRequest(`${APP}/auth/signout`, {
      method: 'POST',
      headers: { 'sec-fetch-site': 'same-origin', origin: APP, cookie: 'sb-project-auth-token=old' },
    }))
    expect(res.status).toBe(303)
    expectNotCacheable(res)
  })
})

describe('applyAuthCookieCacheHeaders', () => {
  it('keeps extra library headers but never lets a caller weaken Cache-Control', async () => {
    const { applyAuthCookieCacheHeaders } = await import('@/lib/supabase/cookie-options')
    const headers = new Headers()
    applyAuthCookieCacheHeaders(headers, { 'Cache-Control': 'public, max-age=600', 'X-Extra': '1' })
    expect(headers.get('cache-control')).toBe(LIBRARY_HEADERS['Cache-Control'])
    expect(headers.get('x-extra')).toBe('1')
  })
})
