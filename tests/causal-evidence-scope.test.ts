import { describe, it, expect } from 'vitest'
import {
  applicableCausalEvidence, applicableConflicts, variableForKind,
  CAUSAL_RESULT_MAX_AGE_DAYS, UNLOCK_BLOCKED_REASON, type ExperimentRecord,
} from '@/lib/recommendations/causal-evidence'

// `hasCompletedExperiment()` asked one account-global question — "is there ANY
// completed experiment with outcome=success?" — and used the answer as causal evidence for every
// recommendation. A successful CREATIVE test therefore unlocked an unrelated BUDGET move on a
// different ad set. An experiment result is evidence about the entity it ran on and the variable it
// changed. Nothing else.

const NOW = Date.parse('2026-07-26T12:00:00Z')
const RECENT = '2026-07-20T00:00:00Z'

const exp = (over: Partial<ExperimentRecord> = {}): ExperimentRecord => ({
  id: 'e1', status: 'complete', outcome: 'success',
  entity_level: 'adset', entity_ref: 'adset-A',
  changed_variable: 'daily_budget',
  control_ref: 'adset-A current $30', challenger_ref: 'adset-A proposed $36',
  started_at: '2026-07-01T00:00:00Z', ended_at: RECENT,
  owner_decision: 'adopt', owner_decided_at: RECENT,
  result_provenance: { source: 'decision_gate' },
  ...over,
})

const ctx = (over: Partial<{ entityRefs: string[]; entityLevel: 'campaign' | 'adset' | 'ad'; kind: 'budget' | 'scale' | 'pause' | 'refresh' }> = {}) =>
  ({ entityRefs: ['adset-A'], entityLevel: 'adset' as const, kind: 'budget' as const, nowMs: NOW, ...over })

describe('applicableCausalEvidence — scoped, not global', () => {
  it('a matching entity + variable + fresh + provenanced result IS applicable', () => {
    const r = applicableCausalEvidence([exp()], ctx())
    expect(r.applicable.map((a) => a.experimentId)).toEqual(['e1'])
  })

  it('an UNRELATED ENTITY is rejected', () => {
    const r = applicableCausalEvidence([exp({ entity_ref: 'adset-B' })], ctx())
    expect(r.applicable).toEqual([])
    expect(r.rejections[0].reason).toBe('unrelated_entity')
    expect(r.rejections[0].detail).toMatch(/this decision is at adset level/)
  })

  // The defect: identity lived only in the free-text refs, which hold budget STATE, so a
  // generated brief could never match the ad set it was generated for.
  it('matches on EXACT identity, NOT on the free-text refs', () => {
    // Refs that mention the WRONG entity must not defeat a correct entity_ref...
    const r1 = applicableCausalEvidence([exp({ control_ref: 'adset-ZZZ current $30', challenger_ref: 'adset-ZZZ proposed $36' })], ctx())
    expect(r1.applicable).toHaveLength(1)
    // ...and refs mentioning the RIGHT entity must not rescue a wrong entity_ref.
    const r2 = applicableCausalEvidence([exp({ entity_ref: 'adset-B', control_ref: 'adset-A current $30' })], ctx())
    expect(r2.applicable).toEqual([])
  })

  it('a result at ANOTHER LEVEL sharing the ref is NOT applicable — identity is the PAIR', () => {
    const campaignResult = exp({ entity_level: 'campaign', entity_ref: 'shared-ref' })
    const r = applicableCausalEvidence([campaignResult], ctx({ entityRefs: ['shared-ref'], entityLevel: 'adset' }))
    expect(r.applicable).toEqual([])
    expect(r.rejections[0].detail).toMatch(/identity is the \(level, ref\) PAIR/)
    // ...and IS applicable for a decision at its own level.
    expect(applicableCausalEvidence([campaignResult], ctx({ entityRefs: ['shared-ref'], entityLevel: 'campaign' })).applicable).toHaveLength(1)
  })

  it('a legacy row with no first-class identity is unmatchable, never guessed from prose', () => {
    const r = applicableCausalEvidence([exp({ entity_level: null, entity_ref: null, control_ref: 'adset-A current $30' })], ctx())
    expect(r.applicable).toEqual([])
    expect(r.rejections[0].detail).toMatch(/no first-class entity identity/)
  })

  it('an UNRELATED VARIABLE is rejected — a creative test cannot unlock a budget move', () => {
    const r = applicableCausalEvidence([exp({ changed_variable: 'creative' })], ctx({ kind: 'budget' }))
    expect(r.applicable).toEqual([])
    expect(r.rejections[0].reason).toBe('unrelated_variable')
    expect(r.rejections[0].detail).toMatch(/changed "creative".*changes "daily_budget"/)
  })

  it('the SAME creative result IS applicable to a refresh decision', () => {
    const r = applicableCausalEvidence([exp({ changed_variable: 'creative' })], ctx({ kind: 'refresh' }))
    expect(r.applicable).toHaveLength(1)
  })

  it('MISSING PROVENANCE is rejected — a result that cannot be re-derived is not evidence', () => {
    expect(applicableCausalEvidence([exp({ result_provenance: null })], ctx()).rejections[0].reason).toBe('missing_provenance')
    expect(applicableCausalEvidence([exp({ result_provenance: {} })], ctx()).rejections[0].reason).toBe('missing_provenance')
  })

  it('a STALE result is rejected', () => {
    const old = new Date(NOW - (CAUSAL_RESULT_MAX_AGE_DAYS + 1) * 86_400_000).toISOString()
    const r = applicableCausalEvidence([exp({ ended_at: old })], ctx())
    expect(r.applicable).toEqual([])
    expect(r.rejections[0].reason).toBe('stale_result')
  })

  it('an UNKNOWN end time is treated as stale, never as fresh', () => {
    expect(applicableCausalEvidence([exp({ ended_at: null })], ctx()).rejections[0].reason).toBe('stale_result')
  })

  it('an incomplete or unsuccessful experiment is rejected', () => {
    expect(applicableCausalEvidence([exp({ status: 'running' })], ctx()).rejections[0].reason).toBe('not_complete')
    expect(applicableCausalEvidence([exp({ outcome: 'failure' })], ctx()).rejections[0].reason).toBe('not_successful')
    expect(applicableCausalEvidence([exp({ outcome: 'inconclusive' })], ctx()).rejections[0].reason).toBe('not_successful')
  })

  it('NO ENTITY REFERENCE fails closed — nothing can be matched', () => {
    const r = applicableCausalEvidence([exp()], ctx({ entityRefs: [] }))
    expect(r.applicable).toEqual([])
    expect(r.rejections[0].reason).toBe('unrelated_entity')
    expect(r.rejections[0].detail).toMatch(/supplied no entity reference/)
  })

  it('an ABSENT OWNER DISPOSITION is recorded as a rejection reason', () => {
    const r = applicableCausalEvidence([exp({ owner_decision: null })], ctx())
    expect(r.rejections.some((x) => x.reason === 'no_owner_disposition')).toBe(true)
  })

  // The binding limitation.
  it('NO completed experiment may unlock a direct action — there is no governed approval vocabulary', () => {
    const r = applicableCausalEvidence([exp()], ctx())
    expect(r.applicable).toHaveLength(1)   // it IS applicable evidence...
    expect(r.unlocksDirectAction).toBe(false) // ...but it does not authorise a money move
    expect(r.unlockBlockedReason).toBe(UNLOCK_BLOCKED_REASON)
    expect(r.unlockBlockedReason).toMatch(/free text with no enum or CHECK constraint/)
  })

  it('variableForKind maps money/creative/status distinctly', () => {
    expect(variableForKind('budget')).toBe('daily_budget')
    expect(variableForKind('scale')).toBe('daily_budget')
    expect(variableForKind('refresh')).toBe('creative')
    expect(variableForKind('pause')).toBe('status')
  })
})

