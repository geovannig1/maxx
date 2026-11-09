import { describe, it, expect, afterEach, vi } from 'vitest'
import { ownerGate } from '@/lib/auth/owner'

const confirmed = (email: string) => ({ email, email_confirmed_at: '2026-01-01T00:00:00Z' })

afterEach(() => vi.unstubAllEnvs())

// the owner gate must fail CLOSED in production when OWNER_EMAIL is unset.
describe('owner gate fails closed in production', () => {
  it('allows the configured owner', () => {
    vi.stubEnv('OWNER_EMAIL', 'owner@example.test')
    expect(ownerGate(confirmed('owner@example.test'))).toEqual({ allowed: true, reason: 'ok' })
  })

  it('denies a non-owner when OWNER_EMAIL is set', () => {
    vi.stubEnv('OWNER_EMAIL', 'owner@example.test')
    expect(ownerGate(confirmed('intruder@evil.com'))).toEqual({ allowed: false, reason: 'not_owner' })
  })

  it('DENIES everyone in production when OWNER_EMAIL is unset (fail closed)', () => {
    vi.stubEnv('OWNER_EMAIL', '')
    vi.stubEnv('VERCEL_ENV', 'production')
    expect(ownerGate(confirmed('anyone@whatever.com'))).toEqual({ allowed: false, reason: 'unconfigured' })
  })

  it('DENIES everyone in dev too when OWNER_EMAIL is unset (a dev server can be reachable)', () => {
    vi.stubEnv('OWNER_EMAIL', '')
    vi.stubEnv('VERCEL_ENV', '')
    vi.stubEnv('NODE_ENV', 'development')
    expect(ownerGate(confirmed('dev@local'))).toEqual({ allowed: false, reason: 'unconfigured' })
    // Control: with OWNER_EMAIL set, dev admits that confirmed owner.
    vi.stubEnv('OWNER_EMAIL', 'dev@local')
    expect(ownerGate(confirmed('dev@local')).allowed).toBe(true)
  })
})
