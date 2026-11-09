import { beforeEach, describe, expect, it, vi } from 'vitest'

// ADR-062 routes: same-origin before anything, then sign-in, the owner gate, a per-owner rate limit and
// a size-capped body; each passes the signed-in owner's id to the service and mirrors its status.
// No route approves or applies a plan: that stays on PATCH /api/changes/[id].

const state = vi.hoisted(() => ({
  user: { id: 'owner-user-id', email: 'owner@example.test' } as { id: string; email: string } | null,
  owner: true,
  counts: new Map<string, number>(),
  calls: [] as Array<{ fn: string; input: unknown }>,
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: state.user } }) } }),
}))
vi.mock('@/lib/auth/require-owner', () => ({
  ownerOnly: () => (state.owner ? null : Response.json({ error: 'Forbidden' }, { status: 403 })),
}))
vi.mock('@/lib/security/api-rate-limit', () => ({
  enforceApiRateLimit: vi.fn(async (o: { bucket: string; actorKey: string; limit: number }) => {
    const key = `${o.bucket}|${o.actorKey}`
    const used = (state.counts.get(key) ?? 0) + 1
    state.counts.set(key, used)
    return used > o.limit ? Response.json({ code: 'RATE_LIMITED' }, { status: 429 }) : null
  }),
}))
vi.mock('@/lib/campaigns/plan-repository', () => ({
  draftCampaignPlan: vi.fn(async (input: unknown, options: unknown) => { state.calls.push({ fn: 'draft', input: { input, options } }); return { http: 201, body: { status: 'DRAFT_SAVED', plan_id: 'p1' } } }),
  editPlanVersion: vi.fn(async (input: unknown) => { state.calls.push({ fn: 'edit', input }); return { http: 201, body: { status: 'DRAFT_SAVED' } } }),
  listPlans: vi.fn(async () => ({ ok: true, rows: [{ id: 'p1', status: 'draft' }] })),
  getPlan: vi.fn(async (id: string) => (id === '00000000-0000-4000-8000-000000000001' ? { ok: true, detail: { plan: { id } } } : { ok: false, http: 404, code: 'PLAN_NOT_FOUND' })),
}))
vi.mock('@/lib/campaigns/plan-submission', () => ({
  submitPlanForApproval: vi.fn(async (input: unknown) => { state.calls.push({ fn: 'submit', input }); return { http: 201, body: { status: 'PENDING_APPROVAL', change_request_id: 'cr1' } } }),
}))

const PLAN = '00000000-0000-4000-8000-000000000001'
const VERSION = '00000000-0000-4000-8000-000000000002'
const BRIEF = { goal: 'sales', product: 'Studio rental', daily_budget: 30, countries: ['US'], start_date: '2026-11-10' }

const routes = {
  draft: async () => (await import('@/app/api/campaigns/plans/route')).POST,
  edit: async () => (await import('@/app/api/campaigns/plans/[planId]/versions/route')).POST,
  submit: async () => (await import('@/app/api/campaigns/plans/[planId]/submit/route')).POST,
}
type Name = keyof typeof routes
const BODIES: Record<Name, unknown> = { draft: BRIEF, edit: { spec: { currency: 'USD' } }, submit: { version_id: VERSION, confirm_budget_step: true } }
const ctx = { params: Promise.resolve({ planId: PLAN }) }

function post(body: unknown, headers: Record<string, string> = {}) {
  return new Request('http://localhost/api/campaigns/plans', {
    method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body), headers: { 'content-type': 'application/json', ...headers },
  }) as never
}

beforeEach(() => {
  state.user = { id: 'owner-user-id', email: 'owner@example.test' }
  state.owner = true
  state.counts.clear()
  state.calls = []
})

describe.each(Object.keys(routes) as Name[])('POST %s', (name) => {
  it('refuses a cross-site request before reading the session', async () => {
    const res = await (await routes[name]())(post(BODIES[name], { 'sec-fetch-site': 'cross-site' }), ctx)
    expect(res.status).toBe(403)
    expect(state.calls).toEqual([])
  })

  it('needs a signed-in owner', async () => {
    state.user = null
    expect((await (await routes[name]())(post(BODIES[name]), ctx)).status).toBe(401)
    state.user = { id: 'x', email: 'x@example.test' }
    state.owner = false
    expect((await (await routes[name]())(post(BODIES[name]), ctx)).status).toBe(403)
    expect(state.calls).toEqual([])
  })

  it('refuses an oversized or malformed body', async () => {
    expect((await (await routes[name]())(post('{"x":"' + 'a'.repeat(70_000) + '"}'), ctx)).status).toBe(413)
    expect((await (await routes[name]())(post('not json'), ctx)).status).toBe(400)
  })

  it('rate-limits per owner', async () => {
    let last = 0
    for (let i = 0; i < 70; i++) last = (await (await routes[name]())(post(BODIES[name]), ctx)).status
    expect(last).toBe(429)
  })
})

describe('plan routes pass the owner and mirror the service', () => {
  it('drafts with the signed-in owner id', async () => {
    const res = await (await routes.draft())(post(BRIEF))
    expect(res.status).toBe(201)
    expect(state.calls[0]).toEqual({ fn: 'draft', input: { input: expect.objectContaining({ goal: 'sales' }), options: { ownerUserId: 'owner-user-id' } } })
  })

  it('submits a version of the plan in the path, never approving it', async () => {
    const res = await (await routes.submit())(post({ version_id: VERSION, confirm_budget_step: true }), ctx)
    expect(res.status).toBe(201)
    expect(state.calls[0]).toEqual({ fn: 'submit', input: { versionId: VERSION, ownerUserId: 'owner-user-id', actor: 'owner@example.test', confirmBudgetStep: true, planId: PLAN } })
    expect((await (await routes.submit())(post({ version_id: 'nope' }), ctx)).status).toBe(400)
  })

  it('lists and reads plans for the owner only', async () => {
    const list = (await import('@/app/api/campaigns/plans/route')).GET
    expect((await list()).status).toBe(200)
    const read = (await import('@/app/api/campaigns/plans/[planId]/route')).GET
    expect((await read(new Request('http://localhost') as never, ctx)).status).toBe(200)
    expect((await read(new Request('http://localhost') as never, { params: Promise.resolve({ planId: 'not-a-uuid' }) })).status).toBe(404)
    state.owner = false
    expect((await list()).status).toBe(403)
  })
})
