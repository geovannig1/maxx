import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  user: { id: 'owner', email: 'owner@example.com' } as { id: string; email: string } | null,
  forbidden: null as Response | null,
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: async () => ({ data: { user: state.user } }) },
  })),
}))

vi.mock('@/lib/auth/require-owner', () => ({
  ownerOnly: vi.fn(() => state.forbidden),
}))

describe('GET /api/release-provenance', () => {
  beforeEach(() => {
    state.user = { id: 'owner', email: 'owner@example.com' }
    state.forbidden = null
    vi.unstubAllEnvs()
  })

  it('requires an authenticated owner', async () => {
    state.user = null
    const { GET } = await import('@/app/api/release-provenance/route')
    expect((await GET()).status).toBe(401)

    state.user = { id: 'member', email: 'member@example.com' }
    state.forbidden = Response.json({ error: 'Forbidden' }, { status: 403 })
    expect((await GET()).status).toBe(403)
  })

  it('fails closed when the deployment has no commit identity', async () => {
    vi.stubEnv('VERCEL_GIT_COMMIT_SHA', '')
    const { GET } = await import('@/app/api/release-provenance/route')
    const response = await GET()

    expect(response.status).toBe(503)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    await expect(response.json()).resolves.toEqual({ error: 'Deployment commit identity is unavailable.' })
  })

  it('returns only deployment identity with private no-store caching', async () => {
    vi.stubEnv('VERCEL_GIT_COMMIT_SHA', 'a'.repeat(40))
    vi.stubEnv('VERCEL_DEPLOYMENT_ID', 'dpl_release_candidate')
    const { GET } = await import('@/app/api/release-provenance/route')
    const response = await GET()

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    await expect(response.json()).resolves.toEqual({
      commit_sha: 'a'.repeat(40),
      build_id: 'dpl_release_candidate',
    })
  })
})
