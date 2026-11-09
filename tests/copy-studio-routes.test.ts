import { beforeEach, describe, expect, it, vi } from 'vitest'

// The three Copy studio routes: same-origin before anything, then sign-in, then the owner gate, then a
// per-owner rate limit, then size-capped validated input. Generation answers AI-off before any limit,
// database or provider work; saving re-scores on the server and refuses blocked copy.

const state = vi.hoisted(() => ({
  user: { id: 'owner-user-id', email: 'owner@example.test' } as { id: string; email: string } | null,
  owner: true,
  ai: 'on' as 'on' | 'off' | 'misconfigured',
  counts: new Map<string, number>(),
  limits: [] as Array<{ bucket: string; limit: number }>,
  generate: vi.fn(),
  inserts: [] as unknown[],
  insertError: null as unknown,
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: state.user } }) } }),
}))
vi.mock('@/lib/auth/require-owner', () => ({
  ownerOnly: () => (state.owner ? null : Response.json({ error: 'Forbidden' }, { status: 403 })),
}))
vi.mock('@/lib/security/api-rate-limit', () => ({
  enforceApiRateLimit: vi.fn(async (o: { bucket: string; actorKey: string; limit: number }) => {
    state.limits.push({ bucket: o.bucket, limit: o.limit })
    const key = `${o.bucket}|${o.actorKey}`
    const used = (state.counts.get(key) ?? 0) + 1
    state.counts.set(key, used)
    return used > o.limit ? Response.json({ code: 'RATE_LIMITED' }, { status: 429 }) : null
  }),
}))
vi.mock('@/lib/ai', async () => ({
  ...(await vi.importActual<typeof import('@/lib/ai/errors')>('@/lib/ai/errors')),
  aiStatus: () => (state.ai === 'on' ? { state: 'on', provider: 'anthropic', family: 'anthropic', model: 'm' } : state.ai === 'off' ? { state: 'off', inferred: true } : { state: 'misconfigured', errors: [] }),
  generateStructured: vi.fn(() => { throw new Error('the route test never reaches a provider') }),
}))
vi.mock('@/lib/creative/copy-generator', async () => ({
  ...(await vi.importActual<typeof import('@/lib/creative/copy-generator')>('@/lib/creative/copy-generator')),
  generateCopy: state.generate,
}))
vi.mock('@/lib/accounts/active-account', async () => ({
  ...(await vi.importActual<typeof import('@/lib/accounts/active-account')>('@/lib/accounts/active-account')),
  resolveOnlyActiveAccount: async () => ({ ok: true, account: { id: 'account-1', accountId: 'act_1', accountName: null } }),
}))
vi.mock('@/lib/supabase/admin', () => ({
  getAdminClient: () => ({
    from: () => ({ insert: async (rows: unknown) => { state.inserts.push(rows); return { error: state.insertError } } }),
  }),
}))

const routes = {
  generate: async () => (await import('@/app/api/creative/copy/generate/route')).POST,
  score: async () => (await import('@/app/api/creative/copy/score/route')).POST,
  bank: async () => (await import('@/app/api/creative/copy/bank/route')).POST,
}
type Name = keyof typeof routes

const VARIANT = {
  hook: 'Shooting products this week?',
  primary_text: 'Shooting products this week? Bring them to a bright room and book an hour.',
  headline: 'A bright room by the hour', description: 'Book online', cta: 'BOOK_NOW', angle: 'specific_benefit',
}
const BODIES: Record<Name, unknown> = {
  generate: { goal: 'bookings', product: 'Studio rental', audience: { temperature: 'cold' }, variants: 2 },
  score: { text: 'Shooting products this week? Book a bright room by the hour.' },
  bank: { variant: VARIANT, goal: 'bookings', temperature: 'cold' },
}

function post(body: unknown, headers: Record<string, string> = {}) {
  return new Request('http://localhost/api/creative/copy/x', {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  }) as unknown as import('next/server').NextRequest
}

beforeEach(() => {
  state.user = { id: 'owner-user-id', email: 'owner@example.test' }
  state.owner = true
  state.ai = 'on'
  state.counts.clear()
  state.limits.length = 0
  state.inserts.length = 0
  state.insertError = null
  state.generate.mockReset()
  state.generate.mockResolvedValue({ status: 'ok', variants: [], rejected: [], grounding: {}, model: { provider: 'anthropic', model: 'm' } })
})

