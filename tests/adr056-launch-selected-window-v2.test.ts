import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const state = vi.hoisted(() => ({
  calls: [] as Array<{ lastClosedDate?: string; selectedFrom?: string } | undefined>,
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: async () => ({ data: { user: { id: 'owner' } } }) },
  })),
}))

vi.mock('@/lib/launch/adr056-launch-reader', () => ({
  readAdr056LaunchComparison: vi.fn(async (input?: { lastClosedDate?: string; selectedFrom?: string }) => {
    state.calls.push(input)
    return { status: 'available', blockers: [] }
  }),
  Adr056LaunchReadError: class Adr056LaunchReadError extends Error {
    code: string
    constructor(code: string) { super(code); this.code = code }
  },
}))

vi.mock('@/lib/auth/require-owner', () => ({ ownerOnly: vi.fn(() => null) }))

describe('ADR-056 selected closed-day endpoint v2', () => {
  beforeEach(() => { state.calls = [] })

  it('uses the selected end as the canonical comparison as-of date and records that the selected start is not applied', async () => {
    const { GET } = await import('@/app/api/performance/launch-comparison/route')
    const response = await GET(new NextRequest('https://example.test/api/performance/launch-comparison?from=2026-08-01&to=2026-08-20'))

    expect(response.status).toBe(200)
    expect(state.calls).toEqual([{ lastClosedDate: '2026-08-20', selectedFrom: '2026-08-01' }])
  })

  it('rejects malformed, inverted, or incomplete ranges instead of ignoring their start date', async () => {
    const { GET } = await import('@/app/api/performance/launch-comparison/route')

    const malformed = await GET(new NextRequest('https://example.test/api/performance/launch-comparison?from=not-a-date&to=2026-08-20'))
    const inverted = await GET(new NextRequest('https://example.test/api/performance/launch-comparison?from=2026-08-21&to=2026-08-20'))
    const incomplete = await GET(new NextRequest('https://example.test/api/performance/launch-comparison?from=2026-08-01'))

    expect(malformed.status).toBe(400)
    expect(inverted.status).toBe(400)
    expect(incomplete.status).toBe(400)
    expect(state.calls).toEqual([])
  })

  it('rejects a future selected end rather than silently changing it', async () => {
    const { GET } = await import('@/app/api/performance/launch-comparison/route')
    const response = await GET(new NextRequest('https://example.test/api/performance/launch-comparison?from=2026-08-01&to=2099-01-01'))

    expect(response.status).toBe(400)
    expect(state.calls).toEqual([])
  })
})
