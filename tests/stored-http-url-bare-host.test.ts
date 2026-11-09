import { beforeEach, describe, expect, it, vi } from 'vitest'

// Security review fix 6: parseStoredHttpUrl rejected "example.com" (no scheme), a usability regression
// on the competitor form, and instagram_url was stored with no validation at all. A bare hostname
// (optionally with a path) is stored as https://; everything the rule rejected before stays rejected.
const state = vi.hoisted(() => ({ writes: [] as Array<{ op: string; row: Record<string, unknown> }> }))

function db() {
  const chain: Record<string, unknown> = {}
  for (const method of ['from', 'select', 'eq', 'single']) chain[method] = vi.fn(() => chain)
  chain.maybeSingle = vi.fn(async () => ({ data: { id: 'competitor-1' }, error: null }))
  chain.insert = vi.fn((row: Record<string, unknown>) => { state.writes.push({ op: 'insert', row }); return chain })
  chain.update = vi.fn((row: Record<string, unknown>) => { state.writes.push({ op: 'update', row }); return chain })
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

const REJECTED: Array<[string, unknown]> = [
  ['javascript: URL', 'javascript:alert(document.cookie)'],
  ['mixed-case javascript: URL', 'JavaScript:alert(1)'],
  ['data: URL', 'data:text/html,<script>alert(1)</script>'],
  ['ftp: URL', 'ftp://rival.example/file'],
  ['mailto: URL', 'mailto:owner@rival.example'],
  ['host with a port (parses as a scheme)', 'rival.example:8080/x'],
  ['relative path', '/relative/path'],
  ['dot-relative path', './rival.example'],
  ['protocol-relative URL', '//rival.example/studio'],
  ['userinfo smuggling', 'rival.example@evil.example'],
  ['single label', 'localhost'],
  ['embedded whitespace', 'rival .example'],
  ['over-long bare host', `rival.example/${'a'.repeat(2_100)}`],
  ['over-long https URL', `https://rival.example/${'a'.repeat(2_100)}`],
  ['non-string', 42],
]

describe('parseStoredHttpUrl', () => {
  it.each([
    ['example.com', 'https://example.com/'],
    ['  Rival.Example/studio?ref=1  ', 'https://rival.example/studio?ref=1'],
    ['www.rival.example', 'https://www.rival.example/'],
  ])('accepts the bare hostname %j as https', async (input, expected) => {
    const { parseStoredHttpUrl } = await import('@/lib/security/http-url')
    expect(parseStoredHttpUrl(input)).toEqual({ ok: true, value: expected })
  })

  it.each(REJECTED)('rejects a %s', async (_label, input) => {
    const { parseStoredHttpUrl } = await import('@/lib/security/http-url')
    expect(parseStoredHttpUrl(input)).toEqual({ ok: false })
  })

  it('control: absolute http(s) URLs and blank values behave as before', async () => {
    const { parseStoredHttpUrl } = await import('@/lib/security/http-url')
    expect(parseStoredHttpUrl('http://rival.example')).toEqual({ ok: true, value: 'http://rival.example/' })
    expect(parseStoredHttpUrl('https://rival.example/a')).toEqual({ ok: true, value: 'https://rival.example/a' })
    expect(parseStoredHttpUrl('   ')).toEqual({ ok: true, value: null })
    expect(parseStoredHttpUrl(null)).toEqual({ ok: true, value: null })
  })
})

// Security review: a stored competitor URL is rendered as a link and may later be fetched, so it must
// not carry credentials or name a local, internal or non-public address.
const NON_PUBLIC: Array<[string, string]> = [
  ['username and password', 'https://user:pw@example.com/'],
  ['username only', 'https://user@example.com/'],
  ['empty username with a password', 'https://:pw@example.com/'],
  ['localhost', 'http://localhost/'],
  ['localhost with a trailing dot', 'http://localhost./'],
  ['a *.localhost name', 'https://app.localhost/'],
  ['a *.local name', 'https://printer.local/'],
  ['a bare *.local name', 'studio.local'],
  ['a *.internal name', 'https://metadata.google.internal/'],
  ['a bare *.internal name', 'billing.corp.internal/x'],
  ['an upper-case *.INTERNAL name', 'https://HOST.INTERNAL/'],
  ['IPv4 loopback', 'http://127.0.0.1/'],
  ['IPv4 loopback in decimal form', 'http://2130706433/'],
  ['IPv4 loopback in short form', 'http://127.1/'],
  ['IPv6 loopback', 'http://[::1]/'],
  ['IPv4-mapped IPv6 loopback', 'http://[::ffff:127.0.0.1]/'],
  ['private 10/8', 'https://10.0.0.5/'],
  ['private 192.168/16', 'http://192.168.1.1/admin'],
  ['private 172.16/12', 'http://172.20.0.1/'],
  ['link-local cloud metadata', 'http://169.254.169.254/latest/meta-data/'],
  ['unspecified address', 'http://0.0.0.0/'],
  ['IPv6 unique-local', 'https://[fd00::1]/'],
  ['IPv6 link-local', 'https://[fe80::1]/'],
]

describe('parseStoredHttpUrl refuses credentials and non-public hosts', () => {
  it.each(NON_PUBLIC)('rejects %s', async (_label, input) => {
    const { parseStoredHttpUrl } = await import('@/lib/security/http-url')
    expect(parseStoredHttpUrl(input)).toEqual({ ok: false })
  })

  it('control: public hostnames and public IP literals are still accepted', async () => {
    const { parseStoredHttpUrl } = await import('@/lib/security/http-url')
    expect(parseStoredHttpUrl('https://rival.example/studio')).toEqual({ ok: true, value: 'https://rival.example/studio' })
    expect(parseStoredHttpUrl('rival.example')).toEqual({ ok: true, value: 'https://rival.example/' })
    expect(parseStoredHttpUrl('https://8.8.8.8/')).toEqual({ ok: true, value: 'https://8.8.8.8/' })
    expect(parseStoredHttpUrl('http://[2606:4700:4700::1111]/')).toEqual({ ok: true, value: 'http://[2606:4700:4700::1111]/' })
    // Names that merely contain a blocked word are not blocked.
    expect(parseStoredHttpUrl('https://localhost-studio.example/')).toEqual({ ok: true, value: 'https://localhost-studio.example/' })
    expect(parseStoredHttpUrl('https://internal.rival.example/')).toEqual({ ok: true, value: 'https://internal.rival.example/' })
  })
})

describe('competitor routes', () => {
  beforeEach(() => {
    state.writes.length = 0
  })

  it('POST stores a bare website hostname as https', async () => {
    const { POST } = await import('@/app/api/competitors/route')
    expect((await POST(jsonRequest('POST', { name: 'Rival', website_url: 'rival.example' }))).status).toBe(200)
    expect(state.writes[0].row).toMatchObject({ website_url: 'https://rival.example/' })
  })

  it.each(REJECTED)('POST rejects an instagram_url that is a %s before writing', async (_label, instagramUrl) => {
    const { POST } = await import('@/app/api/competitors/route')
    const response = await POST(jsonRequest('POST', { name: 'Rival', instagram_url: instagramUrl }))
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ code: 'INVALID_INSTAGRAM_URL' })
    expect(state.writes).toHaveLength(0)
  })

  it.each(REJECTED)('PATCH rejects an instagram_url that is a %s before writing', async (_label, instagramUrl) => {
    const { PATCH } = await import('@/app/api/competitors/[id]/route')
    const response = await PATCH(jsonRequest('PATCH', { instagram_url: instagramUrl }), { params: Promise.resolve({ id: 'competitor-1' }) })
    expect(response.status).toBe(400)
    expect(state.writes).toHaveLength(0)
  })

  it('control: instagram_url accepts an https URL, a bare host, omission and null', async () => {
    const { POST } = await import('@/app/api/competitors/route')
    const { PATCH } = await import('@/app/api/competitors/[id]/route')
    const ctx = { params: Promise.resolve({ id: 'competitor-1' }) }
    expect((await POST(jsonRequest('POST', { name: 'Rival', instagram_url: 'https://instagram.com/rival' }))).status).toBe(200)
    expect(state.writes[0].row).toMatchObject({ instagram_url: 'https://instagram.com/rival' })
    expect((await POST(jsonRequest('POST', { name: 'Rival Two' }))).status).toBe(200)
    expect(state.writes[1].row).toMatchObject({ instagram_url: null })
    expect((await PATCH(jsonRequest('PATCH', { instagram_url: 'instagram.com/rival' }), ctx)).status).toBe(200)
    expect(state.writes[2].row).toMatchObject({ instagram_url: 'https://instagram.com/rival' })
    expect((await PATCH(jsonRequest('PATCH', { instagram_url: null }), ctx)).status).toBe(200)
    expect(state.writes[3].row).toMatchObject({ instagram_url: null })
    expect((await PATCH(jsonRequest('PATCH', { notes: 'x' }), ctx)).status).toBe(200)
    expect(state.writes[4].row).not.toHaveProperty('instagram_url')
  })
})
