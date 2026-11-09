import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const state = vi.hoisted(() => ({
  user: { id: 'owner', email: 'owner@example.test' } as { id: string; email: string } | null,
  ownerForbidden: null as Response | null,
  active: {
    ok: true,
    account: { id: '00000000-0000-4000-8000-000000000321' },
  } as unknown,
  filters: [] as Array<{ column: string; value: unknown }>,
  rows: [
    { hour_of_day: 9, day_of_week: 1, spend: 10, bookings: 2, cpa: 5 },
  ] as Array<Record<string, unknown>>,
  queryError: null as { message: string } | null,
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: async () => ({ data: { user: state.user } }) },
  })),
}))

vi.mock('@/lib/supabase/admin', () => ({ getAdminClient: vi.fn(() => ({
  from: vi.fn(() => {
    const builder = {
      select: vi.fn(() => builder),
      eq: vi.fn((column: string, value: unknown) => {
        state.filters.push({ column, value })
        return builder
      }),
      then: (resolve: (value: { data: typeof state.rows; error: typeof state.queryError }) => unknown) =>
        Promise.resolve({ data: state.rows, error: state.queryError }).then(resolve),
    }
    return builder
  }),
})) }))

vi.mock('@/lib/auth/require-owner', () => ({ ownerOnly: vi.fn(() => state.ownerForbidden) }))
vi.mock('@/lib/accounts/active-account', () => ({
  resolveOnlyActiveAccount: vi.fn(async () => state.active),
  activeAccountErrorCode: vi.fn(() => 'NO_ACTIVE_ACCOUNT'),
  activeAccountErrorStatus: vi.fn(() => 503),
}))

describe('daypart selected-window route', () => {
  beforeEach(() => {
    state.user = { id: 'owner', email: 'owner@example.test' }
    state.ownerForbidden = null
    state.active = { ok: true, account: { id: '00000000-0000-4000-8000-000000000321' } }
    state.filters = []
    state.rows = [{ hour_of_day: 9, day_of_week: 1, spend: 10, bookings: 2, cpa: 5 }]
    state.queryError = null
  })

  it('requires owner authorization', async () => {
    state.ownerForbidden = Response.json({ error: 'Forbidden — owner only.' }, { status: 403 })
    const { GET } = await import('@/app/api/daypart/route')

    const response = await GET(new NextRequest('https://example.test/api/daypart?from=2026-08-01&to=2026-08-20'))

    expect(response.status).toBe(403)
  })

  it('uses the active ad account and exact selected closed-day window', async () => {
    const { GET } = await import('@/app/api/daypart/route')

    const response = await GET(new NextRequest('https://example.test/api/daypart?from=2026-08-01&to=2026-08-20'))
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.window).toEqual({ from: '2026-08-01', to: '2026-08-20', timezone: 'America/New_York' })
    expect(state.filters).toEqual([
      { column: 'ad_account_id', value: '00000000-0000-4000-8000-000000000321' },
      { column: 'date_range_start', value: '2026-08-01' },
      { column: 'date_range_end', value: '2026-08-20' },
    ])
  })
})
