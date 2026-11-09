import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

// an unconfigured install opens the setup checklist instead of a broken dashboard. Without the
// Supabase public values nobody can sign in, so /setup is the one page served (names only, see the
// page) and every API answers 503. Once sign-in is possible, /setup needs the owner like any page.

const state = vi.hoisted(() => ({ user: null as Record<string, unknown> | null, created: 0 }))
vi.mock('@supabase/ssr', () => ({
  createServerClient: () => { state.created++; return { auth: { getUser: async () => ({ data: { user: state.user }, error: null }) } } },
}))

beforeEach(() => {
  vi.resetModules()
  state.user = null
  state.created = 0
  vi.stubEnv('OWNER_EMAIL', 'owner@example.test')
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', '')
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', '')
})
afterEach(() => vi.unstubAllEnvs())

async function call(path: string, init?: { method?: string }) {
  const { proxy } = await import('@/proxy')
  return proxy(new NextRequest(`http://localhost${path}`, init))
}

describe('proxy with Supabase not configured', () => {
  it('sends every page to /setup and serves /setup itself, without creating a Supabase client', async () => {
    expect((await call('/dashboard')).headers.get('location')).toBe('http://localhost/setup')
    expect((await call('/')).headers.get('location')).toBe('http://localhost/setup')
    expect((await call('/setup')).headers.get('x-middleware-next')).toBe('1')
    expect(state.created).toBe(0)
  })

  it('answers 503 with a setup code on every API route', async () => {
    const res = await call('/api/ads')
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ code: 'SETUP_INCOMPLETE' })
  })
})

describe('proxy once Supabase is configured (controls)', () => {
  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://abcdefghijkl.supabase.co')
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0')
  })

  it('/setup requires a session like any page', async () => {
    expect((await call('/setup')).headers.get('location')).toBe('http://localhost/login?next=%2Fsetup')
  })

  it('/setup is served without a session only when OWNER_EMAIL is unset (nobody could sign in)', async () => {
    vi.stubEnv('OWNER_EMAIL', '')
    vi.stubEnv('VERCEL_ENV', 'production')
    expect((await call('/setup')).headers.get('x-middleware-next')).toBe('1')
    expect((await call('/dashboard')).headers.get('location')).toBe('http://localhost/login?next=%2Fdashboard')
  })

  it('the owner reaches /setup', async () => {
    state.user = { email: 'owner@example.test', email_confirmed_at: '2026-01-01T00:00:00Z' }
    expect((await call('/setup')).headers.get('x-middleware-next')).toBe('1')
  })
})

describe('setup access mode', () => {
  it('is public only when no one can sign in, otherwise owner', async () => {
    const { setupAccessMode } = await import('@/lib/setup/access')
    expect(setupAccessMode({})).toBe('public')
    expect(setupAccessMode({ NEXT_PUBLIC_SUPABASE_URL: 'https://x.supabase.co', NEXT_PUBLIC_SUPABASE_ANON_KEY: 'k', VERCEL_ENV: 'production' })).toBe('public')
    expect(setupAccessMode({ NEXT_PUBLIC_SUPABASE_URL: 'https://x.supabase.co', NEXT_PUBLIC_SUPABASE_ANON_KEY: 'k', VERCEL_ENV: 'production', OWNER_EMAIL: 'o@example.test' })).toBe('owner')
    // the owner gate denies everyone without OWNER_EMAIL in development too, so nobody can sign in
    expect(setupAccessMode({ NEXT_PUBLIC_SUPABASE_URL: 'https://x.supabase.co', NEXT_PUBLIC_SUPABASE_ANON_KEY: 'k' })).toBe('public')
    expect(setupAccessMode({ NEXT_PUBLIC_SUPABASE_URL: 'https://x.supabase.co', NEXT_PUBLIC_SUPABASE_ANON_KEY: 'k', OWNER_EMAIL: 'o@example.test' })).toBe('owner')
  })
})
