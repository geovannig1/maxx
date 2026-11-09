import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

// The generic outcome webhook is machine-authenticated (HMAC per source) and must cross the owner
// gate, but ONLY at its exact path: /api/outcomes/webhook/<uuid>. Anything else under /api/outcomes/
// — including path tricks around that pattern — stays owner-gated.

vi.mock('@supabase/ssr', () => ({
  createServerClient: () => ({ auth: { getUser: async () => ({ data: { user: null } }) } }),
}))

const SOURCE = '0b6f2a8e-3c4d-4e5f-8a9b-0c1d2e3f4a5b'

describe('proxy exemption for the outcome webhook', () => {
  beforeEach(() => {
    vi.resetModules()
    process.env.OWNER_EMAIL = 'owner@example.com'
    // A configured install (without these the proxy serves only /setup).
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://project.supabase.co')
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'anon-key-fixture')
  })
  afterEach(() => {
    delete process.env.OWNER_EMAIL
    vi.unstubAllEnvs()
  })

  it.each([SOURCE, SOURCE.toUpperCase()])('passes POST /api/outcomes/webhook/%s to its route-level signature check', async (id) => {
    const { proxy } = await import('@/proxy')
    const response = await proxy(new NextRequest(`http://localhost/api/outcomes/webhook/${id}`, { method: 'POST' }))
    expect(response.status).toBe(200)
    expect(response.headers.get('x-middleware-next')).toBe('1')
  })

  it.each([
    '/api/outcomes/webhook',
    '/api/outcomes/webhook/',
    '/api/outcomes/webhook/not-a-uuid',
    `/api/outcomes/webhook/${SOURCE}/`,
    `/api/outcomes/webhook/${SOURCE}/extra`,
    `/api/outcomes/webhook/${SOURCE}x`,
    `/api/outcomes/webhook/${SOURCE}%2F..%2F..%2Fsettings`,
    `/api/outcomes/webhook/${SOURCE}/../../${SOURCE}/review`,
    `/api/outcomes/webhook-sources`,
    `/api/outcomes/${SOURCE}/review`,
    `/api/outcomes/webhook/%2e%2e/${SOURCE}`,
  ])('keeps %s owner-gated', async (path) => {
    const { proxy } = await import('@/proxy')
    const response = await proxy(new NextRequest(`http://localhost${path}`, { method: 'GET' }))
    expect(response.status).toBe(401)
  })
})
