import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Database error text names tables, columns and SQL states. The discovery routes must log it and
// return only a generic message and a stable code.
const DB_ERROR = { message: 'permission denied for table competitor_sources (SQLSTATE 42501)' }

function failingDb(failTable: string) {
  let table = ''
  const chain: Record<string, unknown> = {
    from(next: string) { table = next; return chain },
    select() { return chain }, eq() { return chain }, in() { return chain },
    order() { return chain }, limit() { return chain }, update() { return chain }, single() { return chain },
    then(resolve: (value: unknown) => unknown) {
      return Promise.resolve(table === failTable
        ? { data: null, error: DB_ERROR }
        : { data: [{ id: 'source-1' }], error: null }).then(resolve)
    },
  }
  return chain
}

async function loadDiscoveryGet(failTable: string) {
  vi.doMock('@/lib/supabase/server', () => ({
    createClient: async () => ({ auth: { getUser: async () => ({ data: { user: {
      email: 'owner@example.test', email_confirmed_at: '2026-01-01T00:00:00Z',
    } } }) } }),
  }))
  vi.doMock('@/lib/accounts/active-account', () => ({
    resolveOnlyActiveAccount: async () => ({ ok: true, account: { id: 'account-1' } }),
  }))
  vi.doMock('@/lib/supabase/admin', () => ({ getAdminClient: () => failingDb(failTable) }))
  const { GET } = await import('@/app/api/discovery/route')
  return GET
}

describe('discovery route error redaction', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.stubEnv('OWNER_EMAIL', 'owner@example.test')
  })
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    vi.doUnmock('@/lib/supabase/server')
    vi.doUnmock('@/lib/accounts/active-account')
    vi.doUnmock('@/lib/supabase/admin')
  })

  for (const table of ['competitor_sources', 'competitor_ads']) {
    it(`does not return the database error text when reading ${table} fails`, async () => {
      const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)
      const GET = await loadDiscoveryGet(table)
      const res = await GET(new Request('https://app.example.test/api/discovery') as never)
      const text = await res.text()

      expect(res.status).toBe(500)
      expect(text).not.toContain('SQLSTATE')
      expect(text).not.toContain('permission denied')
      expect(JSON.parse(text).code).toMatch(/^competitor_\w+_failed$/)
      // Control: the detail is not lost; it goes to the server log.
      expect(logged.mock.calls.flat().join(' ')).toContain('SQLSTATE 42501')
    })
  }
})
