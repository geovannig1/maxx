import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { PlanningContextStoreError } from '@/lib/planning-context/store'

const state = vi.hoisted(() => ({
  user: { id: 'owner-id', email: 'owner@example.com' } as { id: string; email: string | null } | null,
  ownerResponse: null as Response | null,
  account: {
    ok: true,
    account: { id: 'account-db-id', accountId: 'act_1', accountName: 'Studio' },
  } as unknown,
  execute: vi.fn(),
  review: vi.fn(),
  rateLimit: null as Response | null,
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: async () => ({ data: { user: state.user } }) },
  })),
}))
vi.mock('@/lib/auth/require-owner', () => ({ ownerOnly: vi.fn(() => state.ownerResponse) }))
vi.mock('@/lib/supabase/admin', () => ({ getAdminClient: () => ({ kind: 'admin' }) }))
vi.mock('@/lib/security/api-rate-limit', () => ({
  enforceApiRateLimit: vi.fn(async () => state.rateLimit),
}))
vi.mock('@/lib/accounts/active-account', () => ({
  resolveOnlyActiveAccount: vi.fn(async () => state.account),
  activeAccountErrorCode: vi.fn((reason: string) => `ACTIVE_ACCOUNT_${reason.toUpperCase()}`),
  activeAccountErrorStatus: vi.fn((reason: string) => reason === 'unavailable' ? 503 : 409),
}))
vi.mock('@/lib/planning-context/store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/planning-context/store')>()
  return { ...actual, executePlanningContextCommand: state.execute }
})
vi.mock('@/lib/planning-context/resolver', () => ({
  readGovernedPlanningContextReviewForAccount: state.review,
}))

const command = {
  action: 'withdraw_business',
  expected_current_approval_id: '00000000-0000-4000-8000-000000000010',
  reason: 'Owner withdrew approval.',
  dedupe_key: 'withdraw-1',
}

