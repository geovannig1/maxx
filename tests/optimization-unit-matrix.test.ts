import { describe, it, expect, vi } from 'vitest'
import { resolveOptimizationUnit, decideRecommendation, type DecisionInputs } from '@/lib/recommendations/decision-policy'
import { proposedScaleBudget, SCALE_STEP_SHARE } from '@/lib/recommendations/evidence-gate'
import { resolveAudience, gateBudgetMove } from '@/lib/audience/resolver'
import { conversionActionability } from '@/lib/trust/conversion-actionability'

// The decision UNIT depends on the recommendation KIND, not on budget structure
// alone. A single budget-shaped resolver was applied to every kind, so a creative refresh on an ad
// and a status change on a campaign were both forced onto the budget unit.

const NOW = Date.parse('2026-07-26T12:00:00Z')
const READY = { operationStatus: { code: 200 }, deliveryStatus: { code: 200 }, lastSyncedAt: '2026-07-26T11:00:00Z' }

describe('optimization unit — ABO/CBO x level x kind matrix', () => {
  type Row = [structure: 'cbo' | 'abo' | 'unknown', level: 'campaign' | 'adset' | 'ad', kind: 'budget' | 'scale' | 'pause' | 'refresh', expected: string]
  const MATRIX: Row[] = [
    // MONEY: an ad never owns a budget; CBO moves the decision to the campaign.
    ['abo', 'adset', 'budget', 'adset'],
    ['abo', 'ad', 'budget', 'adset'],
    ['abo', 'campaign', 'budget', 'campaign'],
    ['cbo', 'adset', 'budget', 'campaign'],
    ['cbo', 'ad', 'budget', 'campaign'],
    ['cbo', 'campaign', 'budget', 'campaign'],
    ['abo', 'adset', 'scale', 'adset'],
    ['cbo', 'adset', 'scale', 'campaign'],
    ['unknown', 'adset', 'budget', 'unknown'],
    ['unknown', 'adset', 'scale', 'unknown'],

    // STATUS: belongs to the level actually being changed — except pausing an ABO...
    // ...no: under CBO, pausing one ad set redistributes budget, so it is a campaign consequence.
    ['abo', 'ad', 'pause', 'ad'],
    ['abo', 'adset', 'pause', 'adset'],
    ['abo', 'campaign', 'pause', 'campaign'],
    ['cbo', 'ad', 'pause', 'ad'],
    ['cbo', 'adset', 'pause', 'campaign'],
    ['cbo', 'campaign', 'pause', 'campaign'],
    ['unknown', 'adset', 'pause', 'unknown'],

    // CREATIVE: the AD owns the asset, under either budget structure.
    ['abo', 'ad', 'refresh', 'ad'],
    ['cbo', 'ad', 'refresh', 'ad'],
    ['abo', 'adset', 'refresh', 'adset'],
    ['cbo', 'adset', 'refresh', 'adset'],
    // A creative decision does not need budget structure at all.
    ['unknown', 'ad', 'refresh', 'ad'],
  ]

  it.each(MATRIX)('%s / %s / %s -> %s', (structure, level, kind, expected) => {
    expect(resolveOptimizationUnit(structure, level, kind)).toBe(expected)
  })

  it('a CREATIVE decision on an ad is NOT forced onto the budget unit', () => {
    // The defect: the budget-shaped resolver returned 'adset' for an ad-level refresh under ABO and
    // 'campaign' under CBO, so a creative verdict was attributed to a level that does not own it.
    expect(resolveOptimizationUnit('cbo', 'ad', 'refresh')).toBe('ad')
    expect(resolveOptimizationUnit('cbo', 'ad', 'budget')).toBe('campaign')
  })

  it('a creative decision resolves even when budget structure is unknown', () => {
    expect(resolveOptimizationUnit('unknown', 'ad', 'refresh')).toBe('ad')
    expect(resolveOptimizationUnit('unknown', 'ad', 'budget')).toBe('unknown')
  })
})

describe('budget-move gate — a null proposal is not a decidable move', () => {
  const pure = resolveAudience({
    adsetName: 'Warm', targeting: { custom_audiences: [{ id: 'A' }], targeting_automation: { advantage_audience: 0 } },
    targetingSyncedAt: '2026-07-26T11:00:00Z', accountId: 'self',
    audiencesById: { A: { id: 'A', name: 'v', subtype: 'WEBSITE', accountId: 'self', ...READY } },
  }, NOW)

  it('REJECTS a null proposedBudget outright', () => {
    const g = gateBudgetMove(pure, { currentBudget: 22, proposedBudget: null })
    expect(g.allowed).toBe(false)
    expect(g.reason).toMatch(/no stated target cannot be evaluated, approved, or reversed/)
    expect(g.fallback).toBe('owner_review')
  })

  it('REJECTS an unknown current budget — a move cannot be sized against an unverified baseline', () => {
    const g = gateBudgetMove(pure, { currentBudget: null, proposedBudget: 34 })
    expect(g.allowed).toBe(false)
    expect(g.reason).toMatch(/unverified baseline/)
  })

  it('allows a sized move against a verified baseline', () => {
    expect(gateBudgetMove(pure, { currentBudget: 22, proposedBudget: 34 }).allowed).toBe(true)
  })
})

