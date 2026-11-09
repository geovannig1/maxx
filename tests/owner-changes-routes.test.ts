import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

// ADR-059 routes: POST /api/changes (owner proposes), PATCH /api/changes/[id] (approve / reject /
// execute / approve_and_apply) and POST /api/changes/[id]/rollback. Owner-only, same-origin,
// double-click safe; approve applies only with write mode on.

const state = vi.hoisted(() => ({
  user: { id: 'owner-1', email: 'owner@example.com' } as { id: string; email: string } | null,
  owner: true,
  changeRow: { id: 'change-1', status: 'pending' } as Record<string, unknown> | null,
  rpcError: null as { message: string } | null,
  rpc: [] as Array<{ name: string; args: Record<string, unknown> }>,
  propose: vi.fn(async () => ({ status: 'PENDING_APPROVAL', http: 201, change_request_id: 'change-9', preview: 'Pause ad "Reel".', message: 'ok' })),
  rollback: vi.fn(async () => ({ status: 'PENDING_APPROVAL', http: 201, change_request_id: 'change-r', message: 'ok' })),
  execute: vi.fn(async () => ({ status: 'EXECUTED_VERIFIED', verified: true })),
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: state.user } }) } }),
}))
vi.mock('@/lib/auth/owner', () => ({ ownerGate: () => ({ allowed: state.owner, reason: state.owner ? 'ok' : 'not_owner' }) }))
vi.mock('@/lib/accounts/active-account', () => ({
  resolveOnlyActiveAccount: async () => ({ ok: true, account: { id: 'account-a' } }),
  activeAccountErrorCode: () => 'ACTIVE_ACCOUNT_UNAVAILABLE',
}))
vi.mock('@/lib/supabase/admin', () => ({
  getAdminClient: () => {
    const builder: Record<string, unknown> = {}
    for (const method of ['from', 'select', 'eq']) builder[method] = () => builder
    builder.maybeSingle = async () => ({ data: state.changeRow, error: null })
    builder.rpc = async (name: string, args: Record<string, unknown>) => {
      state.rpc.push({ name, args })
      return { data: null, error: state.rpcError }
    }
    return builder
  },
}))
vi.mock('@/lib/writes/owner-changes', () => ({ proposeOwnerChange: state.propose, proposeRollback: state.rollback }))
vi.mock('@/lib/writes/executor', () => ({
  executeApprovedChange: state.execute,
  httpStatusForExecuteResult: (status: string) => (status.startsWith('EXECUTED') || status === 'ALREADY_EXECUTED' ? 200 : 409),
}))
vi.mock('@/lib/writes/demo-executor', () => ({ simulateApprovedChange: vi.fn(async () => ({ status: 'DEMO_SIMULATED' })) }))

const DECISION = '00000000-0000-4000-8000-0000000000d1'
const send = (method: string, url: string, body: unknown, origin = 'http://localhost') => new NextRequest(url, {
  method, headers: { 'content-type': 'application/json', origin }, body: JSON.stringify(body),
})
const ctx = (id: string) => ({ params: Promise.resolve({ id }) })
const patch = async (body: unknown, origin?: string) =>
  (await import('@/app/api/changes/[id]/route')).PATCH(send('PATCH', 'http://localhost/api/changes/change-1', body, origin), ctx('change-1'))
const propose = async (body: unknown, origin?: string) =>
  (await import('@/app/api/changes/route')).POST(send('POST', 'http://localhost/api/changes', body, origin))
const rollback = async (origin?: string) =>
  (await import('@/app/api/changes/[id]/rollback/route')).POST(send('POST', 'http://localhost/api/changes/change-1/rollback', {}, origin), ctx('change-1'))

beforeEach(() => {
  state.user = { id: 'owner-1', email: 'owner@example.com' }
  state.owner = true
  state.changeRow = { id: 'change-1', status: 'pending' }
  state.rpcError = null
  state.rpc = []
  state.propose.mockClear(); state.rollback.mockClear(); state.execute.mockClear()
  vi.stubEnv('WRITE_MODE_ENABLED', 'false')
  vi.stubEnv('MAXX_DEMO', '')
})
afterEach(() => vi.unstubAllEnvs())

describe('owner gate and same-origin on every mutating change route', () => {
  it.each([
    ['propose', () => propose({ action_decision_id: DECISION })],
    ['review', () => patch({ action: 'approve_and_apply' })],
    ['rollback', () => rollback()],
  ])('%s: 401 signed out, 403 non-owner, 403 cross-origin — and nothing runs', async (_name, call) => {
    state.user = null
    expect((await call()).status).toBe(401)
    state.user = { id: 'intruder', email: 'x@example.com' }
    state.owner = false
    expect((await call()).status).toBe(403)
    expect(state.propose).not.toHaveBeenCalled()
    expect(state.rollback).not.toHaveBeenCalled()
    expect(state.rpc).toEqual([])
    expect(state.execute).not.toHaveBeenCalled()
  })

  it('refuses a cross-origin request before any work', async () => {
    expect((await propose({ action_decision_id: DECISION }, 'https://evil.example')).status).toBe(403)
    expect((await patch({ action: 'approve_and_apply' }, 'https://evil.example')).status).toBe(403)
    expect((await rollback('https://evil.example')).status).toBe(403)
    expect(state.propose).not.toHaveBeenCalled()
    expect(state.rollback).not.toHaveBeenCalled()
    expect(state.rpc).toEqual([])
  })
})