function request(body: unknown = command, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest('http://localhost/api/planning-context', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
}

describe('planning-context owner command route', () => {
  beforeEach(() => {
    state.user = { id: 'owner-id', email: 'owner@example.com' }
    state.ownerResponse = null
    state.account = {
      ok: true,
      account: { id: 'account-db-id', accountId: 'act_1', accountName: 'Studio' },
    }
    state.execute.mockReset()
    state.execute.mockResolvedValue({ id: 'decision-1' })
    state.review.mockReset()
    state.review.mockResolvedValue({
      evaluation: {
        status: 'blocked', context_available_for_campaign_plan: false,
        blocker_codes: ['business_context_missing'],
      },
      snapshot: null,
    })
    state.rateLimit = null
  })

  it('rejects an unauthenticated caller before resolving or writing context', async () => {
    state.user = null
    const { POST } = await import('@/app/api/planning-context/route')
    const response = await POST(request())

    expect(response.status).toBe(401)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(state.execute).not.toHaveBeenCalled()
  })

  it('reads only the exact requested URL and marks owner context private/no-store', async () => {
    const { GET } = await import('@/app/api/planning-context/route')
    const response = await GET(new Request(
      `http://localhost/api/planning-context?landing_page_url=${encodeURIComponent('HTTPS://Example.Test:443/book/#review')}`,
    ))

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(state.review).toHaveBeenCalledWith(
      { kind: 'admin' }, 'account-db-id', 'https://example.test/book/',
    )
    expect(await response.json()).toMatchObject({
      authority: 'context_only', campaign_settings_authorized: false, meta_write_performed: false,
    })
  })

  it('rate-limits repeated owner reads before resolving private context', async () => {
    state.rateLimit = Response.json({ error: 'Too many requests.' }, { status: 429 })
    const { GET } = await import('@/app/api/planning-context/route')
    const response = await GET(new Request('http://localhost/api/planning-context'))

    expect(response.status).toBe(429)
    expect(state.review).not.toHaveBeenCalled()
  })

  it('rejects a landing-page identity over 2048 canonical UTF-8 bytes before resolving context', async () => {
    const { GET } = await import('@/app/api/planning-context/route')
    const response = await GET(new Request(
      `http://localhost/api/planning-context?landing_page_url=${encodeURIComponent(`https://example.test/${'é'.repeat(400)}`)}`,
    ))

    expect(response.status).toBe(400)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(state.review).not.toHaveBeenCalled()
  })

  it('rejects an invalid landing-page identity before resolving context', async () => {
    const { GET } = await import('@/app/api/planning-context/route')
    const response = await GET(new Request(
      `http://localhost/api/planning-context?landing_page_url=${encodeURIComponent('javascript:alert(1)')}`,
    ))

    expect(response.status).toBe(400)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(state.review).not.toHaveBeenCalled()
  })

  it('rejects caller-supplied account or actor fields', async () => {
    const { POST } = await import('@/app/api/planning-context/route')
    const response = await POST(request({ ...command, ad_account_id: 'attacker-account', actor: 'attacker' }))

    expect(response.status).toBe(400)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(state.execute).not.toHaveBeenCalled()
  })

  it('rejects non-JSON and cross-origin mutation requests before parsing', async () => {
    const { POST } = await import('@/app/api/planning-context/route')
    const wrongType = await POST(request(command, { 'content-type': 'text/plain' }))
    expect(wrongType.status).toBe(415)

    const crossOrigin = await POST(request(command, { origin: 'https://attacker.example' }))
    expect(crossOrigin.status).toBe(403)
    expect(state.execute).not.toHaveBeenCalled()
  })

  it('rejects a non-HTTP page-withdrawal identity as invalid input', async () => {
    const { POST } = await import('@/app/api/planning-context/route')
    const response = await POST(request({
      action: 'withdraw_page',
      canonical_url: 'javascript:alert(1)',
      expected_current_approval_id: '00000000-0000-4000-8000-000000000010',
      reason: 'Owner withdrew approval.',
      dedupe_key: 'withdraw-page-invalid-url',
    }))

    expect(response.status).toBe(400)
    expect(state.execute).not.toHaveBeenCalled()
  })

  it('derives the active account and approval actor server-side', async () => {
    const { POST } = await import('@/app/api/planning-context/route')
    const response = await POST(request())

    expect(response.status).toBe(200)
    expect(state.execute).toHaveBeenCalledWith(
      { kind: 'admin' },
      'account-db-id',
      'owner@example.com',
      command,
    )
  })

  it('fails closed when active account ownership is ambiguous', async () => {
    state.account = { ok: false, reason: 'ambiguous' }
    const { POST } = await import('@/app/api/planning-context/route')
    const response = await POST(request())

    expect(response.status).toBe(409)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(await response.json()).toMatchObject({ code: 'ACTIVE_ACCOUNT_AMBIGUOUS' })
    expect(state.execute).not.toHaveBeenCalled()
  })

  it('maps governed command conflicts without exposing an unhandled error', async () => {
    state.execute.mockRejectedValue(new PlanningContextStoreError(
      'CONTEXT_STALE_HEAD', 409, 'The approval head changed.',
    ))
    const { POST } = await import('@/app/api/planning-context/route')
    const response = await POST(request())

    expect(response.status).toBe(409)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(await response.json()).toEqual({
      error: 'Governed planning-context command was rejected.',
      code: 'CONTEXT_STALE_HEAD',
    })
  })

  it('rejects an oversized declared payload before parsing it', async () => {
    const { POST } = await import('@/app/api/planning-context/route')
    const response = await POST(request(command, { 'content-length': '200000' }))

    expect(response.status).toBe(413)
    expect(state.execute).not.toHaveBeenCalled()
  })

  it('cancels an undeclared oversized stream without buffering the remaining body', async () => {
    let pulls = 0
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1
        if (pulls === 1) controller.enqueue(new Uint8Array(129 * 1024))
        else controller.close()
      },
      cancel() { cancelled = true },
    }, { highWaterMark: 0 })
    const streamed = new Request('http://localhost/api/planning-context', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      duplex: 'half',
    } as RequestInit & { duplex: 'half' })

    const { POST } = await import('@/app/api/planning-context/route')
    const response = await POST(streamed)

    expect(response.status).toBe(413)
    expect(cancelled).toBe(true)
    expect(state.execute).not.toHaveBeenCalled()
  })
})
