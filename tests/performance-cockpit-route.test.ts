import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const state = vi.hoisted(() => ({
  user: { id: 'owner', email: 'owner@example.com' } as { id: string; email: string } | null,
  forbidden: null as Response | null,
  load: vi.fn(),
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: async () => ({ data: { user: state.user } }) },
  })),
}))

vi.mock('@/lib/auth/require-owner', () => ({
  ownerOnly: vi.fn(() => state.forbidden),
}))

vi.mock('@/lib/cockpit/builder', () => ({
  loadPerformanceCockpitData: state.load,
}))

describe('GET /api/cockpit', () => {
  beforeEach(() => {
    state.user = { id: 'owner', email: 'owner@example.com' }
    state.forbidden = null
    state.load.mockReset()
    state.load.mockResolvedValue({ contractVersion: 4, controls: { range: {} } })
  })

  it('requires an authenticated owner', async () => {
    state.user = null
    const { GET } = await import('@/app/api/cockpit/route')
    const response = await GET(new NextRequest('http://localhost/api/cockpit?range=mtd'))
    expect(response.status).toBe(401)
    expect(state.load).not.toHaveBeenCalled()

    state.user = { id: 'member', email: 'member@example.com' }
    state.forbidden = Response.json({ error: 'Forbidden' }, { status: 403 })
    const forbidden = await GET(new NextRequest('http://localhost/api/cockpit?range=mtd'))
    expect(forbidden.status).toBe(403)
    expect(state.load).not.toHaveBeenCalled()
  })

  it('resolves and passes only the requested closed-day range to the account-scoped loader', async () => {
    const { GET } = await import('@/app/api/cockpit/route')
    const response = await GET(new NextRequest(
      'http://localhost/api/cockpit?from=2026-08-01&to=2026-08-20',
    ))

    expect(response.status).toBe(200)
    expect(state.load).toHaveBeenCalledTimes(1)
    expect(state.load).toHaveBeenCalledWith(expect.objectContaining({
      range: expect.objectContaining({ from: '2026-08-01', to: '2026-08-20' }),
    }))
  })

  it('rejects partial or malformed custom windows instead of silently changing dates', async () => {
    const { GET } = await import('@/app/api/cockpit/route')
    const partial = await GET(new NextRequest('http://localhost/api/cockpit?from=2026-08-01'))
    const reversed = await GET(new NextRequest(
      'http://localhost/api/cockpit?from=2026-08-20&to=2026-08-01',
    ))
    const impossible = await GET(new NextRequest(
      'http://localhost/api/cockpit?from=2026-02-30&to=2026-03-01',
    ))

    expect(partial.status).toBe(400)
    expect(reversed.status).toBe(400)
    expect(impossible.status).toBe(400)
    expect(state.load).not.toHaveBeenCalled()
  })
})
