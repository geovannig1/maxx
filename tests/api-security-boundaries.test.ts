import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const state = vi.hoisted(() => ({
  user: { id: 'owner-id', email: 'owner@example.com' } as { id: string; email: string } | null,
  ownerAllowed: true,
  adminCalls: 0,
  runDailySync: vi.fn(),
  runMaxxChat: vi.fn(),
  maxxEnabled: true,
  rateLimitResponse: null as Response | null,
  enforceApiRateLimit: vi.fn(),
}))

function queryChain() {
  const result = { data: [], error: null }
  const chain: Record<string, unknown> = {}
  for (const method of ['select', 'eq', 'or', 'in', 'not', 'order', 'limit', 'gte', 'lte']) {
    chain[method] = () => chain
  }
  chain.maybeSingle = async () => ({ data: null, error: null })
  chain.then = (resolve: (value: typeof result) => unknown) => Promise.resolve(resolve(result))
  return chain
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: state.user } }) },
  }),
}))

vi.mock('@/lib/supabase/admin', () => ({
  getAdminClient: () => {
    state.adminCalls += 1
    return { from: () => queryChain() }
  },
}))

vi.mock('@/lib/auth/require-owner', () => ({
  ownerOnly: () => state.ownerAllowed
    ? null
    : Response.json({ error: 'Forbidden — owner only.' }, { status: 403 }),
}))

vi.mock('@/lib/security/api-rate-limit', () => ({
  enforceApiRateLimit: state.enforceApiRateLimit,
}))

vi.mock('@/lib/sync/orchestrator', () => ({
  runDailySync: state.runDailySync,
}))

vi.mock('@/lib/maxx/chat', () => ({
  maxxChatEnabled: () => state.maxxEnabled,
  runMaxxChat: state.runMaxxChat,
}))

