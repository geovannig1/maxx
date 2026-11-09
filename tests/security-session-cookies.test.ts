import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest, type NextResponse } from 'next/server'

// Fix 1 (session cookies). @supabase/ssr 0.12.4 hands every server write to our setAll callback with
// its own defaults: { path: '/', sameSite: 'lax', httpOnly: false, maxAge: 400 days }, and it
// overwrites any cookieOptions.maxAge with that 400-day default (dist/main/cookies.js:461-465), so
// the lifetime can only be bounded inside setAll. These tests replay exactly that library payload
// through each server client factory and check what reaches the Set-Cookie header.
const SESSION = 'sb-project-auth-token'
const SESSION_CHUNK = 'sb-project-auth-token.0'
const VERIFIER = 'sb-project-auth-token-code-verifier'
const FLOW_INDEX = 'sb-project-auth-token-flows-code-verifier'
const LIBRARY_SET = { path: '/', sameSite: 'lax' as const, httpOnly: false, maxAge: 400 * 24 * 60 * 60 }
const LIBRARY_REMOVE = { ...LIBRARY_SET, maxAge: 0 }
const SEVEN_DAYS = 7 * 24 * 60 * 60

type SetAll = (cookies: { name: string; value: string; options: Record<string, unknown> }[]) => void
const state = vi.hoisted(() => ({
  serverOptions: [] as { cookies: { setAll: SetAll } }[],
  browserOptions: [] as unknown[],
  writes: [] as { name: string; value: string; options: Record<string, unknown> }[],
  headerSet: vi.fn(),
}))

function libraryWrite() {
  const options = state.serverOptions.at(-1)!
  options.cookies.setAll([
    { name: SESSION, value: 'session-value', options: LIBRARY_SET },
    { name: SESSION_CHUNK, value: 'chunk-value', options: LIBRARY_SET },
    { name: FLOW_INDEX, value: '["flow-aaaaaaaa"]', options: LIBRARY_SET },
    { name: VERIFIER, value: '', options: LIBRARY_REMOVE },
  ])
}

vi.mock('@supabase/ssr', () => ({
  createServerClient: (_url: string, _key: string, options: { cookies: { setAll: SetAll } }) => {
    state.serverOptions.push(options)
    return {
      auth: {
        getUser: async () => {
          libraryWrite()
          return { data: { user: { email: 'owner@example.test', email_confirmed_at: '2026-01-01T00:00:00Z' } }, error: null }
        },
        exchangeCodeForSession: async () => { libraryWrite(); return { error: null } },
      },
    }
  },
  createBrowserClient: (_url: string, _key: string, options: unknown) => {
    state.browserOptions.push(options)
    return { auth: {} }
  },
}))

vi.mock('next/headers', () => ({
  cookies: async () => ({
    getAll: () => [],
    set: (name: string, value: string, options: Record<string, unknown>) => state.writes.push({ name, value, options }),
  }),
}))

function production() {
  vi.stubEnv('NODE_ENV', 'production')
  vi.stubEnv('VERCEL_ENV', 'production')
}
function development() {
  vi.stubEnv('NODE_ENV', 'development')
  vi.stubEnv('VERCEL_ENV', '')
}

beforeEach(() => {
  vi.resetModules()
  state.serverOptions.length = 0
  state.browserOptions.length = 0
  state.writes.length = 0
  vi.stubEnv('OWNER_EMAIL', 'owner@example.test')
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://project.supabase.co')
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'anon-key-fixture')
})
afterEach(() => vi.unstubAllEnvs())

function responseWrites(res: Response) {
  return (res as NextResponse).cookies.getAll().map((c) => ({ name: c.name, options: c as unknown as Record<string, unknown> }))
}

function byName(writes: { name: string; options: Record<string, unknown> }[], name: string) {
  const found = writes.filter((w) => w.name === name).at(-1)
  expect(found, `no write for ${name}`).toBeDefined()
  return found!.options
}

function expectHardenedSession(options: Record<string, unknown>, secure: boolean) {
  expect(options).toMatchObject({ path: '/', sameSite: 'lax', httpOnly: true, maxAge: SEVEN_DAYS, secure })
}

describe('server-written Supabase cookies', () => {
  it('proxy: production session cookies are Secure, SameSite=Lax, HttpOnly and capped at 7 days', async () => {
    production()
    const { proxy } = await import('@/proxy')
    const res = await proxy(new NextRequest('https://app.example.test/dashboard'))
    const cookies = responseWrites(res)
    expectHardenedSession(byName(cookies, SESSION), true)
    expectHardenedSession(byName(cookies, SESSION_CHUNK), true)
    const header = res.headers.get('set-cookie') ?? ''
    expect(header).toContain('Secure')
    expect(header).toContain('HttpOnly')
    expect(header).toContain(`Max-Age=${SEVEN_DAYS}`)
    expect(header).not.toContain(`Max-Age=${400 * 24 * 60 * 60}`)
  })

  it('proxy: PKCE verifier cookies stay readable by the browser client, and removals stay removals', async () => {
    production()
    const { proxy } = await import('@/proxy')
    const res = await proxy(new NextRequest('https://app.example.test/dashboard'))
    const cookies = responseWrites(res)
    expect(byName(cookies, FLOW_INDEX)).toMatchObject({ httpOnly: false, secure: true, sameSite: 'lax', maxAge: SEVEN_DAYS })
    expect(byName(cookies, VERIFIER)).toMatchObject({ maxAge: 0 })
  })

  it('proxy control: development keeps cookies usable on http://localhost (no Secure)', async () => {
    development()
    const { proxy } = await import('@/proxy')
    const res = await proxy(new NextRequest('http://localhost:3000/dashboard'))
    expectHardenedSession(byName(responseWrites(res), SESSION), false)
    expect(res.headers.get('set-cookie') ?? '').not.toContain('Secure')
  })

  it('server.ts createClient applies the same policy', async () => {
    production()
    const { createClient } = await import('@/lib/supabase/server')
    const client = await createClient()
    await client.auth.getUser()
    expectHardenedSession(byName(state.writes, SESSION), true)
    expect(byName(state.writes, FLOW_INDEX)).toMatchObject({ httpOnly: false })
  })

  it('auth callback applies the same policy to the session it creates', async () => {
    production()
    const { GET } = await import('@/app/auth/callback/route')
    await GET(new NextRequest('https://app.example.test/auth/callback?code=one-time-code'))
    expectHardenedSession(byName(state.writes, SESSION), true)
    expect(byName(state.writes, VERIFIER)).toMatchObject({ maxAge: 0 })
  })
})

describe('browser client cookie options', () => {
  it('production: Secure and SameSite=Lax, never HttpOnly (document.cookie cannot set it)', async () => {
    production()
    const { createClient } = await import('@/lib/supabase/client')
    createClient()
    const options = state.browserOptions.at(-1) as { cookieOptions?: Record<string, unknown> }
    expect(options.cookieOptions).toMatchObject({ secure: true, sameSite: 'lax', path: '/' })
    expect(options.cookieOptions).not.toHaveProperty('httpOnly')
  })

  it('development control: no Secure flag so http://localhost sign-in still works', async () => {
    development()
    const { createClient } = await import('@/lib/supabase/client')
    createClient()
    const options = state.browserOptions.at(-1) as { cookieOptions?: Record<string, unknown> }
    expect(options.cookieOptions).toMatchObject({ secure: false, sameSite: 'lax' })
  })
})
