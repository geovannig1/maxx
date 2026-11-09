import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeFetch, fakeState } from './helpers/fake-services'

// the checklist's "test connection" button. POST /api/setup/checks runs the same checks module as
// setup and doctor for one integration. Owner only, same-origin, rate limited, never returns a secret.

const state = vi.hoisted(() => ({
  user: { id: 'u-1', email: 'owner@example.test', email_confirmed_at: '2026-01-01T00:00:00Z' } as Record<string, unknown> | null,
  limited: null as Response | null,
  probe: vi.fn(async () => 'anthropic/claude-opus-5-5 answered (stop: end_turn).'),
}))
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: async () => ({ data: { user: state.user } }) } }) }))
vi.mock('@/lib/security/api-rate-limit', () => ({ enforceApiRateLimit: async () => state.limited }))
vi.mock('@/lib/setup/ai-probe', () => ({ liveAiProbe: state.probe }))

const SERVICE = 'service-role-planted-0123456789abcdef'

beforeEach(() => {
  vi.stubEnv('OWNER_EMAIL', 'owner@example.test')
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://abcdefghijkl.supabase.co')
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0')
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', SERVICE)
  vi.stubGlobal('fetch', fakeFetch(fakeState({ disableSignup: false })))
  state.limited = null
  state.probe.mockClear()
})
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals() })

const post = async (body: unknown, headers: Record<string, string> = {}) => {
  const { POST } = await import('@/app/api/setup/checks/route')
  return POST(new Request('http://localhost/api/setup/checks', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', ...headers } }))
}

describe('POST /api/setup/checks', () => {
  it('runs the checks for one integration and returns them without secrets', async () => {
    const res = await post({ integration: 'supabase' })
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('private, no-store')
    const body = await res.json() as { checks: Array<{ id: string; level: string; integration: string }> }
    expect(body.checks.every((c) => c.integration === 'supabase')).toBe(true)
    expect(body.checks.find((c) => c.id === 'supabase.signup_disabled')?.level).toBe('warn')
    expect(JSON.stringify(body)).not.toContain(SERVICE)
  })

  it('makes the live AI call only for { integration: "ai", live: true }', async () => {
    await post({ integration: 'supabase', live: true })
    await post({ integration: 'ai' })
    expect(state.probe).not.toHaveBeenCalled()
    await post({ integration: 'ai', live: true })
    expect(state.probe).toHaveBeenCalledTimes(1)
  })

  it('refuses no session, a non-owner, a cross-origin request, a bad body and a rate-limited owner', async () => {
    expect((await post({ integration: 'nonsense' })).status).toBe(400)
    expect((await post({ integration: 'meta', extra: 1 })).status).toBe(400)
    expect((await post({ integration: 'meta' }, { origin: 'https://evil.example' })).status).toBe(403)
    state.limited = Response.json({ code: 'RATE_LIMITED' }, { status: 429 })
    expect((await post({ integration: 'meta' })).status).toBe(429)
    state.limited = null
    state.user = { id: 'u-2', email: 'intruder@example.test', email_confirmed_at: '2026-01-01T00:00:00Z' }
    expect((await post({ integration: 'meta' })).status).toBe(403)
    state.user = null
    expect((await post({ integration: 'meta' })).status).toBe(401)
    state.user = { id: 'u-1', email: 'owner@example.test', email_confirmed_at: '2026-01-01T00:00:00Z' }
  })
})
