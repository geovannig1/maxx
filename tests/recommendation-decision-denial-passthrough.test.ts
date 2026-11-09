import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

/**
 * The decision route shows the owner the governance guard's own explanation when the database refuses
 * a transition, and nothing else from the database. The guard's messages are a fixed list authored in
 * commit_recommendation_owner_transition (baseline migration); any other error text — including a
 * database error that merely CONTAINS a guard phrase — is a server-side detail and must be redacted.
 */

const GUARD_MESSAGES = [
  'invalid recommendation owner transition',
  'recommendation is missing or cross-account',
  'recommendation owner transition does not match its immutable recommendation',
  'immutable MetricClaim lineage is required for this owner transition',
  'governed ActionDecision is required for this owner transition',
  'diagnostic recommendation cannot be marked acted on',
]

const state = vi.hoisted(() => ({ failure: null as Error | null }))

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({ auth: { getUser: async () => ({ data: { user: { id: 'owner', email: 'owner@example.com' } } }) } })),
}))
vi.mock('@/lib/auth/require-owner', () => ({ ownerOnly: vi.fn(() => null) }))
vi.mock('@/lib/authority/action-decision-store', () => ({
  commitRecommendationOwnerTransition: vi.fn(async () => {
    if (state.failure) throw state.failure
    return { user_decision: 'accepted', action_taken: false, decision_date: '2026-07-29T00:00:00Z' }
  }),
}))
vi.mock('@/lib/supabase/admin', () => ({
  getAdminClient: () => ({
    from: (table: string) => {
      const chain: Record<string, unknown> = {}
      chain.select = () => chain
      chain.eq = () => chain
      chain.limit = () => chain
      chain.then = (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
        Promise.resolve({ data: [{ id: 'acct-1', account_id: 'act_100000000000071', account_name: 'Account 1' }], error: null })
          .then(resolve, reject)
      chain.maybeSingle = async () => ({
        data: table === 'recommendations'
          ? { id: 'rec-1', ad_account_id: 'acct-1', target_entity_id: 'ad-1', recommendation_type: 'pause' }
          : null,
        error: null,
      })
      return chain
    },
  }),
}))

async function patch() {
  const { PATCH } = await import('@/app/api/recommendations/[id]/decision/route')
  const req = new NextRequest('http://localhost/api/recommendations/rec-1/decision', {
    method: 'PATCH', body: JSON.stringify({ user_decision: 'acted_on' }),
    headers: { 'content-type': 'application/json' },
  })
  const res = await PATCH(req, { params: Promise.resolve({ id: 'rec-1' }) })
  return { status: res.status, body: await res.json() as { error: string; code: string } }
}

beforeEach(() => {
  state.failure = null
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

describe('recommendation decision denial passthrough', () => {
  it.each(GUARD_MESSAGES)('passes the guard message through as written: %s', async (message) => {
    state.failure = new Error(`commit_recommendation_owner_transition: ${message}`)
    expect(await patch()).toEqual({ status: 409, body: { error: message, code: 'RECOMMENDATION_TRANSITION_DENIED' } })
  })

  it('passes an unwrapped guard message through as well', async () => {
    state.failure = new Error('diagnostic recommendation cannot be marked acted on')
    expect((await patch()).status).toBe(409)
  })

  it.each([
    ['extra text after a guard phrase', 'commit_recommendation_owner_transition: diagnostic recommendation cannot be marked acted on; detail: relation "recommendation_decisions" row 42'],
    ['a database error that quotes a guard phrase', 'commit_recommendation_owner_transition: duplicate key value violates unique constraint "rd_pkey" (cross-account)'],
    ['a guard phrase inside a longer database message', 'commit_recommendation_owner_transition: could not serialize access: governed ActionDecision is required for this owner transition (table action_decisions)'],
    ['a guard message under an unknown wrapper', 'some_other_rpc: immutable MetricClaim lineage is required for this owner transition'],
    ['a guard message in a different case', 'commit_recommendation_owner_transition: DIAGNOSTIC RECOMMENDATION CANNOT BE MARKED ACTED ON'],
  ])('redacts %s', async (_label, message) => {
    state.failure = new Error(message)
    const { status, body } = await patch()
    expect(status).toBe(500)
    expect(body.code).toBe('RECOMMENDATION_TRANSITION_FAILED')
    expect(JSON.stringify(body)).not.toMatch(/recommendation_decisions|rd_pkey|action_decisions|row 42|some_other_rpc|MetricClaim|DIAGNOSTIC/)
  })
})
