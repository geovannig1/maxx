import { describe, it, expect } from 'vitest'
import { entityKeyFor, decisionMapKey, derivesActionTaken, isOutcomeReviewEligible } from '@/lib/recommendations/decisions'
import { tallyTrackRecord } from '@/lib/recommendations/knowledge'

// closed-loop learning invariants. Decisions record INTENT and never execute; only genuinely
// acted-on recommendations become outcome-review eligible; ignored/accepted never auto-teach; and the
// review gate never auto-approves (only 'approved' counts).

describe('decision key stability', () => {
  it('collapses account-level recs and preserves entity ids', () => {
    expect(entityKeyFor(null)).toBe('account')
    expect(entityKeyFor('')).toBe('account')
    expect(entityKeyFor('  ')).toBe('account')
    expect(entityKeyFor('ad_123')).toBe('ad_123')
    expect(decisionMapKey('ad_123', 'pause')).toBe('ad_123|pause')
  })
})

describe('derivesActionTaken — "accepted" is NOT "executed"', () => {
  it('accepted does not take action by itself', () => {
    expect(derivesActionTaken('accepted')).toBe(false)
  })
  it('acted_on always means the human acted', () => {
    expect(derivesActionTaken('acted_on')).toBe(true)
    expect(derivesActionTaken('acted_on', false)).toBe(true) // acted_on wins even if explicit says false
  })
  it('other decisions default to not-acted unless explicitly set', () => {
    expect(derivesActionTaken('snoozed')).toBe(false)
    expect(derivesActionTaken('ignored')).toBe(false)
    expect(derivesActionTaken('needs_more_data')).toBe(false)
    expect(derivesActionTaken('accepted', true)).toBe(true) // human can mark accepted+acted explicitly
  })
})

describe('isOutcomeReviewEligible — only acted-on becomes reviewable, ignored never auto-negative', () => {
  it('acted_on ⇒ eligible', () => {
    expect(isOutcomeReviewEligible({ user_decision: 'acted_on', action_taken: true })).toBe(true)
  })
  it('accepted-but-not-acted ⇒ NOT eligible (accepted ≠ executed)', () => {
    expect(isOutcomeReviewEligible({ user_decision: 'accepted', action_taken: false })).toBe(false)
  })
  it('ignored / snoozed / needs_more_data ⇒ NOT eligible (never auto-negative learning)', () => {
    expect(isOutcomeReviewEligible({ user_decision: 'ignored', action_taken: false })).toBe(false)
    expect(isOutcomeReviewEligible({ user_decision: 'snoozed', action_taken: false })).toBe(false)
    expect(isOutcomeReviewEligible({ user_decision: 'needs_more_data', action_taken: false })).toBe(false)
  })
  it('any decision with action_taken=true ⇒ eligible', () => {
    expect(isOutcomeReviewEligible({ user_decision: 'accepted', action_taken: true })).toBe(true)
  })
})

describe('review gate never auto-approves — only "approved" outcomes are trusted', () => {
  it('pending / rejected / inconclusive all contribute nothing to the track record', () => {
    const t = tallyTrackRecord([
      { flag_type: 'loser', outcome: 'worked', outcome_note: 'clean', review_status: 'pending' },
      { flag_type: 'loser', outcome: 'worked', outcome_note: 'clean', review_status: 'rejected' },
      { flag_type: 'loser', outcome: 'worked', outcome_note: 'clean', review_status: 'inconclusive' },
    ])
    expect(t.loser).toBeUndefined()
  })
  it('only an approved, non-estimate, decisive outcome counts', () => {
    const t = tallyTrackRecord([
      { flag_type: 'loser', metric_name: 'causal_incremental_contribution', outcome: 'worked', outcome_note: 'clean', review_status: 'approved' },
    ])
    expect(t.loser).toEqual({ wins: 1, decisive: 1 })
  })
})
