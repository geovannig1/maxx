import { NextRequest } from 'next/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Security review fix 4: saved-route called ownerGate(user.email), the deprecated email-only form, so
// an unconfirmed account that registered OWNER_EMAIL passed. The real gate runs here (not mocked).
const mocks = vi.hoisted(() => ({ auth: vi.fn(), account: vi.fn(), list: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: mocks.auth } }) }))
vi.mock('@/lib/accounts/active-account', () => ({
  resolveOnlyActiveAccount: mocks.account,
  activeAccountErrorCode: (reason: string) => `ACTIVE_ACCOUNT_${reason.toUpperCase()}`,
}))
vi.mock('@/lib/supabase/admin', () => ({ getAdminClient: () => ({ rpc: 'db' }) }))
vi.mock('@/lib/reporting/saved-service', () => ({
  saveReportingReport: vi.fn(), listSavedReportingReports: mocks.list, openSavedReportingReport: vi.fn(),
}))

const request = () => new NextRequest('http://localhost/api/reporting/saved', { signal: undefined })
const owner = (confirmed: string | null) => ({
  data: { user: { id: '00000000-0000-4000-8000-000000001403', email: 'owner@example.test', email_confirmed_at: confirmed } },
  error: null,
})

describe('saved reporting route owner gate', () => {
  const previousOwner = process.env.OWNER_EMAIL
  beforeEach(() => {
    vi.resetAllMocks()
    process.env.OWNER_EMAIL = 'owner@example.test'
    mocks.account.mockResolvedValue({ ok: true, account: { id: 'a1', accountId: 'act_1', accountName: 'Studio' } })
    mocks.list.mockResolvedValue({ reports: [], nextCursor: null })
  })
  afterEach(() => {
    if (previousOwner === undefined) delete process.env.OWNER_EMAIL
    else process.env.OWNER_EMAIL = previousOwner
  })

  it('rejects the owner email when it is not confirmed', async () => {
    mocks.auth.mockResolvedValue(owner(null))
    const { GET } = await import('@/app/api/reporting/saved/route')
    expect((await GET(request())).status).toBe(403)
    expect(mocks.account).not.toHaveBeenCalled()
  })

  it('control: the confirmed owner can list saved reports', async () => {
    mocks.auth.mockResolvedValue(owner('2026-01-01T00:00:00Z'))
    const { GET } = await import('@/app/api/reporting/saved/route')
    const response = await GET(request())
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ reports: [], nextCursor: null })
  })
})
