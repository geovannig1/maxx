import fs from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  rpc: vi.fn(),
}))

vi.mock('@/lib/supabase/admin', () => ({
  getAdminClient: () => ({ rpc: state.rpc }),
}))

describe('cron bearer authorization', () => {
  it('treats missing, empty, and whitespace-only secrets as server misconfiguration', async () => {
    const { checkCronAuthorization } = await import('@/lib/auth/cron-secret')

    expect(checkCronAuthorization(null, undefined)).toBe('misconfigured')
    expect(checkCronAuthorization('Bearer undefined', undefined)).toBe('misconfigured')
    expect(checkCronAuthorization('Bearer anything', '')).toBe('misconfigured')
    expect(checkCronAuthorization('Bearer anything', '   ')).toBe('misconfigured')
  })

  it('accepts only an exact Bearer token when a nonempty secret is configured', async () => {
    const { checkCronAuthorization } = await import('@/lib/auth/cron-secret')

    expect(checkCronAuthorization(null, 'cron-secret-fixture-at-least-32-bytes-long')).toBe('unauthorized')
    expect(checkCronAuthorization('cron-secret-fixture-at-least-32-bytes-long', 'cron-secret-fixture-at-least-32-bytes-long')).toBe('unauthorized')
    expect(checkCronAuthorization('Bearer wrong', 'cron-secret-fixture-at-least-32-bytes-long')).toBe('unauthorized')
    expect(checkCronAuthorization('Bearer cron-secret ', 'cron-secret-fixture-at-least-32-bytes-long')).toBe('unauthorized')
    expect(checkCronAuthorization('Bearer cron-secret-fixture-at-least-32-bytes-long', 'cron-secret-fixture-at-least-32-bytes-long')).toBe('authorized')
  })

  it('uses a timing-safe comparison for configured secret material', () => {
    const source = fs.readFileSync('src/lib/auth/cron-secret.ts', 'utf8')
    expect(source).toContain('timingSafeEqual')
  })
})

describe('durable API rate-limit boundary', () => {
  beforeEach(() => {
    state.rpc.mockReset()
  })

  it('allows a request when the database window has capacity', async () => {
    state.rpc.mockResolvedValue({
      data: [{ allowed: true, retry_after_seconds: 0 }],
      error: null,
    })
    const { enforceApiRateLimit } = await import('@/lib/security/api-rate-limit')

    const response = await enforceApiRateLimit({
      bucket: 'maxx_chat',
      actorKey: 'owner-id',
      limit: 10,
      windowSeconds: 600,
    })

    expect(response).toBeNull()
    expect(state.rpc).toHaveBeenCalledWith('consume_api_rate_limit', {
      p_actor_key: 'owner-id',
      p_bucket: 'maxx_chat',
      p_limit: 10,
      p_window_seconds: 600,
    })
  })

  it('returns 429 and Retry-After when the durable window is exhausted', async () => {
    state.rpc.mockResolvedValue({
      data: [{ allowed: false, retry_after_seconds: 287 }],
      error: null,
    })
    const { enforceApiRateLimit } = await import('@/lib/security/api-rate-limit')

    const response = await enforceApiRateLimit({
      bucket: 'manual_sync',
      actorKey: 'owner-id',
      limit: 1,
      windowSeconds: 300,
    })

    expect(response?.status).toBe(429)
    expect(response?.headers.get('Retry-After')).toBe('287')
    expect(await response?.json()).toMatchObject({ code: 'RATE_LIMITED' })
  })

  it('fails closed when the durable limiter is unavailable or malformed', async () => {
    const { enforceApiRateLimit } = await import('@/lib/security/api-rate-limit')

    state.rpc.mockResolvedValueOnce({ data: null, error: { message: 'db unavailable' } })
    const unavailable = await enforceApiRateLimit({
      bucket: 'maxx_chat', actorKey: 'owner-id', limit: 10, windowSeconds: 600,
    })
    expect(unavailable?.status).toBe(503)
    expect(await unavailable?.json()).toMatchObject({ code: 'RATE_LIMIT_UNAVAILABLE' })

    state.rpc.mockResolvedValueOnce({ data: [], error: null })
    const malformed = await enforceApiRateLimit({
      bucket: 'maxx_chat', actorKey: 'owner-id', limit: 10, windowSeconds: 600,
    })
    expect(malformed?.status).toBe(503)
  })
})
