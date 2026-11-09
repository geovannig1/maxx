import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const state = vi.hoisted(() => ({
  tier: 'diagnostic_only' as 'diagnostic_only' | 'owner_review',
  metricClaimIds: ['claim:rec-1'] as string[],
  hasActionDecision: true,
  forceReject: false,
  upsert: vi.fn(),
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({ auth: { getUser: async () => ({ data: { user: { id: 'owner', email: 'owner@example.com' } } }) } })),
}))
vi.mock('@/lib/auth/require-owner', () => ({ ownerOnly: vi.fn(() => null) }))
vi.mock('@/lib/authority/action-decision-store', () => ({
  readActionDecisionsBySource: vi.fn(async () => state.hasActionDecision
    ? new Map([['rec-1', { id: 'decision-1', authority_tier: state.tier }]])
    : new Map()),
  commitRecommendationOwnerTransition: vi.fn(async (commit: { actionTaken: boolean; userDecision: string }) => {
    if (state.metricClaimIds.length === 0) throw new Error('immutable MetricClaim lineage is required for this owner transition')
    if (!state.hasActionDecision) throw new Error('governed ActionDecision is required for this owner transition')
    if (state.forceReject) throw new Error('diagnostic recommendation cannot be marked acted on')
    state.upsert()
    return { user_decision: 'accepted', action_taken: commit.actionTaken, decision_date: '2026-07-29T00:00:00Z' }
  }),
}))
vi.mock('@/lib/supabase/admin', () => ({
  getAdminClient: () => ({
    from: (table: string) => {
      if (table === 'ad_accounts') {
        const chain: Record<string, unknown> = {}
        chain.select = () => chain
        chain.eq = () => chain
        chain.limit = () => chain
        chain.then = (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
          Promise.resolve({
            data: [{ id: 'acct-1', account_id: 'act_100000000000071', account_name: 'Account 1' }],
            error: null,
          }).then(resolve, reject)
        return chain
      }
      if (table === 'recommendations') {
        const chain: Record<string, unknown> = {}
        chain.select = () => chain
        chain.eq = () => chain
        chain.maybeSingle = async () => ({
          data: {
            id: 'rec-1', ad_account_id: 'acct-1', target_entity_id: 'ad-1', recommendation_type: 'pause',
            learning_eligibility: true, metric_claim_ids: state.metricClaimIds,
          },
          error: null,
        })
        return chain
      }
      return {
        upsert: (...args: unknown[]) => {
          state.upsert(...args)
          return { select: () => ({ single: async () => ({ data: { decision_date: '2026-07-29T00:00:00Z', action_taken: true }, error: null }) }) }
        },
      }
    },
  }),
}))

describe('recommendation decision API respects durable action authority', () => {
  beforeEach(() => {
    state.tier = 'diagnostic_only'
    state.metricClaimIds = ['claim:rec-1']
    state.hasActionDecision = true
    state.forceReject = false
    state.upsert.mockClear()
  })

  it('rejects marking a diagnostic recommendation acted on', async () => {
    state.forceReject = true
    const { PATCH } = await import('@/app/api/recommendations/[id]/decision/route')
    const req = new NextRequest('http://localhost/api/recommendations/rec-1/decision', {
      method: 'PATCH', body: JSON.stringify({ user_decision: 'acted_on' }),
      headers: { 'content-type': 'application/json' },
    })
    const res = await PATCH(req, { params: Promise.resolve({ id: 'rec-1' }) })
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual(expect.objectContaining({ error: expect.stringMatching(/diagnostic recommendation/) }))
    expect(state.upsert).not.toHaveBeenCalled()
  })

  it('allows an owner to record an external action on an owner-review decision', async () => {
    state.tier = 'owner_review'
    const { PATCH } = await import('@/app/api/recommendations/[id]/decision/route')
    const req = new NextRequest('http://localhost/api/recommendations/rec-1/decision', {
      method: 'PATCH', body: JSON.stringify({ user_decision: 'acted_on' }),
      headers: { 'content-type': 'application/json' },
    })
    const res = await PATCH(req, { params: Promise.resolve({ id: 'rec-1' }) })
    expect(res.status).toBe(200)
    expect(state.upsert).toHaveBeenCalledOnce()
  })

  it.each(['accepted', 'snoozed', 'acted_on'] as const)(
    'quarantines a %s owner transition when immutable claim lineage is absent',
    async (user_decision) => {
      state.tier = 'owner_review'
      state.metricClaimIds = []
      const { PATCH } = await import('@/app/api/recommendations/[id]/decision/route')
      const req = new NextRequest('http://localhost/api/recommendations/rec-1/decision', {
        method: 'PATCH', body: JSON.stringify({ user_decision }),
        headers: { 'content-type': 'application/json' },
      })

      const res = await PATCH(req, { params: Promise.resolve({ id: 'rec-1' }) })

      expect(res.status).toBe(409)
      expect(await res.json()).toEqual(expect.objectContaining({ error: expect.stringMatching(/immutable metricclaim.*lineage/i) }))
      expect(state.upsert).not.toHaveBeenCalled()
    },
  )

  it('quarantines acceptance when the durable ActionDecision is missing', async () => {
    state.tier = 'owner_review'
    state.hasActionDecision = false
    const { PATCH } = await import('@/app/api/recommendations/[id]/decision/route')
    const req = new NextRequest('http://localhost/api/recommendations/rec-1/decision', {
      method: 'PATCH', body: JSON.stringify({ user_decision: 'accepted' }),
      headers: { 'content-type': 'application/json' },
    })

    const res = await PATCH(req, { params: Promise.resolve({ id: 'rec-1' }) })

    expect(res.status).toBe(409)
    expect(await res.json()).toEqual(expect.objectContaining({ error: expect.stringMatching(/ActionDecision/i) }))
    expect(state.upsert).not.toHaveBeenCalled()
  })
})
