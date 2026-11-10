import { describe, expect, it } from 'vitest'
import { ACTION_DECISION_POLICY_FLOOR } from '@/lib/authority/legacy-cutover'
import {
  actionTypeForDecision,
  budgetStepPercent,
  maxBudgetChangePercent,
  normalizeOwnerParams,
  ownerChangePreview,
  ownerProposalEligibility,
  rollbackFor,
  simulatedAfterState,
  validateOwnerWriteAuthority,
  type OwnerDecision,
} from '@/lib/writes/owner-change-policy'

// ADR-059. Who initiated a change decides which evidence bar applies; every hard guard stays.

const NOW = Date.parse('2026-11-08T15:00:00Z')
const decision = (overrides: Partial<OwnerDecision> = {}): OwnerDecision => ({
  id: 'decision-1', ad_account_id: 'account-a', action_kind: 'budget_scale', target_level: 'adset',
  target_id: 'adset-1', authority_tier: 'owner_review', policy_version: ACTION_DECISION_POLICY_FLOOR,
  approval_state: 'not_requested', proposed_mutation: null, causal_contribution_estimate_id: null,
  evaluated_at: '2026-11-07T10:00:00Z',
  ...overrides,
})

describe('which decisions the owner may propose', () => {
  it('maps exactly the executor-supported kinds on their matching level', () => {
    expect(actionTypeForDecision('pause', 'ad')).toBe('pause_ad')
    expect(actionTypeForDecision('activate', 'ad')).toBe('activate_ad')
    expect(actionTypeForDecision('budget_scale', 'adset')).toBe('adjust_budget')
    expect(actionTypeForDecision('budget_cut', 'adset')).toBe('adjust_budget')
    expect(actionTypeForDecision('structural', 'adset')).toBe('duplicate_adset')
    // Controls: unsupported kind or level.
    expect(actionTypeForDecision('budget_scale', 'campaign')).toBeNull()
    expect(actionTypeForDecision('pause', 'adset')).toBeNull()
    expect(actionTypeForDecision('creative_refresh', 'ad')).toBeNull()
    expect(actionTypeForDecision('observe', 'account')).toBeNull()
  })

  it('accepts a current owner_review or execution_eligible decision', () => {
    expect(ownerProposalEligibility(decision(), { now: NOW, newerDecisionExists: false })).toEqual({ ok: true, actionType: 'adjust_budget' })
    expect(ownerProposalEligibility(decision({ authority_tier: 'execution_eligible' }), { now: NOW, newerDecisionExists: false }).ok).toBe(true)
  })

  it.each([
    ['diagnostic only', decision({ authority_tier: 'diagnostic_only' }), false, 'DIAGNOSTIC_ONLY'],
    ['below the policy floor', decision({ policy_version: ACTION_DECISION_POLICY_FLOOR - 1 }), false, 'STALE_DECISION'],
    ['older than 7 days', decision({ evaluated_at: '2026-10-30T10:00:00Z' }), false, 'STALE_DECISION'],
    ['superseded by a newer decision', decision(), true, 'STALE_DECISION'],
    ['an unsupported mutation', decision({ action_kind: 'creative_refresh', target_level: 'ad' }), false, 'UNSUPPORTED_MUTATION'],
    ['already approved', decision({ approval_state: 'approved' }), false, 'ALREADY_DECIDED'],
    ['already rejected', decision({ approval_state: 'rejected' }), false, 'ALREADY_DECIDED'],
  ] as const)('refuses a decision that is %s', (_label, row, newer, code) => {
    expect(ownerProposalEligibility(row, { now: NOW, newerDecisionExists: newer })).toMatchObject({ ok: false, code })
  })
})

