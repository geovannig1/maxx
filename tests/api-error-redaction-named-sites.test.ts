import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// The security review named five sites that still returned raw error text after the sampled
// redaction test passed: three owner routes and two MCP tools that put a Supabase message into the
// tool result the model reads. The MCP dispatcher returned every thrown message the same way.
const DB_DETAIL = 'relation "secret_internal_table" violates check constraint secret_ck SQLSTATE 23514'
const failure = { data: null, error: { message: DB_DETAIL, code: '23514', details: 'row detail', hint: 'secret hint' } }

const state = vi.hoisted(() => ({ failTables: new Set<string>() }))

function tableChain(table: string) {
  const result = state.failTables.has(table)
    ? failure
    : { data: table === 'competitor_sources' ? [{ id: 'src-1', name: 'Rival', facebook_page_id: null }] : [], error: null }
  const chain: Record<string, unknown> = {}
  for (const method of ['select', 'eq', 'in', 'order', 'limit', 'gte']) chain[method] = vi.fn(() => chain)
  chain.then = (resolve: (value: unknown) => unknown) => Promise.resolve(resolve(result))
  return chain
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: 'owner-id', email: 'owner@example.test' } } }) } }),
}))
vi.mock('@/lib/auth/require-owner', () => ({ ownerOnly: () => null }))
vi.mock('@/lib/supabase/admin', () => ({ getAdminClient: () => ({ from: (table: string) => tableChain(table) }) }))
vi.mock('@/lib/accounts/active-account', () => ({
  resolveOnlyActiveAccount: async () => ({ ok: true, account: { id: 'account-1', accountId: 'act_1', accountName: 'Studio' } }),
  activeAccountErrorCode: () => 'ACTIVE_ACCOUNT_UNAVAILABLE',
  activeAccountErrorStatus: () => 503,
}))
vi.mock('@/lib/ga4/client', () => ({
  getGa4Bookings: async () => {
    throw Object.assign(new Error(`GA4 said ${DB_DETAIL}`), { details: 'property 123 secret', code: 7, statusDetails: [{ secret: true }] })
  },
}))
vi.mock('@/lib/diagnostics/reconciliation-report', () => ({
  buildReconciliationReport: async ({ adAccountId }: { adAccountId: string }) => {
    if (adAccountId === 'missing') throw new Error('Ad account not found')
    throw new Error(DB_DETAIL)
  },
}))
vi.mock('@/mcp/tools/daily-report', () => ({
  getDailyReport: async (args: { date?: string }) => {
    const { ToolInputError } = await import('@/lib/security/api-error')
    if (args.date === 'bad') throw new ToolInputError('date must be in YYYY-MM-DD format')
    throw new Error(`Daily report query failed: ${DB_DETAIL}`)
  },
}))

function expectRedacted(value: unknown) {
  const text = JSON.stringify(value)
  expect(text).not.toContain('secret_internal_table')
  expect(text).not.toContain('SQLSTATE')
  expect(text).not.toContain('secret')
}

function loggedText(): string {
  return vi.mocked(console.error).mock.calls.map((call) => call.map(String).join(' ')).join('\n')
}

beforeEach(() => {
  state.failTables.clear()
  vi.spyOn(console, 'error').mockImplementation(() => undefined).mockClear()
})

