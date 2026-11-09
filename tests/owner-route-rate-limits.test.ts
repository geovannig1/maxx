import { beforeEach, describe, expect, it, vi } from 'vitest'

// Owner-only write routes had no request limit. Each now consumes a per-owner bucket. The quarantined
// generate/image, generate/video and competitors/lookup routes are deliberately absent: they return a
// constant 409 with no database work (creative-generation-route-gate.test.ts asserts that), so they
// need their limit when they are re-enabled, not before. The fake limiter counts per (bucket, actor) and enforces the
// limit each route passes, so the test sees the route's real limit.
const state = vi.hoisted(() => ({
  counts: new Map<string, number>(),
  calls: [] as Array<{ bucket: string; actorKey: string; limit: number; windowSeconds: number }>,
}))

vi.mock('@/lib/security/api-rate-limit', () => ({
  enforceApiRateLimit: vi.fn(async (options: { bucket: string; actorKey: string; limit: number; windowSeconds: number }) => {
    state.calls.push(options)
    const key = `${options.bucket}|${options.actorKey}`
    const used = (state.counts.get(key) ?? 0) + 1
    state.counts.set(key, used)
    return used > options.limit
      ? Response.json({ error: 'Too many requests. Try again later.', code: 'RATE_LIMITED' }, { status: 429 })
      : null
  }),
}))
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: 'owner-user-id', email: 'owner@example.test' } } }) } }),
}))
vi.mock('@/lib/auth/require-owner', () => ({ ownerOnly: () => null }))

function db() {
  const chain: Record<string, unknown> = {}
  for (const method of ['from', 'select', 'eq', 'or', 'limit', 'insert', 'single', 'order']) chain[method] = vi.fn(() => chain)
  chain.maybeSingle = vi.fn(async () => ({ data: { id: 'account-1' }, error: null }))
  chain.then = (resolve: (value: unknown) => unknown) => resolve({ data: [], error: null, count: 1 })
  return chain
}
vi.mock('@/lib/supabase/admin', () => ({ getAdminClient: () => db() }))
vi.mock('@/lib/accounts/active-account', () => ({
  resolveOnlyActiveAccount: async () => ({ ok: true, account: { id: 'account-1' } }),
  activeAccountErrorCode: () => 'ACTIVE_ACCOUNT_UNAVAILABLE',
  activeAccountErrorStatus: () => 503,
}))

function post(body: unknown = {}) {
  return new Request('https://maxx.example/api/x', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }) as unknown as import('next/server').NextRequest
}

type Handler = (req: import('next/server').NextRequest) => Promise<Response>

const ROUTES: Array<{ name: string; bucket: string; load: () => Promise<Handler>; body?: unknown }> = [
  { name: 'competitors/seed', bucket: 'competitor_seed', load: async () => (await import('@/app/api/competitors/seed/route')).POST as unknown as Handler },
  { name: 'signals/seed', bucket: 'signals_seed', load: async () => (await import('@/app/api/signals/seed/route')).POST as unknown as Handler },
  {
    name: 'hooks POST', bucket: 'hooks_create', load: async () => (await import('@/app/api/hooks/route')).POST,
    body: { copy_text: 'Book the cyc wall', copy_type: 'headline' },
  },
]

describe('owner-only paid/seed routes are rate limited per owner', () => {
  beforeEach(() => {
    state.counts.clear()
    state.calls.length = 0
    process.env.META_AD_ACCOUNT_ID = 'act_1'
  })

  it.each(ROUTES)('$name: requests under the limit pass, the next one gets 429', async ({ bucket, load, body }) => {
    const handler = await load()

    const first = await handler(post(body))
    expect(first.status).not.toBe(429)
    const call = state.calls.find((entry) => entry.bucket === bucket)
    expect(call).toBeDefined()
    expect(call!.actorKey).toBe('owner-user-id')
    expect(call!.limit).toBeGreaterThan(0)

    for (let n = 1; n < call!.limit; n++) {
      expect((await handler(post(body))).status).not.toBe(429)
    }
    const blocked = await handler(post(body))
    expect(blocked.status).toBe(429)
    expect(await blocked.json()).toMatchObject({ code: 'RATE_LIMITED' })
  })
})