describe('owner parameters', () => {
  it('builds the exact governed params for each action', () => {
    expect(normalizeOwnerParams('pause_ad', decision({ action_kind: 'pause' }), { anything: 1 })).toEqual({ ok: true, params: {} })
    expect(normalizeOwnerParams('adjust_budget', decision(), { new_daily_budget: '52.004' })).toEqual({ ok: true, params: { new_daily_budget: 52 } })
    expect(normalizeOwnerParams('duplicate_adset', decision({ action_kind: 'structural' }), { new_name: '  Copy  ' }))
      .toEqual({ ok: true, params: { new_name: 'Copy', new_daily_budget: null } })
  })

  it('keeps the deprecated budget key a decision was authorised under', () => {
    const legacy = decision({ proposed_mutation: { action_type: 'adjust_budget', new_daily_budget_usd: 40 } })
    expect(normalizeOwnerParams('adjust_budget', legacy, { new_daily_budget: 40 })).toEqual({ ok: true, params: { new_daily_budget_usd: 40 } })
  })

  it.each([
    ['a missing budget', 'adjust_budget', {}],
    ['a non-numeric budget', 'adjust_budget', { new_daily_budget: 'lots' }],
    ['a zero budget', 'adjust_budget', { new_daily_budget: 0 }],
    ['a blank duplicate name', 'duplicate_adset', { new_name: '  ' }],
  ] as const)('refuses %s', (_label, action, input) => {
    expect(normalizeOwnerParams(action, decision({ action_kind: action === 'duplicate_adset' ? 'structural' : 'budget_scale' }), input))
      .toMatchObject({ ok: false })
  })

  // The copy's budget is optional: absent or blank means "keep Meta's default", a value must be a
  // positive amount. Mutation testing found neither branch asserted (4 survivors on these two lines).
  it('keeps a valid budget for a duplicate and treats a blank one as none', () => {
    const structural = decision({ action_kind: 'structural' })
    expect(normalizeOwnerParams('duplicate_adset', structural, { new_name: 'Copy', new_daily_budget: '45.504' }))
      .toEqual({ ok: true, params: { new_name: 'Copy', new_daily_budget: 45.5 } })
    expect(normalizeOwnerParams('duplicate_adset', structural, { new_name: 'Copy', new_daily_budget: 30 }))
      .toEqual({ ok: true, params: { new_name: 'Copy', new_daily_budget: 30 } })
    expect(normalizeOwnerParams('duplicate_adset', structural, { new_name: 'Copy', new_daily_budget: '' }))
      .toEqual({ ok: true, params: { new_name: 'Copy', new_daily_budget: null } })
  })

  it.each([
    ['zero', 0],
    ['a negative amount', '-5'],
    ['text', 'lots'],
    ['whitespace', '   '],
  ] as const)('refuses a duplicate budget of %s', (_label, budget) => {
    expect(normalizeOwnerParams('duplicate_adset', decision({ action_kind: 'structural' }), { new_name: 'Copy', new_daily_budget: budget }))
      .toEqual({ ok: false, code: 'INVALID_PARAMS', message: 'The copy\'s daily budget must be a positive amount, or left empty.' })
  })

  it('requires the params to equal a mutation the engine did propose', () => {
    const proposed = decision({ proposed_mutation: { action_type: 'adjust_budget', new_daily_budget: 60 } })
    expect(normalizeOwnerParams('adjust_budget', proposed, { new_daily_budget: 61 })).toMatchObject({ ok: false })
    expect(normalizeOwnerParams('adjust_budget', proposed, { new_daily_budget: 60 })).toMatchObject({ ok: true })
  })
})

describe('budget steps', () => {
  it('measures the step against the current budget', () => {
    expect(budgetStepPercent(2600, 3000)).toBeCloseTo(15.38, 2)
    expect(budgetStepPercent(40, 20)).toBe(-50)
    expect(budgetStepPercent(0, 20)).toBeNull()
  })

  it('reads the configured cap with a sane default and refuses junk', () => {
    expect(maxBudgetChangePercent({})).toBe(50)
    expect(maxBudgetChangePercent({ MAX_BUDGET_CHANGE_PERCENT: '25' })).toBe(25)
    expect(maxBudgetChangePercent({ MAX_BUDGET_CHANGE_PERCENT: 'x' })).toBe(50)
    expect(maxBudgetChangePercent({ MAX_BUDGET_CHANGE_PERCENT: '-5' })).toBe(50)
    // Bounds of the accepted form (1 to 999999, whole numbers); anything else is the safe default.
    // Mutation testing widened the digit limit and nothing objected.
    expect(maxBudgetChangePercent({ MAX_BUDGET_CHANGE_PERCENT: '999999' })).toBe(999999)
    expect(maxBudgetChangePercent({ MAX_BUDGET_CHANGE_PERCENT: '1000000' })).toBe(50)
    expect(maxBudgetChangePercent({ MAX_BUDGET_CHANGE_PERCENT: '0' })).toBe(50)
    expect(maxBudgetChangePercent({ MAX_BUDGET_CHANGE_PERCENT: '12.5' })).toBe(50)
    expect(maxBudgetChangePercent({ MAX_BUDGET_CHANGE_PERCENT: ' 30 ' })).toBe(30)
  })
})

