import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  user: { id: 'owner', email: 'owner@example.test' } as { id: string; email: string } | null,
  result: { status: 'available', blockers: [] } as Record<string, unknown>,
  error: null as Error | null,
  ownerForbidden: null as Response | null,
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: async () => ({ data: { user: state.user } }) },
  })),
}))

vi.mock('@/lib/launch/adr056-launch-reader', () => ({
  readAdr056LaunchComparison: vi.fn(async () => {
    if (state.error) throw state.error
    return state.result
  }),
  Adr056LaunchReadError: class Adr056LaunchReadError extends Error {
    code: string
    constructor(code: string) {
      super(code)
      this.code = code
    }
  },
}))

vi.mock('@/lib/auth/require-owner', () => ({
  ownerOnly: vi.fn(() => state.ownerForbidden),
}))

describe('ADR-056 launch comparison API', () => {
  beforeEach(() => {
    state.user = { id: 'owner', email: 'owner@example.test' }
    state.result = { status: 'available', blockers: [] }
    state.error = null
    state.ownerForbidden = null
  })

  it('requires an authenticated owner session', async () => {
    state.user = null
    const { GET } = await import('@/app/api/performance/launch-comparison/route')

    const response = await GET()

    expect(response.status).toBe(401)
  })

  it('requires owner authorization after authentication', async () => {
    state.ownerForbidden = Response.json({ error: 'Forbidden — owner only.' }, { status: 403 })
    const { GET } = await import('@/app/api/performance/launch-comparison/route')

    const response = await GET()

    expect(response.status).toBe(403)
  })

  it('returns the governed cohort payload without caching it', async () => {
    const { GET } = await import('@/app/api/performance/launch-comparison/route')

    const response = await GET()

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toContain('no-store')
    expect(await response.json()).toEqual(state.result)
  })

  it('fails closed with a sanitized source-read error', async () => {
    const { Adr056LaunchReadError } = await import('@/lib/launch/adr056-launch-reader')
    state.error = new Adr056LaunchReadError('ADR056_INSIGHTS_READ_UNAVAILABLE')
    const { GET } = await import('@/app/api/performance/launch-comparison/route')

    const response = await GET()
    const body = await response.json()

    expect(response.status).toBe(503)
    expect(body).toEqual({
      code: 'ADR056_INSIGHTS_READ_UNAVAILABLE',
      error: 'The ADR-056 launch comparison is unavailable because its source read failed.',
    })
  })
})