describe('applicableConflicts — a running test elsewhere does not block here', () => {
  const running = (over: Partial<ExperimentRecord> = {}) => exp({ status: 'running', outcome: null, ...over })

  it('a running SAME-entity SAME-variable test conflicts', () => {
    expect(applicableConflicts([running()], { entityRefs: ['adset-A'], entityLevel: 'adset', kind: 'budget' })).toEqual(['e1'])
  })

  // Identity is the (level, ref) PAIR. Comparing the ref alone let a CAMPAIGN test falsely block an
  // AD SET decision that happened to share the reference.
  it('a running test at ANOTHER LEVEL with the same ref does NOT conflict', () => {
    const campaignTest = running({ entity_level: 'campaign', entity_ref: 'shared-ref' })
    expect(applicableConflicts([campaignTest], { entityRefs: ['shared-ref'], entityLevel: 'adset', kind: 'budget' })).toEqual([])
    // ...and DOES conflict at its own level.
    expect(applicableConflicts([campaignTest], { entityRefs: ['shared-ref'], entityLevel: 'campaign', kind: 'budget' })).toEqual(['e1'])
  })

  // The P1 consequence: a Maxx-GENERATED running experiment must block another change to its own
  // ad set. It could not, because its refs held budget state instead of the entity.
  it('a GENERATED brief whose refs hold budget state still conflicts, via entity_ref', () => {
    const generated = running({ control_ref: 'adset current state ($30)', challenger_ref: 'adset proposed state ($36)' })
    expect(applicableConflicts([generated], { entityRefs: ['adset-A'], entityLevel: 'adset', kind: 'budget' })).toEqual(['e1'])
  })

  it('a running test on ANOTHER entity does NOT conflict', () => {
    const r = applicableConflicts([running({ entity_ref: 'adset-B' })], { entityRefs: ['adset-A'], entityLevel: 'adset', kind: 'budget' })
    expect(r).toEqual([])
  })

  it('a running test with NO identity conflicts (fails closed)', () => {
    expect(applicableConflicts([running({ entity_level: null, entity_ref: null })], { entityRefs: ['adset-A'], entityLevel: 'adset', kind: 'budget' })).toEqual(['e1'])
  })

  it('a running test on ANOTHER variable does NOT conflict', () => {
    expect(applicableConflicts([running({ changed_variable: 'creative' })], { entityRefs: ['adset-A'], entityLevel: 'adset', kind: 'budget' })).toEqual([])
  })

  it('a completed test never conflicts', () => {
    expect(applicableConflicts([exp()], { entityRefs: ['adset-A'], entityLevel: 'adset', kind: 'budget' })).toEqual([])
  })

  it('with NO entity reference a same-variable running test conflicts (fails closed)', () => {
    expect(applicableConflicts([running()], { entityRefs: [], entityLevel: 'adset', kind: 'budget' })).toEqual(['e1'])
  })
})