describe('preview, rollback and simulation', () => {
  const adsetBefore = { id: 'adset-1', name: 'ASC · Broad US', status: 'ACTIVE', daily_budget: '260000' }
  const money = (minor: unknown) => Number(minor) / 100

  it('writes a human preview with before, after and the step', () => {
    expect(ownerChangePreview('adjust_budget', { new_daily_budget: 3000 }, adsetBefore, money))
      .toBe('Raise ad set "ASC · Broad US" daily budget $2,600.00 → $3,000.00 (+15.4%).')
    expect(ownerChangePreview('adjust_budget', { new_daily_budget: 2000 }, adsetBefore, money))
      .toBe('Lower ad set "ASC · Broad US" daily budget $2,600.00 → $2,000.00 (−23.1%).')
    expect(ownerChangePreview('pause_ad', {}, { id: 'ad-1', name: 'Reel', status: 'ACTIVE' }, money))
      .toBe('Pause ad "Reel" (currently ACTIVE).')
    expect(ownerChangePreview('duplicate_adset', { new_name: 'Copy', new_daily_budget: null }, adsetBefore, money))
      .toBe('Duplicate ad set "ASC · Broad US" as "Copy" (the copy is created paused).')
  })

  it('derives the inverse change from the executed before-state', () => {
    expect(rollbackFor({ action_type: 'pause_ad', params: {}, before_state: { status: 'ACTIVE' } }, money))
      .toEqual({ actionType: 'activate_ad', params: {} })
    expect(rollbackFor({ action_type: 'activate_ad', params: {}, before_state: { status: 'PAUSED' } }, money))
      .toEqual({ actionType: 'pause_ad', params: {} })
    expect(rollbackFor({ action_type: 'adjust_budget', params: { new_daily_budget: 3000 }, before_state: adsetBefore }, money))
      .toEqual({ actionType: 'adjust_budget', params: { new_daily_budget: 2600 } })
    // No automatic inverse: the executor cannot delete a duplicated ad set.
    expect(rollbackFor({ action_type: 'duplicate_adset', params: { new_name: 'Copy' }, before_state: adsetBefore }, money)).toBeNull()
    // A pause of an ad that was already paused has nothing to restore.
    expect(rollbackFor({ action_type: 'pause_ad', params: {}, before_state: { status: 'PAUSED' } }, money)).toBeNull()
  })

  it('simulates the after-state without touching anything but the mutated field', () => {
    expect(simulatedAfterState('adjust_budget', adsetBefore, { new_daily_budget: 3000 }, (v) => Math.round(v * 100)))
      .toEqual({ ...adsetBefore, daily_budget: '300000' })
    expect(simulatedAfterState('pause_ad', { id: 'ad-1', status: 'ACTIVE' }, {}, (v) => v)).toEqual({ id: 'ad-1', status: 'PAUSED' })
  })
})

