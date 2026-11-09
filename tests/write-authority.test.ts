import { describe, expect, it } from 'vitest'
import {
  expectedMutation,
  validateWriteAuthority,
  type GovernedWriteRequest,
  type WriteAuthorityDecision,
} from '@/lib/writes/write-authority'
import { ACTION_DECISION_POLICY_FLOOR } from '@/lib/authority/legacy-cutover'

const request: GovernedWriteRequest = {
  adAccountDbId: 'acct-1',
  actionType: 'adjust_budget',
  entityLevel: 'adset',
  metaEntityId: 'adset-1',
  params: { new_daily_budget_usd: 60 },
}

const decision: WriteAuthorityDecision = {
  id: 'decision-1',
  ad_account_id: 'acct-1',
  action_kind: 'budget_scale',
  target_level: 'adset',
  target_id: 'adset-1',
  authority_tier: 'execution_eligible',
  policy_version: ACTION_DECISION_POLICY_FLOOR,
  approval_state: 'not_requested',
  proposed_mutation: expectedMutation(request),
  causal_contribution_estimate_id: 'estimate-1',
}

describe('write authority — one immutable decision controls proposal and execution', () => {
  it('allows an exact proposal and the same decision after governed approval', () => {
    expect(validateWriteAuthority(decision, request, 'not_requested').allowed).toBe(true)
    expect(validateWriteAuthority({ ...decision, approval_state: 'approved' }, request, 'approved').allowed).toBe(true)
  })

  it.each([
    ['missing decision', null],
    ['wrong account', { ...decision, ad_account_id: 'other' }],
    ['legacy policy', { ...decision, policy_version: 0 }],
    ['missing causal-estimate lineage', { ...decision, causal_contribution_estimate_id: null }],
    ['diagnostic tier', { ...decision, authority_tier: 'diagnostic_only' as const }],
    ['wrong target', { ...decision, target_id: 'adset-2' }],
    ['wrong kind', { ...decision, action_kind: 'pause' as const }],
    ['wrong mutation', { ...decision, proposed_mutation: { action_type: 'adjust_budget', new_daily_budget_usd: 61 } }],
  ])('blocks %s', (_name, candidate) => {
    expect(validateWriteAuthority(candidate, request, 'not_requested').allowed).toBe(false)
  })

  it('blocks extra request parameters even when the approved fields match', () => {
    const withExtra = { ...request, params: { new_daily_budget_usd: 60, ungoverned: true } }
    expect(validateWriteAuthority(decision, withExtra, 'not_requested')).toMatchObject({
      allowed: false,
      reason: expect.stringContaining('ungoverned'),
    })
  })

  it('does not treat owner_review as executable merely because the owner approved elsewhere', () => {
    const ownerReview = { ...decision, authority_tier: 'owner_review' as const, approval_state: 'approved' as const }
    expect(validateWriteAuthority(ownerReview, request, 'approved').allowed).toBe(false)
  })
})