describe('API security boundaries', () => {
  beforeEach(() => {
    state.user = { id: 'owner-id', email: 'owner@example.com' }
    state.ownerAllowed = true
    state.adminCalls = 0
    state.maxxEnabled = true
    state.rateLimitResponse = null
    state.runDailySync.mockReset()
    state.runDailySync.mockResolvedValue({ logId: 'log-1', success: true })
    state.runMaxxChat.mockReset()
    state.runMaxxChat.mockResolvedValue({ text: 'answer', toolsUsed: [] })
    state.enforceApiRateLimit.mockReset()
    state.enforceApiRateLimit.mockImplementation(async () => state.rateLimitResponse)
    vi.stubEnv('META_AD_ACCOUNT_ID', 'act_123')
    vi.stubEnv('META_ACCESS_TOKEN', 'meta-token')
    delete process.env.CRON_SECRET
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('daily cron returns 503 and does no work when CRON_SECRET is missing', async () => {
    const { GET } = await import('@/app/api/cron/daily-sync/route')
    const response = await GET(new Request('http://localhost/api/cron/daily-sync', {
      headers: { authorization: 'Bearer undefined' },
    }))

    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ code: 'CRON_SECRET_NOT_CONFIGURED' })
    expect(state.runDailySync).not.toHaveBeenCalled()
    expect(state.adminCalls).toBe(0)
  })

  it('midday never treats Bearer undefined as cron authorization', async () => {
    state.user = null
    const { GET } = await import('@/app/api/sync/midday/route')
    const response = await GET(new Request('http://localhost/api/sync/midday', {
      headers: { authorization: 'Bearer undefined' },
    }))

    expect(response.status).toBe(401)
    expect(state.adminCalls).toBe(0)
  })

  it.each(['POST', 'GET'] as const)('blocks a non-owner from /api/sync %s before service work', async (method) => {
    state.ownerAllowed = false
    const sync = await import('@/app/api/sync/route')
    const response = method === 'POST'
      ? await sync.POST(new Request('http://localhost/api/sync', { method, body: '{}' }))
      : await sync.GET()

    expect(response.status).toBe(403)
    expect(state.runDailySync).not.toHaveBeenCalled()
    expect(state.adminCalls).toBe(0)
  })

  it('blocks a non-owner from Maxx chat before metered or service-role work', async () => {
    state.ownerAllowed = false
    const { POST } = await import('@/app/api/maxx/chat/route')
    const response = await POST(new NextRequest('http://localhost/api/maxx/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hello' }] }),
    }))

    expect(response.status).toBe(403)
    expect(state.runMaxxChat).not.toHaveBeenCalled()
    expect(state.enforceApiRateLimit).not.toHaveBeenCalled()
  })

  it('rejects an oversized cumulative chat history before rate limit or provider work', async () => {
    // DERIVED from the shipped bound, not a literal. The bound was raised from 30,000 (a single
    // governed answer now measures ~14,500 and the transcript is replayed every turn), and a test
    // pinned to the old number would have failed for the wrong reason — or, worse, kept passing
    // while the real cap moved past it.
    //
    // The property under test is unchanged and is what matters: an oversized history is refused
    // BEFORE any metered provider call or rate-limit slot is consumed.
    const { POST, MAXX_CHAT_MESSAGE_BOUNDS } = await import('@/app/api/maxx/chat/route')
    // Built from REPLAYED ANSWERS, which is what actually grows a transcript. Twenty user messages
    // at the 6,000 cap reach 120,000 and can no longer breach the history bound at all — so a
    // user-only payload now trips the 20-message schema limit (400) instead, and would have tested
    // the wrong boundary.
    const perAnswer = MAXX_CHAT_MESSAGE_BOUNDS.assistant
    const answers = Math.ceil(MAXX_CHAT_MESSAGE_BOUNDS.history / perAnswer) + 1
    const messages = [
      ...Array.from({ length: answers }, () => ({ role: 'assistant' as const, content: 'x'.repeat(perAnswer) })),
      { role: 'user' as const, content: 'and then?' },
    ]
    // Still within the schema's message-count and per-message limits, so the 413 can only come from
    // the cumulative bound.
    expect(messages.length).toBeLessThanOrEqual(20)
    const response = await POST(new NextRequest('http://localhost/api/maxx/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages }),
    }))

    expect(response.status).toBe(413)
    expect(await response.json()).toMatchObject({ code: 'CHAT_HISTORY_TOO_LARGE' })
    expect(state.enforceApiRateLimit).not.toHaveBeenCalled()
    expect(state.runMaxxChat).not.toHaveBeenCalled()
  })

  it('rate-limits metered chat by authenticated owner id', async () => {
    state.rateLimitResponse = Response.json(
      { error: 'Too many requests.', code: 'RATE_LIMITED' },
      { status: 429, headers: { 'Retry-After': '600' } },
    )
    const { POST } = await import('@/app/api/maxx/chat/route')
    const response = await POST(new NextRequest('http://localhost/api/maxx/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hello' }] }),
    }))

    expect(response.status).toBe(429)
    expect(state.enforceApiRateLimit).toHaveBeenCalledWith({
      bucket: 'maxx_chat', actorKey: 'owner-id', limit: 10, windowSeconds: 600,
    })
    expect(state.runMaxxChat).not.toHaveBeenCalled()
  })

  it('fails closed without leaking a Maxx provider or tool error', async () => {
    state.runMaxxChat.mockRejectedValueOnce(new Error('Anthropic 401: secret provider detail'))
    const { POST } = await import('@/app/api/maxx/chat/route')
    const response = await POST(new NextRequest('http://localhost/api/maxx/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'How are the ads doing?' }] }),
    }))

    expect(response.status).toBe(503)
    expect(response.headers.get('cache-control')).toContain('no-store')
    expect(await response.json()).toEqual({
      error: 'Maxx could not verify an answer from governed sources.',
      code: 'MAXX_CHAT_UNAVAILABLE',
      availability: 'unavailable',
    })
  })

  it('rejects unknown sync fields and explicit ranges over 90 days before work starts', async () => {
    const { POST } = await import('@/app/api/sync/route')
    const unknown = await POST(new Request('http://localhost/api/sync', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ unexpected: true }),
    }))
    const oversized = await POST(new Request('http://localhost/api/sync', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ date_range_start: '2026-01-01', date_range_end: '2026-04-01' }),
    }))

    expect(unknown.status).toBe(400)
    expect(oversized.status).toBe(400)
    expect(await oversized.json()).toMatchObject({ code: 'SYNC_RANGE_TOO_LARGE' })
    expect(state.runDailySync).not.toHaveBeenCalled()
    expect(state.enforceApiRateLimit).not.toHaveBeenCalled()
  })

  it('rate-limits manual syncs and maps durable overlap to conflict', async () => {
    const { POST } = await import('@/app/api/sync/route')
    state.rateLimitResponse = Response.json(
      { error: 'Too many requests.', code: 'RATE_LIMITED' },
      { status: 429, headers: { 'Retry-After': '300' } },
    )
    const limited = await POST(new Request('http://localhost/api/sync', { method: 'POST', body: '{}' }))
    expect(limited.status).toBe(429)
    expect(state.enforceApiRateLimit).toHaveBeenCalledWith({
      bucket: 'manual_sync', actorKey: 'owner-id', limit: 1, windowSeconds: 300,
    })
    expect(state.runDailySync).not.toHaveBeenCalled()

    state.rateLimitResponse = null
    state.runDailySync.mockResolvedValueOnce({
      logId: '', success: false, error: 'sync_already_running',
    })
    const overlap = await POST(new Request('http://localhost/api/sync', { method: 'POST', body: '{}' }))
    expect(overlap.status).toBe(409)
    expect(await overlap.json()).toMatchObject({ code: 'SYNC_ALREADY_RUNNING' })
  })
})
