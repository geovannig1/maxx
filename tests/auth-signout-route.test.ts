import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest, type NextResponse } from 'next/server'

// Session cookies are HttpOnly, so the browser cannot read the session to revoke it or delete the
// cookies. Sign-out is therefore a server route: POST /auth/signout.
type Cookie = { name: string; value: string; options?: Record<string, unknown> }
const state = vi.hoisted(() => ({
  signOut: vi.fn(),
  getUser: vi.fn(),
  cookies: null as null | { getAll: () => { name: string; value: string }[]; setAll: (c: Cookie[]) => void },
}))
vi.mock('@supabase/ssr', () => ({
  createServerClient: (_u: string, _k: string, options: { cookies: NonNullable<typeof state.cookies> }) => {
    state.cookies = options.cookies
    return { auth: { signOut: state.signOut, getUser: state.getUser } }
  },
}))

const APP = 'https://app.example.test'
const SESSION_COOKIES = 'sb-project-auth-token=base64-abc; sb-project-auth-token.1=def; sb-project-auth-token-code-verifier=v; theme=dark'

function post(headers: Record<string, string> = {}) {
  return new NextRequest(`${APP}/auth/signout`, { method: 'POST', headers })
}
const sameOrigin = { 'sec-fetch-site': 'same-origin', origin: APP, cookie: SESSION_COOKIES }

function cleared(res: Response) {
  return (res as NextResponse).cookies.getAll().filter((c) => c.maxAge === 0).map((c) => c.name).sort()
}

beforeEach(() => {
  vi.resetModules()
  state.cookies = null
  state.getUser.mockReset().mockResolvedValue({ data: { user: null }, error: null })
  // Like auth-js _removeSession: delete the session through the server client's setAll.
  state.signOut.mockReset().mockImplementation(async () => {
    state.cookies!.setAll([{ name: 'sb-project-auth-token', value: '', options: { path: '/', maxAge: 0 } }])
    return { error: null }
  })
  vi.stubEnv('NODE_ENV', 'production')
  vi.stubEnv('VERCEL_ENV', 'production')
  vi.stubEnv('OWNER_EMAIL', 'owner@example.test')
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://project.supabase.co')
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'anon-key-fixture')
})
afterEach(() => vi.unstubAllEnvs())

describe('POST /auth/signout', () => {
  it('revokes the session server-side, clears every Supabase auth cookie and redirects to /login', async () => {
    const { POST } = await import('@/app/auth/signout/route')
    const res = await POST(post(sameOrigin))
    expect(state.signOut).toHaveBeenCalledTimes(1)
    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toBe(`${APP}/login`)
    expect(cleared(res)).toEqual([
      'sb-project-auth-token', 'sb-project-auth-token-code-verifier', 'sb-project-auth-token.1',
    ])
    expect((res as NextResponse).cookies.get('theme')).toBeUndefined()
    expect(res.headers.get('cache-control')).toContain('no-store')
  })

  it('still clears the cookies when revocation fails (expired or unreachable session)', async () => {
    state.signOut.mockResolvedValue({ error: { code: 'refresh_token_not_found', status: 400 } })
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { POST } = await import('@/app/auth/signout/route')
    const res = await POST(post(sameOrigin))
    expect(res.status).toBe(303)
    expect(cleared(res)).toContain('sb-project-auth-token')
    expect(errorSpy).toHaveBeenCalledWith('supabase_sign_out_failed', { code: 'refresh_token_not_found', status: 400 })

    state.signOut.mockRejectedValue(new Error('network down'))
    const thrown = await POST(post(sameOrigin))
    expect(thrown.status).toBe(303)
    expect(cleared(thrown)).toContain('sb-project-auth-token.1')
    errorSpy.mockRestore()
  })

  it('signs out cleanly with no session at all', async () => {
    state.signOut.mockResolvedValue({ error: null })
    const { POST } = await import('@/app/auth/signout/route')
    const res = await POST(post({ 'sec-fetch-site': 'same-origin', origin: APP }))
    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toBe(`${APP}/login`)
    expect(cleared(res)).toEqual([])
  })

  it('refuses a cross-origin POST with 403 and touches nothing', async () => {
    const { POST } = await import('@/app/auth/signout/route')
    const attempts: Record<string, string>[] = [
      { 'sec-fetch-site': 'cross-site', cookie: SESSION_COOKIES },
      { origin: 'https://evil.example.test', cookie: SESSION_COOKIES },
      { cookie: SESSION_COOKIES }, // header-less in production
    ]
    for (const headers of attempts) {
      const res = await POST(post(headers))
      expect(res.status).toBe(403)
      expect(res.headers.get('set-cookie')).toBeNull()
    }
    expect(state.signOut).not.toHaveBeenCalled()
  })

  it('is POST-only: no GET handler, so a link, prefetch or <img> cannot sign the owner out', async () => {
    const route = await import('@/app/auth/signout/route')
    expect(Object.keys(route)).toEqual(['POST'])
  })
})

describe('proxy and /auth/signout', () => {
  it('passes the sign-out POST straight to the route for a signed-out, non-owner or expired user', async () => {
    const { proxy } = await import('@/proxy')
    for (const user of [null, { email: 'other@example.test', email_confirmed_at: '2026-01-01T00:00:00Z' }]) {
      state.getUser.mockResolvedValue({ data: { user }, error: null })
      const res = await proxy(post({ 'sec-fetch-site': 'same-origin', origin: APP }))
      expect(res.headers.get('x-middleware-next')).toBe('1')
    }
    state.getUser.mockResolvedValue({ data: { user: null }, error: { status: 400, message: 'expired' } })
    expect((await proxy(post(sameOrigin))).headers.get('x-middleware-next')).toBe('1')
    expect(state.getUser).not.toHaveBeenCalled()
  })

  it('does not exempt neighbouring paths', async () => {
    const { proxy } = await import('@/proxy')
    const res = await proxy(new NextRequest(`${APP}/auth/signout-other`))
    expect(res.headers.get('location')).toBe(`${APP}/login?next=%2Fauth%2Fsignout-other`)
  })
})

describe('Sidebar sign-out control', () => {
  const source = readFileSync(join(process.cwd(), 'src/components/layout/Sidebar.tsx'), 'utf8')
  it('posts a same-origin form to /auth/signout instead of signing out in the browser', () => {
    expect(source).toMatch(/<form[^>]*action="\/auth\/signout"[^>]*method="post"/)
    expect(source).not.toContain('auth.signOut')
    expect(source).not.toContain("@/lib/supabase/client")
  })
})
