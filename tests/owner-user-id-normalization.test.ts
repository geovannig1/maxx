import { afterEach, describe, expect, it, vi } from 'vitest'

// Security review L6: OWNER_USER_ID is compared to the signed-in owner's id case-insensitively and
// trimmed, exactly as the owner gate (ownerGate) compares it, at every service entry that pins it.

const OWNER = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'

// A database that holds nothing: past the owner check, every service answers NOT_FOUND-style.
const empty = () => {
  const b: Record<string, unknown> = {}
  for (const op of ['select', 'eq', 'is', 'gt', 'gte', 'in', 'order', 'limit', 'not']) b[op] = () => b
  b.maybeSingle = async () => ({ data: null, error: null })
  b.single = async () => ({ data: null, error: null })
  b.then = (resolve: (r: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(resolve)
  return { from: () => b, rpc: async () => ({ data: null, error: { message: 'unexpected rpc' } }) }
}
vi.mock('@/lib/supabase/admin', () => ({ getAdminClient: () => empty() }))
vi.mock('@/lib/accounts/active-account', () => ({ resolveOnlyActiveAccount: async () => ({ ok: true, account: { id: 'account-a' } }) }))

const { proposeOwnerChange, proposeRollback } = await import('@/lib/writes/owner-changes')
const { editPlanVersion } = await import('@/lib/campaigns/plan-repository')
const { submitPlanForApproval } = await import('@/lib/campaigns/plan-submission')

afterEach(() => { delete process.env.OWNER_USER_ID })

describe('OWNER_USER_ID pin is case-insensitive (security review L6)', () => {
  for (const pinned of [OWNER.toUpperCase(), ` ${OWNER} `]) {
    it(`accepts the owner when the pin is written as ${JSON.stringify(pinned)}`, async () => {
      process.env.OWNER_USER_ID = pinned
      expect((await proposeOwnerChange({ decisionId: 'd-1', ownerUserId: OWNER, accountId: 'account-a' })).status).not.toBe('NOT_OWNER')
      expect((await proposeRollback({ changeRequestId: 'c-1', ownerUserId: OWNER, accountId: 'account-a' })).status).not.toBe('NOT_OWNER')
      expect((await editPlanVersion({ planId: 'p-1', ownerUserId: OWNER, spec: {} })).body.code).not.toBe('NOT_OWNER')
      expect((await submitPlanForApproval({ versionId: 'v-1', ownerUserId: OWNER.toUpperCase() })).body.code).not.toBe('NOT_OWNER')
    })
  }

  it('still refuses a different user (control)', async () => {
    process.env.OWNER_USER_ID = OWNER.toUpperCase()
    const other = '00000000-0000-4000-8000-000000000000'
    expect((await proposeOwnerChange({ decisionId: 'd-1', ownerUserId: other, accountId: 'account-a' })).status).toBe('NOT_OWNER')
    expect((await submitPlanForApproval({ versionId: 'v-1', ownerUserId: other })).body.code).toBe('NOT_OWNER')
  })
})