describe('owner routes named by the review', () => {
  it('GET /api/ga4/bookings returns a code, not message/details/code/statusDetails', async () => {
    const { GET } = await import('@/app/api/ga4/bookings/route')
    const response = await GET(new NextRequest('https://maxx.example/api/ga4/bookings'))
    const body = await response.json()
    expect(response.status).toBe(500)
    expectRedacted(body)
    expect(body.code).toMatch(/^[A-Z][A-Z0-9_]+$/)
    expect(loggedText()).toContain('secret_internal_table')
  })

  it('GET /api/signals returns a code, not PostgREST text', async () => {
    state.failTables.add('expert_sources')
    const { GET } = await import('@/app/api/signals/route')
    const response = await GET()
    const body = await response.json()
    expect(response.status).toBe(503)
    expectRedacted(body)
    expect(body).toMatchObject({ status: 'UNAVAILABLE', code: 'EXPERT_SIGNAL_READ_UNAVAILABLE' })
    expect(loggedText()).toContain('secret_internal_table')
  })

  it('GET /api/diagnostics/reconciliation returns a code, not the thrown message', async () => {
    const { GET } = await import('@/app/api/diagnostics/reconciliation/route')
    const response = await GET(new NextRequest('https://maxx.example/api/diagnostics/reconciliation?from=2026-10-01&to=2026-10-07'))
    const body = await response.json()
    expect(response.status).toBe(500)
    expectRedacted(body)
    expect(body.code).toMatch(/^[A-Z][A-Z0-9_]+$/)
    expect(loggedText()).toContain('secret_internal_table')
  })

  it('control: reconciliation keeps its 404 for a missing account', async () => {
    const active = await import('@/lib/accounts/active-account')
    vi.spyOn(active, 'resolveOnlyActiveAccount').mockResolvedValueOnce(
      { ok: true, account: { id: 'missing', accountId: 'act_1', accountName: 'Studio' } } as never,
    )
    const { GET } = await import('@/app/api/diagnostics/reconciliation/route')
    const response = await GET(new NextRequest('https://maxx.example/api/diagnostics/reconciliation?from=2026-10-01&to=2026-10-07'))
    expect(response.status).toBe(404)
    expect(await response.json()).toMatchObject({ error: 'Ad account not found' })
  })
})

describe('MCP tool results named by the review', () => {
  it('get_competitor_ads keeps its code but not the Supabase message', async () => {
    state.failTables.add('competitor_ads')
    const { getCompetitorAds } = await import('@/mcp/tools/competitor-ads')
    const result = await getCompetitorAds({}) as Record<string, unknown>
    expect(result).toMatchObject({ status: 'unavailable', error_code: 'COMPETITOR_AD_READ_UNAVAILABLE' })
    expectRedacted(result)
    expect(loggedText()).toContain('secret_internal_table')
  })

  it('get_discovery_feed keeps its code but not the Supabase message', async () => {
    state.failTables.add('competitor_ads')
    const { getDiscoveryFeed } = await import('@/mcp/tools/discovery-feed')
    const result = await getDiscoveryFeed({}) as Record<string, unknown>
    expect(result).toMatchObject({ status: 'unavailable', error_code: 'COMPETITOR_AD_READ_UNAVAILABLE' })
    expectRedacted(result)
    expect(loggedText()).toContain('secret_internal_table')
  })

  it('control: a successful read is still available', async () => {
    const { getCompetitorAds } = await import('@/mcp/tools/competitor-ads')
    expect(await getCompetitorAds({})).toMatchObject({ status: 'available' })
  })
})

describe('MCP dispatcher', () => {
  async function callTool(name: string, args: Record<string, unknown>) {
    const handlers: Array<(request: unknown) => Promise<unknown>> = []
    const server = { setRequestHandler: (_schema: unknown, handler: (request: unknown) => Promise<unknown>) => handlers.push(handler) }
    const { registerTools } = await import('@/mcp/tools/index')
    registerTools(server as never)
    const result = await handlers[1]({ params: { name, arguments: args } }) as { content: Array<{ text: string }>; isError?: boolean }
    return { isError: result.isError, body: JSON.parse(result.content[0].text) as Record<string, unknown> }
  }

  it('does not return a thrown database message to the model', async () => {
    const { isError, body } = await callTool('get_daily_report', {})
    expect(isError).toBe(true)
    expect(body.error).toBe('TOOL_ERROR')
    expectRedacted(body)
    expect(loggedText()).toContain('secret_internal_table')
  })

  it('control: an authored argument error still reaches the model so it can correct the call', async () => {
    const { body } = await callTool('get_daily_report', { date: 'bad' })
    expect(body).toMatchObject({ error: 'TOOL_ERROR', message: 'date must be in YYYY-MM-DD format' })
  })

  it('control: an unknown tool is still named', async () => {
    const { body } = await callTool('pause_ad', {})
    expect(body.error).toBe('UNKNOWN_TOOL')
    expect(String(body.message)).toContain('pause_ad')
  })
})