describe('scale proposal — DERIVED from the verified budget, never parsed from prose', () => {
  it('derives the step from the current budget', () => {
    expect(proposedScaleBudget(30)).toBe(30 * (1 + SCALE_STEP_SHARE))
    expect(proposedScaleBudget(100)).toBe(120)
  })

  it('rounds the step to the account currency minor unit (JPY whole yen, KWD fils), not to cents', () => {
    try {
      vi.stubEnv('NEXT_PUBLIC_ACCOUNT_CURRENCY', 'JPY')
      expect(proposedScaleBudget(1001)).toBe(1201)
      vi.stubEnv('NEXT_PUBLIC_ACCOUNT_CURRENCY', 'KWD')
      expect(proposedScaleBudget(10.001)).toBe(12.001)
      vi.stubEnv('NEXT_PUBLIC_ACCOUNT_CURRENCY', 'USD')
      expect(proposedScaleBudget(10.01)).toBe(12.01)
    } finally { vi.unstubAllEnvs() }
  })

  it('is NULL when the current budget is unknown or unusable', () => {
    expect(proposedScaleBudget(null)).toBeNull()
    expect(proposedScaleBudget(0)).toBeNull()
    expect(proposedScaleBudget(-5)).toBeNull()
    expect(proposedScaleBudget(NaN)).toBeNull()
  })

  it('the step is a NUMBER in code, so copy-editing the flag prose cannot move money', () => {
    expect(typeof SCALE_STEP_SHARE).toBe('number')
    expect(SCALE_STEP_SHARE).toBeGreaterThan(0)
  })
})

describe('campaign-level decisions need conservative MEMBER context', () => {
  const audience = (over: Record<string, unknown> = {}, meta?: Record<string, unknown>) =>
    resolveAudience({
      adsetName: 'x',
      targeting: { custom_audiences: [{ id: 'A' }], targeting_automation: { advantage_audience: 0 }, ...over },
      targetingSyncedAt: '2026-07-26T11:00:00Z', accountId: 'self',
      audiencesById: (meta ?? { A: { id: 'A', name: 'v', subtype: 'WEBSITE', accountId: 'self', ...READY } }) as never,
    }, NOW)

  const pureMember = audience()
  const mixedMember = audience(
    { custom_audiences: [{ id: 'A' }, { id: 'B' }], targeting_automation: { advantage_audience: 1 } },
    { A: { id: 'A', name: 'v', subtype: 'WEBSITE', accountId: 'self', ...READY }, B: { id: 'B', name: 'l', subtype: 'LOOKALIKE', accountId: 'self', ...READY } },
  )
  const frozenMember = resolveAudience(
    { adsetName: 'x', targeting: null, targetingSyncedAt: null, accountId: 'self' }, NOW)

  const campaignInputs = (over: Partial<DecisionInputs> = {}): DecisionInputs => ({
    kind: 'budget', budgetStructure: 'cbo', entityLevel: 'campaign',
    audience: pureMember,
    conversions: conversionActionability({
      metaConversions: 60, viewThroughConversions: 5, firstPartyBookings: 55, ga4PaidConfirmationEvents: 50,
      firstPartyClickCoverage: 0.9, inLearning: false, audienceComposition: 'retargeting_only', hasCausalEvidence: true,
    }),
    firstPartyOutcomes: { value: 55, scope: 'campaign', provenance: 't' },
    webAttributedOutcomes: { value: 50, scope: 'campaign', provenance: 't' },
    deliveryMeasured: true, inLearning: false, diversity: null,
    memberAudiences: [pureMember, pureMember],
    conflictingExperiments: [], windowDays: 30, currentBudget: 22, proposedBudget: 34,
    hasCausalEvidence: true, ...over,
  })

  it('resolves when every member is coherent', () => {
    const d = decideRecommendation(campaignInputs())
    expect(d.optimizationUnit).toBe('campaign')
    expect(d.blockedBy).not.toContain('campaign_member_context_resolved')
  })

  it('MISSING member context blocks and escalates', () => {
    const d = decideRecommendation(campaignInputs({ memberAudiences: null }))
    expect(d.blockedBy).toContain('campaign_member_context_resolved')
    expect(d.verdict).toBe('owner_review')
    expect(d.gates.find((g) => g.name === 'campaign_member_context_resolved')!.detail)
      .toMatch(/NO member ad-set context/)
  })

  it('a FROZEN member blocks the campaign decision', () => {
    const d = decideRecommendation(campaignInputs({ memberAudiences: [pureMember, frozenMember] }))
    expect(d.blockedBy).toContain('campaign_member_context_resolved')
    expect(d.gates.find((g) => g.name === 'campaign_member_context_resolved')!.detail).toMatch(/frozen/)
  })

  it('CONTRADICTORY members roll up conservatively to mixed and are reported', () => {
    const d = decideRecommendation(campaignInputs({ memberAudiences: [pureMember, mixedMember] }))
    expect(d.gates.find((g) => g.name === 'campaign_member_context_resolved')!.detail)
      .toMatch(/rolls up conservatively to mixed/)
  })

  it('an ad-set decision does not require member context', () => {
    const d = decideRecommendation(campaignInputs({ budgetStructure: 'abo', entityLevel: 'adset', memberAudiences: null }))
    expect(d.optimizationUnit).toBe('adset')
    expect(d.gates.find((g) => g.name === 'campaign_member_context_resolved')).toBeUndefined()
  })
})