describe('execution authority for an owner request', () => {
  const request = { adAccountDbId: 'account-a', actionType: 'adjust_budget' as const, entityLevel: 'adset' as const, metaEntityId: 'adset-1', params: { new_daily_budget: 30 } }

  it('allows an approved owner_review decision without a causal estimate', () => {
    expect(validateOwnerWriteAuthority(decision({ approval_state: 'approved' }), request, { rollback: false }).allowed).toBe(true)
  })

  it.each([
    ['no decision', null],
    ['diagnostic only', decision({ approval_state: 'approved', authority_tier: 'diagnostic_only' })],
    ['not approved', decision({ approval_state: 'pending' })],
    ['another account', decision({ approval_state: 'approved', ad_account_id: 'account-b' })],
    ['another target', decision({ approval_state: 'approved', target_id: 'adset-2' })],
    ['below the floor', decision({ approval_state: 'approved', policy_version: 1 })],
    ['a mismatched engine mutation', decision({ approval_state: 'approved', proposed_mutation: { action_type: 'adjust_budget', new_daily_budget: 31 } })],
  ])('refuses %s', (_label, row) => {
    expect(validateOwnerWriteAuthority(row, request, { rollback: false }).allowed).toBe(false)
  })

  // Mutation testing: no test sent a valid duplicate through this check, never reordered a proposed
  // mutation's keys, and never read a refusal's reason (7 survivors).
  const structural = decision({ approval_state: 'approved', action_kind: 'structural' })
  const duplicate = (params: Record<string, unknown>) => ({ ...request, actionType: 'duplicate_adset' as const, params })

  it('allows a well-formed duplicate with or without a budget', () => {
    expect(validateOwnerWriteAuthority(structural, duplicate({ new_name: 'Copy', new_daily_budget: null }), { rollback: false }))
      .toEqual({ allowed: true, reason: 'The owner-initiated write matches its approved ActionDecision.' })
    expect(validateOwnerWriteAuthority(structural, duplicate({ new_name: 'Copy', new_daily_budget: 30 }), { rollback: false }).allowed).toBe(true)
  })

  it.each([
    ['an extra key', { new_name: 'Copy', new_daily_budget: null, status: 'ACTIVE' }],
    ['a zero budget', { new_name: 'Copy', new_daily_budget: 0 }],
    ['a blank name', { new_name: '  ', new_daily_budget: null }],
    ['no budget key at all', { new_name: 'Copy' }],
  ])('refuses a duplicate with %s', (_label, params) => {
    expect(validateOwnerWriteAuthority(structural, duplicate(params), { rollback: false }))
      .toEqual({ allowed: false, reason: 'The write request contains missing or ungoverned mutation parameters.' })
  })

  it('matches a proposed mutation whatever order its keys were stored in', () => {
    const reordered = decision({ approval_state: 'approved', action_kind: 'structural',
      proposed_mutation: { new_daily_budget: 30, new_name: 'Copy', action_type: 'duplicate_adset' } })
    expect(validateOwnerWriteAuthority(reordered, duplicate({ new_name: 'Copy', new_daily_budget: 30 }), { rollback: false }).allowed).toBe(true)
    // Control: the same keys with a different value is still refused.
    expect(validateOwnerWriteAuthority(reordered, duplicate({ new_name: 'Copy', new_daily_budget: 31 }), { rollback: false }))
      .toEqual({ allowed: false, reason: 'The request does not match the mutation the ActionDecision proposed.' })
  })

  it('says why it refuses another target or a kind that does not authorize the action', () => {
    expect(validateOwnerWriteAuthority(decision({ approval_state: 'approved', target_id: 'adset-2' }), request, { rollback: false }))
      .toEqual({ allowed: false, reason: 'The ActionDecision target does not match the requested Meta entity.' })
    expect(validateOwnerWriteAuthority(decision({ approval_state: 'approved', action_kind: 'structural' }), request, { rollback: false }))
      .toEqual({ allowed: false, reason: 'The ActionDecision kind does not authorize this write action.' })
  })

  it('says why it refuses a missing decision or another account', () => {
    expect(validateOwnerWriteAuthority(null, request, { rollback: false }))
      .toEqual({ allowed: false, reason: 'No ActionDecision is linked to this write.' })
    expect(validateOwnerWriteAuthority(decision({ approval_state: 'approved', ad_account_id: 'account-b' }), request, { rollback: false }))
      .toEqual({ allowed: false, reason: 'The ActionDecision belongs to a different ad account.' })
  })

  it('accepts the inverse kind only for a rollback', () => {
    const pause = decision({ approval_state: 'approved', action_kind: 'pause', target_level: 'ad', target_id: 'ad-1' })
    const activate = { adAccountDbId: 'account-a', actionType: 'activate_ad' as const, entityLevel: 'ad' as const, metaEntityId: 'ad-1', params: {} }
    expect(validateOwnerWriteAuthority(pause, activate, { rollback: true }).allowed).toBe(true)
    expect(validateOwnerWriteAuthority(pause, activate, { rollback: false }).allowed).toBe(false)
  })
})