describe('POST /api/changes', () => {
  it('proposes as the signed-in owner and returns the pending request', async () => {
    const response = await propose({ action_decision_id: DECISION, params: { new_daily_budget: 40 }, confirm_override: true })
    expect(response.status).toBe(201)
    expect(await response.json()).toMatchObject({ status: 'PENDING_APPROVAL', change_request_id: 'change-9' })
    expect(state.propose).toHaveBeenCalledWith({
      decisionId: DECISION, ownerUserId: 'owner-1', actor: 'owner@example.com', params: { new_daily_budget: 40 }, confirmOverride: true,
    })
  })

  it.each([
    ['no decision id', {}],
    ['a non-uuid decision id', { action_decision_id: 'abc' }],
    ['array params', { action_decision_id: DECISION, params: [1] }],
  ])('rejects %s with 400', async (_label, body) => {
    expect((await propose(body)).status).toBe(400)
    expect(state.propose).not.toHaveBeenCalled()
  })

  it('carries a service refusal status through (step limit, currency, ceiling)', async () => {
    state.propose.mockResolvedValueOnce({ status: 'STEP_LIMIT_EXCEEDED', http: 409, change_request_id: undefined as unknown as string, preview: '', message: 'over' })
    const response = await propose({ action_decision_id: DECISION, params: { new_daily_budget: 99 } })
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ status: 'STEP_LIMIT_EXCEEDED' })
  })
})

describe('PATCH /api/changes/[id]', () => {
  it('gives an apply the platform maximum so a slow Meta run is not killed mid-write (security review M1)', async () => {
    expect((await import('@/app/api/changes/[id]/route')).maxDuration).toBe(300)
  })

  it('approve_and_apply with write mode OFF records the approval and applies nothing', async () => {
    const response = await patch({ action: 'approve_and_apply' })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ status: 'approved', write_mode: 'off', message: expect.stringMatching(/writes are off; turn on WRITE_MODE_ENABLED/) })
    expect(state.rpc).toEqual([expect.objectContaining({ name: 'review_change_request_with_decision', args: expect.objectContaining({ p_approve: true }) })])
    expect(state.execute).not.toHaveBeenCalled()
  })

  it('approve_and_apply with write mode ON approves then executes through the executor', async () => {
    vi.stubEnv('WRITE_MODE_ENABLED', 'true')
    const response = await patch({ action: 'approve_and_apply' })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ status: 'EXECUTED_VERIFIED' })
    expect(state.execute).toHaveBeenCalledWith('change-1', 'owner@example.com', 'account-a')
  })

  it('is double-click safe: an approved row is not re-approved, an executed row is not re-applied', async () => {
    vi.stubEnv('WRITE_MODE_ENABLED', 'true')
    state.changeRow = { id: 'change-1', status: 'approved' }
    await patch({ action: 'approve_and_apply' })
    expect(state.rpc).toEqual([])
    expect(state.execute).toHaveBeenCalledTimes(1)
    state.changeRow = { id: 'change-1', status: 'executed' }
    const again = await patch({ action: 'approve_and_apply' })
    expect(await again.json()).toMatchObject({ status: 'ALREADY_EXECUTED' })
    expect(state.execute).toHaveBeenCalledTimes(1)
  })

  it('refuses to approve an expired request with a clear 409', async () => {
    state.rpcError = { message: 'change_request_expired' }
    const response = await patch({ action: 'approve_and_apply' })
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ status: 'EXPIRED' })
    expect(state.execute).not.toHaveBeenCalled()
  })

  it('rejects once and treats a second reject as a no-op', async () => {
    expect((await patch({ action: 'reject' })).status).toBe(200)
    expect(state.rpc).toHaveLength(1)
    state.changeRow = { id: 'change-1', status: 'rejected' }
    expect((await patch({ action: 'reject' })).status).toBe(200)
    expect(state.rpc).toHaveLength(1)
  })

  it('returns 404 for a request outside the active account and 400 for an unknown action', async () => {
    state.changeRow = null
    expect((await patch({ action: 'approve_and_apply' })).status).toBe(404)
    expect((await patch({ action: 'delete' })).status).toBe(400)
    expect(state.rpc).toEqual([])
  })
})

describe('POST /api/changes/[id]/rollback', () => {
  it('proposes the inverse as the owner', async () => {
    const response = await rollback()
    expect(response.status).toBe(201)
    expect(state.rollback).toHaveBeenCalledWith({ changeRequestId: 'change-1', ownerUserId: 'owner-1', actor: 'owner@example.com' })
  })
})
