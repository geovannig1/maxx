import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// optional OWNER_USER_ID pins the owner to one Supabase user id. An email match plus a confirmed
// email still lets in a second account that holds the owner address (a deleted and re-created user,
// or a squatter on a project that auto-confirms). With the id pinned, production also requires
// user.id to equal it.
const CONFIRMED = '2026-01-01T00:00:00Z'
const OWNER_ID = '11111111-2222-4333-8444-555555555555'
const OTHER_ID = '99999999-2222-4333-8444-555555555555'
const owner = (id: string | null | undefined) => ({ id, email: 'owner@example.test', email_confirmed_at: CONFIRMED })

beforeEach(() => {
  vi.resetModules()
  vi.stubEnv('OWNER_EMAIL', 'owner@example.test')
  vi.stubEnv('NODE_ENV', 'production')
  vi.stubEnv('VERCEL_ENV', '')
})
afterEach(() => vi.unstubAllEnvs())

describe('ownerGate with OWNER_USER_ID pinned', () => {
  it('denies a confirmed owner-email user whose id does not match, in production', async () => {
    vi.stubEnv('OWNER_USER_ID', OWNER_ID)
    const { ownerGate } = await import('@/lib/auth/owner')
    expect(ownerGate(owner(OTHER_ID))).toEqual({ allowed: false, reason: 'not_owner' })
    expect(ownerGate(owner(null))).toEqual({ allowed: false, reason: 'not_owner' })
    expect(ownerGate(owner(undefined))).toEqual({ allowed: false, reason: 'not_owner' })
  })

  it('allows the confirmed owner whose id matches (control), ignoring case', async () => {
    vi.stubEnv('OWNER_USER_ID', OWNER_ID.toUpperCase())
    const { ownerGate } = await import('@/lib/auth/owner')
    expect(ownerGate(owner(OWNER_ID))).toEqual({ allowed: true, reason: 'ok' })
  })

  it('a matching id never bypasses the email or confirmation checks', async () => {
    vi.stubEnv('OWNER_USER_ID', OWNER_ID)
    const { ownerGate } = await import('@/lib/auth/owner')
    expect(ownerGate({ id: OWNER_ID, email: 'intruder@example.test', email_confirmed_at: CONFIRMED }).allowed).toBe(false)
    expect(ownerGate({ id: OWNER_ID, email: 'owner@example.test' }).allowed).toBe(false)
  })

  it('fails closed in production when OWNER_USER_ID is set but is not a uuid', async () => {
    vi.stubEnv('OWNER_USER_ID', 'not-a-uuid')
    const { ownerGate } = await import('@/lib/auth/owner')
    expect(ownerGate(owner(OWNER_ID))).toEqual({ allowed: false, reason: 'unconfigured' })
  })

  it('unset OWNER_USER_ID keeps the email-only behaviour (control)', async () => {
    vi.stubEnv('OWNER_USER_ID', '')
    const { ownerGate } = await import('@/lib/auth/owner')
    expect(ownerGate(owner(OTHER_ID))).toEqual({ allowed: true, reason: 'ok' })
  })

  it('outside production a mismatched id is not enforced (local stacks mint new ids)', async () => {
    vi.stubEnv('NODE_ENV', 'development')
    vi.stubEnv('OWNER_USER_ID', OWNER_ID)
    const { ownerGate } = await import('@/lib/auth/owner')
    expect(ownerGate(owner(OTHER_ID))).toEqual({ allowed: true, reason: 'ok' })
  })

  it('ownerOnly answers 403 for a mismatched id and passes the pinned owner', async () => {
    vi.stubEnv('OWNER_USER_ID', OWNER_ID)
    const { ownerOnly } = await import('@/lib/auth/require-owner')
    expect(ownerOnly(owner(OTHER_ID))?.status).toBe(403)
    expect(ownerOnly(owner(OWNER_ID))).toBeNull()
  })
})
