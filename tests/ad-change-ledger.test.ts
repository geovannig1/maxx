import { describe, it, expect } from 'vitest'
import {
  buildSetupDecision,
  deriveLearningEligibility,
  classifyLedgerOutcome,
  canOutcomeValidate,
  launchedMatchesProposed,
  entityKeyForSetup,
  type SetupDecisionInput,
} from '@/lib/recommendations/setup-ledger'
import { evaluateConflict, normalizeSettingValue, buildRevisionGuidance } from '@/lib/recommendations/conflict-guard'
import { derivesActionTaken, isOutcomeReviewEligible } from '@/lib/recommendations/decisions'

// Ad Decision Ledger invariants. Decisions record INTENT (never execute); only genuinely
// acted-on decisions become outcome-review eligible; conflicting setting switches are flagged and never
// silent; estimate/organic outcomes require review; low-data outcomes are inconclusive; write mode stays
// off and action_allowed_now stays false; and the existing recommendation_decisions behavior is untouched.

function base(over: Partial<SetupDecisionInput> = {}): SetupDecisionInput {
  return {
    ad_account_id: 'ACCT-1',
    entity_type: 'campaign',
    entity_key: 'summer-open-house',
    setting_category: 'optimization_event',
    setting_name: 'Optimization event',
    origin: 'launch_setup',
    ...over,
  }
}

describe('ledger: setup + manual decisions are logged as read-only intent', () => {
  it('an initial setup decision is logged (previous null, final set, read-only)', () => {
    const r = buildSetupDecision(base({ previous_value: null, proposed_value: 'AppointmentConfirmed', final_value: 'AppointmentConfirmed', user_decision: 'accepted' }))
    expect(r.origin).toBe('launch_setup')
    expect(r.previous_value).toBeNull()
    expect(r.final_value).toBe('AppointmentConfirmed')
    expect(r.write_mode_status).toBe('off')
    expect(r.action_allowed_now).toBe(false)
    expect(r.approval_required).toBe(true)
  })

  it('a manual action can be logged (origin manual_action, action taken)', () => {
    const r = buildSetupDecision(base({
      origin: 'manual_action', setting_category: 'budget', setting_name: 'Daily budget',
      previous_value: '$25/day', actual_launched_value: '$45/day', action_taken_explicit: true,
      decided_by: 'owner', decision_note: 'Bumped after strong week',
    }))
    expect(r.origin).toBe('manual_action')
    expect(r.action_taken).toBe(true)
    expect(r.actual_launched_value).toBe('$45/day')
  })

  it('user note is stored verbatim', () => {
    const r = buildSetupDecision(base({ user_decision: 'rejected', decision_note: 'Keep LPV off — booking is the goal.' }))
    expect(r.decision_note).toBe('Keep LPV off — booking is the goal.')
  })

  it('actual launched value can differ from the proposed/final value (drift is detectable)', () => {
    const r = buildSetupDecision(base({
      setting_category: 'attribution_window', setting_name: 'Attribution window',
      proposed_value: '7-day click / 1-day view', final_value: '7-day click / 1-day view',
      actual_launched_value: '1-day click', user_decision: 'acted_on',
    }))
    expect(r.actual_launched_value).toBe('1-day click')
    expect(launchedMatchesProposed(r)).toBe(false) // launched ≠ plan
  })

  it('write mode stays off and action_allowed_now stays false for every origin', () => {
    for (const origin of ['launch_setup', 'maxx_recommendation', 'manual_action'] as const) {
      const r = buildSetupDecision(base({ origin, action_taken_explicit: true }))
      expect(r.write_mode_status).toBe('off')
      expect(r.action_allowed_now).toBe(false)
    }
  })

  it('entityKeyForSetup: real id wins, else planned-name slug, else account', () => {
    expect(entityKeyForSetup('camp_123')).toBe('camp_123')
    expect(entityKeyForSetup(null, "Founder's Week 2026")).toBe('founder-s-week-2026')
    expect(entityKeyForSetup(null, null)).toBe('account')
  })
})

describe('ledger: accepted ≠ acted-on; only acted-on is outcome-review eligible', () => {
  it('accepted-but-not-acted is NOT learning eligible', () => {
    const r = buildSetupDecision(base({ user_decision: 'accepted', attributed_share: 0.9 }))
    expect(r.action_taken).toBe(false)
    expect(r.learning_eligibility).toBe(false)
    expect(isOutcomeReviewEligible({ user_decision: 'accepted', action_taken: r.action_taken })).toBe(false)
  })

  it('acted-on with good attribution IS learning eligible / review eligible', () => {
    const r = buildSetupDecision(base({ user_decision: 'acted_on', attributed_share: 0.8 }))
    expect(r.action_taken).toBe(true)
    expect(r.learning_eligibility).toBe(true)
    expect(isOutcomeReviewEligible({ user_decision: 'acted_on', action_taken: true })).toBe(true)
  })

  it('ignored / snoozed never auto-become learning', () => {
    expect(buildSetupDecision(base({ user_decision: 'ignored' })).learning_eligibility).toBe(false)
    expect(buildSetupDecision(base({ user_decision: 'snoozed' })).learning_eligibility).toBe(false)
  })
})