describe.each(Object.keys(routes) as Name[])('%s route boundary', (name) => {
  it('refuses a cross-origin request before reading the session', async () => {
    const handler = await routes[name]()
    const response = await handler(post(BODIES[name], { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' }))
    expect(response.status).toBe(403)
    expect(state.limits).toEqual([])
  })
  it('requires a signed-in owner', async () => {
    const handler = await routes[name]()
    state.user = null
    expect((await handler(post(BODIES[name]))).status).toBe(401)
    state.user = { id: 'other', email: 'other@example.test' }
    state.owner = false
    expect((await handler(post(BODIES[name]))).status).toBe(403)
    expect(state.limits).toEqual([])
  })
  it('rate limits per owner', async () => {
    const handler = await routes[name]()
    const first = await handler(post(BODIES[name]))
    expect(first.status).toBeLessThan(400)
    const { limit } = state.limits[0]
    for (let n = 1; n < limit; n++) expect((await handler(post(BODIES[name]))).status).not.toBe(429)
    expect((await handler(post(BODIES[name]))).status).toBe(429)
  })
  it('rejects malformed, unknown-field and oversized bodies', async () => {
    const handler = await routes[name]()
    expect((await handler(post('{not json'))).status).toBe(400)
    expect((await handler(post({ ...(BODIES[name] as object), extra: 1 }))).status).toBe(400)
    expect((await handler(post({ pad: 'x'.repeat(70_000) }))).status).toBe(413)
  })
})

describe('generate', () => {
  it('answers AI-off with 409 before the rate limit or the generator', async () => {
    state.ai = 'off'
    const response = await (await routes.generate())(post(BODIES.generate))
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ code: 'AI_OFF', error: expect.stringMatching(/Connect a provider in Settings/) })
    expect(state.limits).toEqual([])
    expect(state.generate).not.toHaveBeenCalled()
  })
  it('validates the brief (variant count, field length) before generating', async () => {
    const handler = await routes.generate()
    expect((await handler(post({ ...(BODIES.generate as object), variants: 50 }))).status).toBe(400)
    expect((await handler(post({ ...(BODIES.generate as object), product: 'x'.repeat(201) }))).status).toBe(400)
    expect(state.generate).not.toHaveBeenCalled()
    expect((await handler(post(BODIES.generate))).status).toBe(200)
    expect(state.generate).toHaveBeenCalledTimes(1)
  })
  it('maps a refused generation to 422 and never caches', async () => {
    state.generate.mockResolvedValue({ status: 'refused', code: 'AI_REFUSED', message: 'declined' })
    const response = await (await routes.generate())(post(BODIES.generate))
    expect(response.status).toBe(422)
    expect(response.headers.get('cache-control')).toContain('no-store')
  })
})

describe('score', () => {
  it('scores pasted text and a variant set without AI', async () => {
    state.ai = 'off'
    const handler = await routes.score()
    const one = await (await handler(post(BODIES.score))).json()
    expect(one.score).toMatchObject({ score: expect.any(Number), findings: expect.any(Array) })
    const set = await (await handler(post({ variants: [VARIANT, VARIANT], goal: 'bookings' }))).json()
    expect(set.variants).toHaveLength(2)
    expect(set.duplicates).toHaveLength(1)
  })
})

describe('bank', () => {
  it('saves one row per field for the active account', async () => {
    const response = await (await routes.bank())(post(BODIES.bank))
    expect(response.status).toBe(201)
    const rows = state.inserts[0] as Array<Record<string, unknown>>
    expect(rows.map((r) => r.copy_type)).toEqual(['hook', 'primary_text', 'headline', 'description', 'cta'])
    expect(new Set(rows.map((r) => r.ad_account_id))).toEqual(new Set(['account-1']))
    expect(rows[0]).toMatchObject({ model_used: 'copy_studio', angle: 'specific_benefit', is_approved: false })
  })
  it('refuses blocked copy (unverified claim) without writing', async () => {
    const response = await (await routes.bank())(post({ ...(BODIES.bank as object), variant: { ...VARIANT, headline: 'The best studio in town' } }))
    expect(response.status).toBe(422)
    expect(await response.json()).toMatchObject({ code: 'COPY_NOT_PUBLISHABLE' })
    expect(state.inserts).toEqual([])
  })
  it('hides the database error', async () => {
    state.insertError = { code: '42501', message: 'permission denied for table copy_variations' }
    const response = await (await routes.bank())(post(BODIES.bank))
    expect(response.status).toBe(500)
    expect(JSON.stringify(await response.json())).not.toContain('copy_variations')
  })
})
