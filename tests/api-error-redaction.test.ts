import { NextRequest } from 'next/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Owner-only routes returned raw Supabase `error.message` text (table, column, constraint and SQL
// detail) to the browser. A failing DB call must yield a generic message plus a stable code, keep the
// status, and log the detail server-side with the route name.
const DB_DETAIL = 'relation "secret_internal_table" violates check constraint secret_ck SQLSTATE 23514'

function failingDb() {
  const failure = { data: null, error: { message: DB_DETAIL, code: '23514' }, count: null }
  const chain: Record<string, unknown> = {}
  for (const method of [
    'from', 'select', 'eq', 'neq', 'in', 'is', 'not', 'gte', 'lte', 'lt', 'gt', 'or', 'order', 'limit',
    'range', 'insert', 'update', 'upsert', 'delete', 'contains', 'filter', 'match',
  ]) chain[method] = vi.fn(() => chain)
  chain.single = vi.fn(async () => failure)
  chain.maybeSingle = vi.fn(async () => failure)
  chain.rpc = vi.fn(async () => failure)
  chain.then = (resolve: (value: unknown) => unknown) => resolve(failure)
  return chain
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: 'owner-id', email: 'owner@example.test' } } }) } }),
}))
vi.mock('@/lib/auth/require-owner', () => ({ ownerOnly: () => null }))
vi.mock('@/lib/auth/owner', () => ({ ownerGate: () => ({ allowed: true }) }))
vi.mock('@/lib/security/same-origin', () => ({ rejectCrossOriginMutation: () => null }))
vi.mock('@/lib/supabase/admin', () => ({ getAdminClient: () => failingDb() }))
vi.mock('@/lib/accounts/active-account', () => ({
  resolveOnlyActiveAccount: async () => ({ ok: true, account: { id: 'account-1', accountId: 'act_1', accountName: 'Studio' } }),
  activeAccountErrorCode: () => 'ACTIVE_ACCOUNT_UNAVAILABLE',
  activeAccountErrorStatus: () => 503,
}))

function get(path: string) {
  return new NextRequest(`https://maxx.example${path}`)
}
function send(method: string, path: string, body: unknown) {
  return new NextRequest(`https://maxx.example${path}`, {
    method, headers: { 'content-type': 'application/json', origin: 'https://maxx.example' }, body: JSON.stringify(body),
  })
}
const ctx = (id: string) => ({ params: Promise.resolve({ id }) })

type Case = { name: string; status: number; run: () => Promise<Response> }

const CASES: Case[] = [
  { name: 'GET /api/flags', status: 500, run: async () => (await import('@/app/api/flags/route')).GET(get('/api/flags')) },
  { name: 'GET /api/settings', status: 500, run: async () => (await import('@/app/api/settings/route')).GET() },
  { name: 'GET /api/alerts', status: 500, run: async () => (await import('@/app/api/alerts/route')).GET(get('/api/alerts')) },
  { name: 'GET /api/changes', status: 500, run: async () => (await import('@/app/api/changes/route')).GET(get('/api/changes')) },
  { name: 'GET /api/competitors', status: 500, run: async () => (await import('@/app/api/competitors/route')).GET() },
  { name: 'GET /api/competitor-ads', status: 500, run: async () => (await import('@/app/api/competitor-ads/route')).GET(get('/api/competitor-ads')) },
  { name: 'GET /api/hooks', status: 500, run: async () => (await import('@/app/api/hooks/route')).GET(get('/api/hooks')) },
  { name: 'GET /api/diagnostics/decision-gate', status: 502, run: async () => (await import('@/app/api/diagnostics/decision-gate/route')).GET() },
  { name: 'GET /api/tasks', status: 503, run: async () => (await import('@/app/api/tasks/route')).GET(get('/api/tasks')) },
  {
    name: 'PATCH /api/changes/[id]', status: 500,
    run: async () => (await import('@/app/api/changes/[id]/route')).PATCH(send('PATCH', '/api/changes/c1', { action: 'reject' }), ctx('c1')),
  },
  {
    name: 'POST /api/competitors', status: 500,
    run: async () => (await import('@/app/api/competitors/route')).POST(send('POST', '/api/competitors', { name: 'Rival' })),
  },
]

describe('owner API routes do not return raw database error text', () => {
  beforeEach(() => {
    process.env.META_AD_ACCOUNT_ID = 'act_1'
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  })
  // Each case must find its OWN route's log line. Under Vitest 4 the spy's calls accumulated across cases,
  // so PATCH /api/changes/[id] passed on another route's `[api ...]` line while logging none itself.
  afterEach(() => { vi.restoreAllMocks() })

  it.each(CASES)('$name returns a generic message and code, keeps its status, and logs the detail', async ({ name, status, run }) => {
    const response = await run()
    const text = await response.text()
    expect(response.status).toBe(status)
    expect(text).not.toContain('secret_internal_table')
    expect(text).not.toContain('SQLSTATE')
    const body = JSON.parse(text) as { error?: unknown; code?: unknown }
    expect(typeof body.error).toBe('string')
    expect(body.code).toMatch(/^[A-Z][A-Z0-9_]+$/)
    const logged = vi.mocked(console.error).mock.calls.map((call) => call.map(String).join(' ')).join('\n')
    expect(logged).toContain('secret_internal_table')
    // This case's own route tag, not just any `[api …]` line.
    expect(logged).toContain(`[api ${name}]`)
  })
})

describe('apiErrorResponse', () => {
  it('control: returns the stable code, keeps extra fields, and never the detail', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { apiErrorResponse } = await import('@/lib/security/api-error')
    const response = apiErrorResponse('GET /api/x', 'X_READ_FAILED', { message: DB_DETAIL }, 503, { ads: [] })
    expect(response.status).toBe(503)
    const body = await response.json()
    expect(body).toMatchObject({ code: 'X_READ_FAILED', ads: [] })
    expect(JSON.stringify(body)).not.toContain('secret_internal_table')
  })
})
