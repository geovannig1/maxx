import { beforeEach, describe, expect, it, vi } from 'vitest'

// website_url is stored and later rendered as a link. Only absolute http(s) URLs of bounded length
// may be stored; javascript:, data:, relative and over-long values are rejected with 400.
const state = vi.hoisted(() => ({ writes: [] as Array<{ op: string; row: unknown }> }))

function db() {
  const chain: Record<string, unknown> = {}
  for (const method of ['from', 'select', 'eq', 'single']) chain[method] = vi.fn(() => chain)
  chain.maybeSingle = vi.fn(async () => ({ data: { id: 'competitor-1' }, error: null }))
  chain.insert = vi.fn((row: unknown) => { state.writes.push({ op: 'insert', row }); return chain })
  chain.update = vi.fn((row: unknown) => { state.writes.push({ op: 'update', row }); return chain })
  chain.then = (resolve: (value: unknown) => unknown) => resolve({ data: { id: 'competitor-1' }, error: null })
  return chain
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: 'owner-id', email: 'owner@example.test' } } }) } }),
}))
vi.mock('@/lib/auth/require-owner', () => ({ ownerOnly: () => null }))
vi.mock('@/lib/supabase/admin', () => ({ getAdminClient: () => db() }))
vi.mock('@/lib/accounts/active-account', () => ({
  resolveOnlyActiveAccount: async () => ({ ok: true, account: { id: 'account-1' } }),
}))

function jsonRequest(method: string, body: unknown) {
  return new Request('https://maxx.example/api/competitors', {
    method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }) as unknown as import('next/server').NextRequest
}

const BAD_URLS: Array<[string, unknown]> = [
  ['javascript: URL', 'javascript:alert(document.cookie)'],
  ['mixed-case javascript: URL', 'JavaScript:alert(1)'],
  ['data: URL', 'data:text/html,<script>alert(1)</script>'],
  ['relative path', '/relative/path'],
  ['protocol-relative URL', '//www.rival.example'],
  ['ftp: URL', 'ftp://rival.example/file'],
  ['over-long https URL', `https://rival.example/${'a'.repeat(2_100)}`],
  ['non-string', 42],
]

describe('competitor website_url validation', () => {
  beforeEach(() => {
    state.writes.length = 0
  })

  it.each(BAD_URLS)('POST rejects a %s with 400 before writing', async (_label, websiteUrl) => {
    const { POST } = await import('@/app/api/competitors/route')
    const response = await POST(jsonRequest('POST', { name: 'Rival', website_url: websiteUrl }))
    expect(response.status).toBe(400)
    expect(state.writes).toHaveLength(0)
  })

  it.each(BAD_URLS)('PATCH rejects a %s with 400 before writing', async (_label, websiteUrl) => {
    const { PATCH } = await import('@/app/api/competitors/[id]/route')
    const response = await PATCH(jsonRequest('PATCH', { website_url: websiteUrl }), { params: Promise.resolve({ id: 'competitor-1' }) })
    expect(response.status).toBe(400)
    expect(state.writes).toHaveLength(0)
  })

  it('control: POST accepts a normal https URL and an omitted one', async () => {
    const { POST } = await import('@/app/api/competitors/route')
    expect((await POST(jsonRequest('POST', { name: 'Rival', website_url: 'https://rival.example/studio' }))).status).toBe(200)
    expect(state.writes[0].row).toMatchObject({ website_url: 'https://rival.example/studio' })
    expect((await POST(jsonRequest('POST', { name: 'Rival Two' }))).status).toBe(200)
    expect(state.writes[1].row).toMatchObject({ website_url: null })
  })

  it('control: PATCH accepts a normal https URL and null to clear it', async () => {
    const { PATCH } = await import('@/app/api/competitors/[id]/route')
    const ctx = { params: Promise.resolve({ id: 'competitor-1' }) }
    expect((await PATCH(jsonRequest('PATCH', { website_url: 'http://rival.example' }), ctx)).status).toBe(200)
    expect(state.writes[0].row).toMatchObject({ website_url: 'http://rival.example/' })
    expect((await PATCH(jsonRequest('PATCH', { website_url: null }), ctx)).status).toBe(200)
    expect(state.writes[1].row).toMatchObject({ website_url: null })
  })
})
