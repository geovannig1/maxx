import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({ auth: vi.fn(), owner: vi.fn(), account: vi.fn(), save: vi.fn(), list: vi.fn(), open: vi.fn(), admin: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: mocks.auth } }) }))
vi.mock('@/lib/auth/owner', () => ({ ownerGate: mocks.owner }))
vi.mock('@/lib/accounts/active-account', () => ({
  resolveOnlyActiveAccount: mocks.account,
  activeAccountErrorCode: (reason: string) => `ACTIVE_ACCOUNT_${reason.toUpperCase()}`,
}))
vi.mock('@/lib/supabase/admin', () => ({ getAdminClient: mocks.admin }))
vi.mock('@/lib/reporting/saved-service', () => ({ saveReportingReport: mocks.save, listSavedReportingReports: mocks.list, openSavedReportingReport: mocks.open }))
import { GET, POST } from '@/app/api/reporting/saved/route'
import { GET as OPEN } from '@/app/api/reporting/saved/[id]/route'
import { snapshotContext, snapshotPacket } from './fixtures/reporting-snapshot'
import { createReportingSnapshot, makeReportingSnapshotScope, reportingFingerprint } from '@/lib/reporting/snapshot-contract'
import { savedInput } from './fixtures/reporting-saved'
import { SavedReportError } from '@/lib/reporting/saved-contract'
const account = { id: '00000000-0000-4000-8000-000000001311', accountId: 'act_123', accountName: 'Studio' }
const request = (init: RequestInit = {}, query = '') => new NextRequest(`http://localhost/api/reporting/saved${query}`, { ...init, signal: undefined })
describe('saved report authenticated API', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mocks.auth.mockResolvedValue({ data: { user: { id: '00000000-0000-4000-8000-000000001403', email: 'owner@example.test' } } })
    mocks.owner.mockReturnValue({ allowed: true })
    mocks.account.mockResolvedValue({ ok: true, account })
    mocks.admin.mockReturnValue({ rpc: 'db' })
    mocks.list.mockResolvedValue({ reports: [], nextCursor: null })
  })
  it('distinguishes an empty account list from unavailable storage', async () => {
    expect(await (await GET(request())).json()).toEqual({ reports: [], nextCursor: null })
    mocks.list.mockRejectedValue(new Error('private database credentials'))
    const failed = await GET(request())
    expect(failed.status).toBe(503)
    expect(await failed.text()).not.toContain('credentials')
  })
  it.each([['missing session', null, true, 401], ['non-owner', { id: 'user' }, false, 403]] as const)(
    'rejects %s before account or storage reads', async (_, user, allowed, status) => {
      mocks.auth.mockResolvedValue({ data: { user } }); mocks.owner.mockReturnValue({ allowed })
      expect((await GET(request())).status).toBe(status)
      expect(mocks.account).not.toHaveBeenCalled(); expect(mocks.admin).not.toHaveBeenCalled()
    })
  it.each([undefined, 'https://elsewhere.test'])('rejects cross-origin writes (%s)', async origin => {
    const response = await POST(request({ method: 'POST', body: '{}', headers: { ...(origin ? { Origin: origin } : {}), 'Content-Type': 'application/json' } }))
    expect(response.status).toBe(403); expect(mocks.save).not.toHaveBeenCalled(); expect(mocks.account).not.toHaveBeenCalled()
  })
  it.each([['{', 400], ['x'.repeat(65_537), 413]])('rejects malformed or oversized JSON', async (body, status) => {
    const response = await POST(request({ method: 'POST', body, headers: { Origin: 'http://localhost', 'Content-Type': 'application/json' } }))
    expect(response.status).toBe(status); expect(mocks.save).not.toHaveBeenCalled(); expect(mocks.account).not.toHaveBeenCalled()
  })
  it('binds list to the resolved account and rejects foreign query selectors', async () => {
    expect((await GET(request({}, '?account=foreign'))).status).toBe(400)
    expect((await GET(request())).headers.get('cache-control')).toBe('private, no-store')
    expect(mocks.list).toHaveBeenCalledWith({ rpc: 'db' }, account.id, null)
  })
  it('opens only the requested ID with the server-resolved account', async () => {
    const id = '00000000-0000-4000-8000-000000001411'
    mocks.open.mockResolvedValue({ saved: { id } })
    expect((await OPEN(request(), { params: Promise.resolve({ id }) })).status).toBe(200)
    expect(mocks.open).toHaveBeenCalledWith({ rpc: 'db' }, { id: account.id, metaAccountId: account.accountId, name: account.accountName }, id)
  })
  it('saves bounded references using the authenticated user and resolved account', async () => {
    const snapshot = createReportingSnapshot(makeReportingSnapshotScope('meta', snapshotContext), snapshotPacket(), '2026-09-05T17:00:40.000Z')
    const body = savedInput({ id: '00000000-0000-4000-8000-000000001401', fingerprint: reportingFingerprint(snapshot),
      createdAt: snapshot.retrieval.completedAt, snapshot })
    mocks.save.mockResolvedValue({ saved: { id: body.requestId } })
    const response = await POST(request({ method: 'POST', body: JSON.stringify(body),
      headers: { Origin: 'http://localhost', 'Content-Type': 'application/json' } }))
    expect(response.status).toBe(201)
    expect(mocks.save).toHaveBeenCalledWith({ rpc: 'db' }, snapshotContext.account, '00000000-0000-4000-8000-000000001403', body)
  })
  it('fails closed when account ownership cannot be resolved', async () => {
    mocks.account.mockResolvedValue({ ok: false, reason: 'ambiguous' })
    const response = await GET(request())
    expect(response.status).toBe(409)
    expect(response.headers.get('x-reporting-error-code')).toBe('ACTIVE_ACCOUNT_AMBIGUOUS')
    expect(await response.json()).toMatchObject({ code: 'ACTIVE_ACCOUNT_AMBIGUOUS' })
    expect(mocks.admin).not.toHaveBeenCalled()
  })
  it.each([['incompatible', 422], ['changed', 409]] as const)('distinguishes %s from a changed visible report', async (code, status) => {
    mocks.open.mockRejectedValue(new SavedReportError(code))
    const response = await OPEN(request(), { params: Promise.resolve({ id: '00000000-0000-4000-8000-000000001411' }) })
    expect(response.status).toBe(status)
    expect(await response.json()).toMatchObject({ code })
  })
})
