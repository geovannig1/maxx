import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

// Fix 2: the owner gate must require a CONFIRMED email, not only a matching address. A stranger who
// registers OWNER_EMAIL on a project with open sign-ups would otherwise hold an owner session.
const CONFIRMED = '2026-01-01T00:00:00Z'
const state = vi.hoisted(() => ({ user: null as Record<string, unknown> | null, redirect: vi.fn() }))

vi.mock('@supabase/ssr', () => ({
  createServerClient: () => ({ auth: { getUser: async () => ({ data: { user: state.user }, error: null }) } }),
}))
vi.mock('next/headers', () => ({ cookies: async () => ({ getAll: () => [], set: vi.fn() }) }))
vi.mock('next/navigation', () => ({
  redirect: (url: string) => { state.redirect(url); throw new Error(`redirect:${url}`) },
}))

beforeEach(() => {
  vi.resetModules()
  state.user = null
  state.redirect.mockReset()
  vi.stubEnv('OWNER_EMAIL', 'Owner@Example.test ')
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://project.supabase.co')
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'anon-key-fixture')
})
afterEach(() => vi.unstubAllEnvs())

describe('ownerGate with a Supabase user', () => {
  it('denies an UNCONFIRMED user who holds the owner email', async () => {
    const { ownerGate } = await import('@/lib/auth/owner')
    expect(ownerGate({ email: 'owner@example.test' })).toEqual({ allowed: false, reason: 'unconfirmed' })
    expect(ownerGate({ email: 'owner@example.test', email_confirmed_at: null })).toEqual({ allowed: false, reason: 'unconfirmed' })
    expect(ownerGate({ email: 'owner@example.test', email_confirmed_at: '' })).toEqual({ allowed: false, reason: 'unconfirmed' })
  })

  it('does not accept confirmed_at in place of email_confirmed_at (it can come from a phone)', async () => {
    const { ownerGate } = await import('@/lib/auth/owner')
    expect(ownerGate({ email: 'owner@example.test', confirmed_at: CONFIRMED } as never).allowed).toBe(false)
  })

  it('allows the confirmed owner (control), with case and whitespace handling unchanged', async () => {
    const { ownerGate } = await import('@/lib/auth/owner')
    expect(ownerGate({ email: 'owner@example.test', email_confirmed_at: CONFIRMED })).toEqual({ allowed: true, reason: 'ok' })
    expect(ownerGate({ email: '  OWNER@example.TEST ', email_confirmed_at: CONFIRMED })).toEqual({ allowed: true, reason: 'ok' })
  })

  it('denies a confirmed user with another email, and a missing user', async () => {
    const { ownerGate } = await import('@/lib/auth/owner')
    expect(ownerGate({ email: 'intruder@example.test', email_confirmed_at: CONFIRMED })).toEqual({ allowed: false, reason: 'not_owner' })
    expect(ownerGate(null)).toEqual({ allowed: false, reason: 'not_owner' })
  })

  it('still fails closed in production when OWNER_EMAIL is unset, even for a confirmed user', async () => {
    vi.stubEnv('OWNER_EMAIL', '')
    vi.stubEnv('VERCEL_ENV', 'production')
    const { ownerGate } = await import('@/lib/auth/owner')
    expect(ownerGate({ email: 'anyone@example.test', email_confirmed_at: CONFIRMED })).toEqual({ allowed: false, reason: 'unconfigured' })
  })
})

describe('ownerOnly (API routes) with a Supabase user', () => {
  it('returns 403 for an unconfirmed owner email and null for the confirmed owner', async () => {
    const { ownerOnly } = await import('@/lib/auth/require-owner')
    expect(ownerOnly({ email: 'owner@example.test' })?.status).toBe(403)
    expect(ownerOnly({ email: 'owner@example.test', email_confirmed_at: CONFIRMED })).toBeNull()
  })
})

describe('proxy applies the confirmation requirement', () => {
  it('API: unconfirmed owner email gets 403, confirmed owner passes', async () => {
    const { proxy } = await import('@/proxy')
    state.user = { email: 'owner@example.test' }
    expect((await proxy(new NextRequest('http://localhost/api/ads'))).status).toBe(403)
    state.user = { email: 'owner@example.test', email_confirmed_at: CONFIRMED }
    expect((await proxy(new NextRequest('http://localhost/api/ads'))).headers.get('x-middleware-next')).toBe('1')
  })

  it('pages: unconfirmed owner email is sent to /login?error=unauthorized and is not bounced to the dashboard', async () => {
    const { proxy } = await import('@/proxy')
    state.user = { email: 'owner@example.test' }
    const page = await proxy(new NextRequest('http://localhost/dashboard'))
    expect(page.headers.get('location')).toBe('http://localhost/login?error=unauthorized')
    const login = await proxy(new NextRequest('http://localhost/login?error=unauthorized'))
    expect(login.headers.get('x-middleware-next')).toBe('1')
  })
})

describe('requireOwner (server pages) applies the confirmation requirement', () => {
  it('redirects an unconfirmed owner email and admits the confirmed owner', async () => {
    state.user = { email: 'owner@example.test' }
    const unconfirmed = await import('@/lib/auth/page-owner')
    await expect(unconfirmed.requireOwner()).rejects.toThrow('redirect:/login?error=unauthorized')

    vi.resetModules()
    state.user = { email: 'owner@example.test', email_confirmed_at: CONFIRMED }
    const confirmed = await import('@/lib/auth/page-owner')
    await expect(confirmed.requireOwner()).resolves.toEqual({ email: 'owner@example.test' })
  })
})
