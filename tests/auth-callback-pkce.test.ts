import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const authState = vi.hoisted(() => ({
  error: null as { code?: string; status?: number } | null,
  exchange: vi.fn(),
}))

vi.mock('next/headers', () => ({
  cookies: async () => ({
    getAll: () => [],
    set: vi.fn(),
  }),
}))

vi.mock('@supabase/ssr', () => ({
  createServerClient: () => ({
    auth: {
      exchangeCodeForSession: authState.exchange,
    },
  }),
}))

describe('magic-link callback PKCE flow binding', () => {
  beforeEach(() => {
    vi.resetModules()
    authState.error = null
    authState.exchange.mockReset()
    authState.exchange.mockResolvedValue({ error: null })
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co'
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon-key'
  })

  it('exchanges a callback with its matching PKCE flow ID', async () => {
    const { GET } = await import('@/app/auth/callback/route')
    const response = await GET(new NextRequest(
      'https://preview.example/auth/callback?code=one-time-code&sb_flow_id=flow-123&next=%2Fdashboard%3Frange%3Dmtd'
    ))

    expect(authState.exchange).toHaveBeenCalledWith('one-time-code', { flowId: 'flow-123' })
    expect(response.headers.get('location')).toBe('https://preview.example/dashboard?range=mtd')
  })

  it('keeps legacy callbacks working when Supabase supplies no flow ID', async () => {
    const { GET } = await import('@/app/auth/callback/route')
    await GET(new NextRequest('https://preview.example/auth/callback?code=one-time-code'))

    expect(authState.exchange).toHaveBeenCalledWith('one-time-code', undefined)
  })

  it('returns the generic failure page while logging only bounded error metadata', async () => {
    authState.exchange.mockResolvedValue({ error: { code: 'flow_state_not_found', status: 400 } })
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { GET } = await import('@/app/auth/callback/route')
    const response = await GET(new NextRequest(
      'https://preview.example/auth/callback?code=one-time-code&sb_flow_id=flow-123'
    ))

    expect(response.headers.get('location')).toBe('https://preview.example/login?error=auth')
    expect(errorSpy).toHaveBeenCalledWith('supabase_auth_code_exchange_failed', {
      code: 'flow_state_not_found',
      status: 400,
      hasFlowId: true,
    })
  })
})