describe('conflict guard: switches are flagged, never silent (semantic compare)', () => {
  it('1-day vs 7-day attribution conflict is detected and high-stakes', () => {
    const c = evaluateConflict({ setting_category: 'attribution_window', final_value: '1-day click' }, { setting_category: 'attribution_window', proposed_value: '7-day click' })
    expect(c.conflicts).toBe(true)
    expect(c.is_high_stakes).toBe(true)
    expect(c.requires_approval).toBe(true)
    expect(c.change_summary).toBe('1-day click → 7-day click')
  })

  it('page views vs AppointmentConfirmed conflict is detected and high-stakes', () => {
    const c = evaluateConflict({ setting_category: 'optimization_event', final_value: 'Landing Page Views' }, { setting_category: 'optimization_event', proposed_value: 'AppointmentConfirmed' })
    expect(c.conflicts).toBe(true)
    expect(c.is_high_stakes).toBe(true)
    expect(c.requires_approval).toBe(true)
  })

  it('a generic setting conflict (broad vs interest stack) is flagged but not high-stakes', () => {
    const c = evaluateConflict({ setting_category: 'audience', final_value: 'Broad' }, { setting_category: 'audience', proposed_value: 'Interest stack: photographers' })
    expect(c.conflicts).toBe(true)
    expect(c.is_high_stakes).toBe(false)
    expect(c.requires_approval).toBe(true)
  })

  it('synonyms do NOT false-alarm: "7-day click / 1-day view" == "7d click / 1d view"; LPV == landing page views', () => {
    const win = evaluateConflict({ setting_category: 'attribution_window', final_value: '7-day click / 1-day view' }, { setting_category: 'attribution_window', proposed_value: '7d click / 1d view' })
    expect(win.conflicts).toBe(false)
    expect(normalizeSettingValue('optimization_event', 'LPV')).toBe(normalizeSettingValue('optimization_event', 'Landing Page Views'))
  })

  it('no prior value ⇒ first-time setup is not a conflict', () => {
    expect(evaluateConflict({ setting_category: 'budget', final_value: null }, { setting_category: 'budget', proposed_value: '$25/day' }).conflicts).toBe(false)
  })

  it('revision guidance never auto-deprecates the prior; approval required on conflict', () => {
    const c = evaluateConflict({ setting_category: 'optimization_event', final_value: 'Landing Page Views' }, { setting_category: 'optimization_event', proposed_value: 'AppointmentConfirmed' })
    const gUnapproved = buildRevisionGuidance(c, { why_better: 'Optimizes the event that books revenue', prior_decision_id: 'D-1' })
    expect(gUnapproved.prior_deprecated).toBe(false) // nothing auto-flips
    expect(gUnapproved.approval_required).toBe(true)
    expect(gUnapproved.why_changed).toMatch(/books revenue/)
    const gApproved = buildRevisionGuidance(c, { deprecate_prior: true })
    expect(gApproved.prior_deprecated).toBe(true) // only once the human approves the switch
  })
})

describe('ledger: outcome/learning firewall (no false learning)', () => {
  it('organic-only / estimate-as-truth / sub-floor attribution cannot self-validate a paid decision', () => {
    expect(canOutcomeValidate({ organicOnly: true })).toBe(false)
    expect(canOutcomeValidate({ usesEstimateAsTruth: true, attributedShare: 0.9 })).toBe(false)
    expect(canOutcomeValidate({ attributedShare: 0.3 })).toBe(false)
    expect(canOutcomeValidate({ attributedShare: null })).toBe(false)
    expect(canOutcomeValidate({ attributedShare: 0.8 })).toBe(true)
    // and it flows into eligibility:
    expect(deriveLearningEligibility({ user_decision: 'acted_on', action_taken: true, uses_estimate_as_truth: true })).toBe(false)
  })

  it('estimate-only outcome requires review (never learned, even if approved)', () => {
    expect(classifyLedgerOutcome({ dataSufficient: true, estimateOnly: true, decisiveResult: true }).valueOf()).toBe('needs_review')
    expect(classifyLedgerOutcome({ dataSufficient: true, estimateOnly: true, approved: true })).toBe('needs_review')
  })

  it('low-data outcome is inconclusive', () => {
    expect(classifyLedgerOutcome({ dataSufficient: false })).toBe('inconclusive')
    expect(classifyLedgerOutcome({ dataSufficient: true, decisiveResult: false })).toBe('inconclusive')
  })

  it('a clean, decisive, well-attributed outcome is PENDING (awaiting owner review) — never auto-trusted', () => {
    expect(classifyLedgerOutcome({ dataSufficient: true, decisiveResult: true, attributedShare: 0.8 })).toBe('pending')
    // learned only via explicit owner approval:
    expect(classifyLedgerOutcome({ dataSufficient: true, decisiveResult: true, attributedShare: 0.8, approved: true })).toBe('learned')
  })
})

describe('existing recommendation_decisions behavior is unchanged', () => {
  it('the reused primitives still behave as before', () => {
    expect(derivesActionTaken('accepted')).toBe(false)
    expect(derivesActionTaken('acted_on')).toBe(true)
    expect(isOutcomeReviewEligible({ user_decision: 'ignored', action_taken: false })).toBe(false)
  })
})
