import { assertsMoneyAuthority } from '@/lib/authority/action-authority'
import { describe, it, expect } from 'vitest'
import { applyDecisionMemory, type RecommendationDecision } from '@/lib/recommendations/decisions'
import { settingDecisionContext, settingCategoriesForRecType, type LedgerRow } from '@/lib/recommendations/setup-ledger'
import { buildRecommendation, type BuildRecommendationInput } from '@/lib/recommendations/builder'
import { scoreSetupDecisionWindow, resolveLedgerEntityRef } from '@/lib/learning/ledger-outcomes'
import { GA4_ERROR_COVERAGE, scoreFlag } from '@/lib/learning/outcomes'
import { evaluateFlag, renderFlagAction } from '@/lib/flags/rules'

// intelligence-next — decision-memory invariants. The daily regeneration must RESPECT a standing human
// decision (a rejected rec never comes back as fresh actionable); setting-class recs must cite the
// ledger's recorded decision; setup decisions score only on real post-action delivery with the same
// estimate/attribution firewalls; and a GA4 outage fails CLOSED for learning.

// A grounded, high-confidence scale rec (mirrors the recommendation-wiring fixture).
const base: BuildRecommendationInput = {
  recommendation_type: 'scale', target_entity_type: 'adset',
  observed_fact: 'CPA $40 on 16 bookings over 14 days.', reason_for_action: 'Efficient winner with room to scale.',
  basis: 'observed_performance',
  metric_values: [
    { name: 'CPA', value: 40, unit: '$', source: 'meta_api' },
    { name: 'Bookings', value: 16, unit: 'count', source: 'meta_api' },
  ],
  spend: 600, bookings: 16, window_days: 14, data_age_hours: 5,
  uses_meta_estimate_as_revenue: false, days_since_last_change: 14, exited_learning: true,
  trend_stable: true, attributed_share: 0.8, reversible: true, today: '2026-07-01',
}

function decision(over: Partial<RecommendationDecision>): RecommendationDecision {
  return {
    user_decision: 'rejected', decision_note: null, decided_by: 'owner',
    decision_date: '2026-06-28T12:00:00Z', action_taken: false, action_taken_date: null,
    follow_up_date: null, expected_outcome_window: null, learning_eligibility: null,
    ...over,
  }
}

describe('applyDecisionMemory — the human veto stands', () => {
  const rec = buildRecommendation(base)

  it('no decision → unchanged', () => {
    const { rec: out, effect } = applyDecisionMemory(rec, null, '2026-07-01')
    expect(effect).toBe('none')
    expect(out).toBe(rec)
  })

  it('REJECTED → held (hold + low confidence) and the rejection is cited; never fresh actionable', () => {
    const { rec: out, effect } = applyDecisionMemory(rec, decision({ user_decision: 'rejected', decision_note: 'Hit the frequency wall last time' }), '2026-07-01')
    expect(effect).toBe('held_rejected')
    expect(out.grounding.decision).toBe('hold')
    expect(out.grounding.passed).toBe(false)
    expect(out.confidence_label).toBe('low')
    expect(out.confidence_score).toBeLessThanOrEqual(0.35)
    expect(out.action_allowed_now).toBe(false)
    expect(out.approval_required).toBe(true)
    const cited = out.what_could_make_this_wrong.some((x) => /REJECTED on 2026-06-28/.test(x) && /frequency wall/.test(x))
    expect(cited).toBe(true)
    expect(out.grounding.reasons.some((x) => /REJECTED/.test(x))).toBe(true)
  })

  it('does not mutate the input recommendation', () => {
    const before = JSON.parse(JSON.stringify(rec))
    applyDecisionMemory(rec, decision({ user_decision: 'rejected' }), '2026-07-01')
    expect(rec).toEqual(before)
  })

  it('SNOOZED before follow-up → held; after follow-up → resurfaces annotated (not demoted)', () => {
    const early = applyDecisionMemory(rec, decision({ user_decision: 'snoozed', follow_up_date: '2026-07-05' }), '2026-07-01')
    expect(early.effect).toBe('held_snoozed')
    expect(early.rec.grounding.decision).toBe('hold')

    const late = applyDecisionMemory(rec, decision({ user_decision: 'snoozed', follow_up_date: '2026-06-30' }), '2026-07-01')
    expect(late.effect).toBe('resurfaced_after_snooze')
    expect(late.rec.grounding.decision).toBe(rec.grounding.decision) // not demoted
    expect(late.rec.what_could_make_this_wrong.some((x) => /snooze has expired/.test(x))).toBe(true)
  })

  it('SNOOZED with no follow-up date → held indefinitely (until the human changes it)', () => {
    const { rec: out, effect } = applyDecisionMemory(rec, decision({ user_decision: 'snoozed' }), '2026-07-01')
    expect(effect).toBe('held_snoozed')
    expect(out.grounding.decision).toBe('hold')
  })

  it('NEEDS MORE DATA → held while evidence is not high; surfaces annotated once it is', () => {
    // The base fixture builds a HIGH-confidence rec → evidence strengthened → resurface.
    const strong = applyDecisionMemory(rec, decision({ user_decision: 'needs_more_data' }), '2026-07-01')
    expect(rec.confidence_label).toBe('high') // fixture sanity
    expect(strong.effect).toBe('evidence_strengthened')
    expect(strong.rec.grounding.decision).toBe(rec.grounding.decision)

    // A thin rec (held by the gate, low confidence) stays held under the same standing decision.
    const thinRec = buildRecommendation({ ...base, spend: 30, bookings: 1, window_days: 3, days_since_last_change: 1, exited_learning: false, trend_stable: null })
    const weak = applyDecisionMemory(thinRec, decision({ user_decision: 'needs_more_data' }), '2026-07-01')
    expect(weak.effect).toBe('held_needs_more_data')
    expect(weak.rec.grounding.decision).toBe('hold')
  })

  it('ACTED ON / ACCEPTED → annotated only (no demotion), with the double-acting caution', () => {
    const acted = applyDecisionMemory(rec, decision({ user_decision: 'acted_on', action_taken: true, action_taken_date: '2026-06-29T10:00:00Z' }), '2026-07-01')
    expect(acted.effect).toBe('annotated_acted_on')
    expect(acted.rec.grounding.decision).toBe(rec.grounding.decision)
    expect(acted.rec.what_could_make_this_wrong.some((x) => /ACTED ON on 2026-06-29/.test(x) && /double-acting/.test(x))).toBe(true)

    const accepted = applyDecisionMemory(rec, decision({ user_decision: 'accepted' }), '2026-07-01')
    expect(accepted.effect).toBe('annotated_accepted')
    expect(accepted.rec.what_could_make_this_wrong.some((x) => /accepted ≠ executed/.test(x))).toBe(true)
  })
})

function ledgerRow(over: Partial<LedgerRow>): LedgerRow {
  return {
    id: 'L1', entity_type: 'campaign', entity_key: 'example-studio-launch', entity_name: 'Example Studio — Launch',
    setting_category: 'optimization_event', setting_name: 'Optimization event',
    previous_value: null, proposed_value: null, final_value: 'AppointmentConfirmed', actual_launched_value: null,
    origin: 'launch_setup', reason: 'Proven event booked at ~$59', user_decision: 'accepted', decision_note: null,
    decided_by: 'owner', action_taken: true, conflicts_with_prior: false, prior_decision_id: null,
    prior_deprecated: false, change_summary: null, why_changed: null, switch_risk: null,
    follow_up_date: null, created_at: '2026-06-25T00:00:00Z',
    ...over,
  }
}

describe('settingDecisionContext — setting-class recs cite the recorded decision', () => {
  it('maps setting-class AND flag-derived money/creative rec types (live in the real pipeline)', () => {
    expect(settingCategoriesForRecType('change_optimization_event')).toContain('optimization_event')
    expect(settingCategoriesForRecType('change_audience')).toEqual(['audience'])
    expect(settingCategoriesForRecType('scale')).toEqual(['budget']) // a scale rec changes the decided budget
    expect(settingCategoriesForRecType('refresh_creative')).toEqual(['creative'])
    expect(settingCategoriesForRecType('pause')).toEqual([])
    expect(settingCategoriesForRecType('keep')).toEqual([])
    expect(settingCategoriesForRecType('investigate')).toEqual([])
  })

  it('a SCALE rec against a recorded budget decision cites it (the flag pipeline actually fires this)', () => {
    const budgetRow = ledgerRow({ setting_category: 'budget', setting_name: 'Budget', final_value: '$30/day per ad set', reason: 'learning-exit math' })
    const note = settingDecisionContext([budgetRow], { entityKey: 'example-studio-launch' }, 'scale')
    expect(note).toMatch(/\$30\/day/)
    expect(note).toMatch(/conflict flow/)
  })

  it('a change_optimization_event rec against a recorded decision cites value, date, and the conflict flow', () => {
    const note = settingDecisionContext([ledgerRow({})], { entityKey: 'example-studio-launch' }, 'change_optimization_event')
    expect(note).toMatch(/2026-06-25/)
    expect(note).toMatch(/AppointmentConfirmed/)
    expect(note).toMatch(/conflict flow/)
  })

  it('performance recs get no ledger note; retired and pending-switch rows are ignored', () => {
    expect(settingDecisionContext([ledgerRow({})], { entityKey: 'example-studio-launch' }, 'scale')).toBeNull()
    expect(settingDecisionContext([ledgerRow({ prior_deprecated: true })], { entityKey: 'example-studio-launch' }, 'change_optimization_event')).toBeNull()
    expect(settingDecisionContext([ledgerRow({ conflicts_with_prior: true })], { entityKey: 'example-studio-launch' }, 'change_optimization_event')).toBeNull()
  })

  it('falls back to account-level decisions when the entity has none', () => {
    const note = settingDecisionContext([ledgerRow({ entity_key: 'account', entity_name: null })], { entityKey: 'ad_999' }, 'change_optimization_event')
    expect(note).toMatch(/AppointmentConfirmed/)
  })
})

describe('scoreSetupDecisionWindow — Meta post-action delivery remains diagnostic', () => {
  const good = { postSpend: 800, postBookings: 20, postCpa: 40, activeDays: 7, attributionCoverage: 0.8, maxCpa: 100 }

  it('thin data → inconclusive, never decisive', () => {
    const s = scoreSetupDecisionWindow({ ...good, postSpend: 12, postBookings: 1, activeDays: 2 })
    expect(s.outcome).toBe('inconclusive')
    expect(s.dataSufficient).toBe(false)
  })

  it('neither efficient nor degraded Meta CPA becomes a causal commercial verdict', () => {
    expect(scoreSetupDecisionWindow(good).outcome).toBe('inconclusive')
    expect(scoreSetupDecisionWindow(good).confidence).toBe('low')
    expect(scoreSetupDecisionWindow(good).estimateOnly).toBe(true)
    expect(scoreSetupDecisionWindow({ ...good, postSpend: 3_000, postCpa: 150 }).outcome).toBe('inconclusive')
  })

  it('low GA4 coverage remains diagnostic at low confidence', () => {
    const s = scoreSetupDecisionWindow({ ...good, attributionCoverage: 0.2 })
    expect(s.estimateOnly).toBe(true)
    expect(s.confidence).toBe('low')
    expect(s.note).toMatch(/diagnostic only|incremental contribution/i)
  })
})

describe('resolveLedgerEntityRef — setup decisions score against THEIR entity, not the account', () => {
  const base = { entity_type: 'adset', entity_key: 'slug-key', campaign_id: null, adset_id: null, ad_id: null }

  it('level-specific columns win', () => {
    expect(resolveLedgerEntityRef({ ...base, adset_id: '2384' })).toEqual({ idCol: 'meta_adset_id', metaEntityId: '2384' })
    expect(resolveLedgerEntityRef({ ...base, ad_id: '99', adset_id: '2384' })).toEqual({ idCol: 'meta_ad_id', metaEntityId: '99' })
  })

  it('a NUMERIC entity_key is a real Meta id — mapped via entity_type (fixes the dead-linkage bug)', () => {
    expect(resolveLedgerEntityRef({ ...base, entity_key: '100000000000010' })).toEqual({ idCol: 'meta_adset_id', metaEntityId: '100000000000010' })
    expect(resolveLedgerEntityRef({ ...base, entity_type: 'campaign', entity_key: '555' })).toEqual({ idCol: 'meta_campaign_id', metaEntityId: '555' })
  })

  it('slug/account keys → null (account-level scoring, labeled in the note)', () => {
    expect(resolveLedgerEntityRef(base)).toBeNull()
    expect(resolveLedgerEntityRef({ ...base, entity_type: 'account', entity_key: 'account' })).toBeNull()
  })
})

describe('GA4 outage fails CLOSED for learning', () => {
  it('GA4_ERROR_COVERAGE forces estimate-only on any decisive lesson (flag AND ledger scorers)', () => {
    expect(GA4_ERROR_COVERAGE).toBe(0)
    const flag = scoreFlag('winner', null, 800, 20, 40, GA4_ERROR_COVERAGE, 7)
    expect(flag.estimateOnly).toBe(true)
    expect(flag.confidence).toBe('low')
    const ledger = scoreSetupDecisionWindow({ postSpend: 800, postBookings: 20, postCpa: 40, activeDays: 7, attributionCoverage: GA4_ERROR_COVERAGE, maxCpa: 100 })
    expect(ledger.estimateOnly).toBe(true)
  })
})

describe('creative_refresh keeps delivery context diagnostic', () => {
  const fatigued = {
    spend: 200, cpl: null, ctr: 1.2, frequency: 4.2, impressions: 20000, leads: 0, roas: null,
    window_days: 7, entity_age_days: 20, audience_type: 'professional' as const, peak_ctr: 2.0,
  }

  it('a favorable modelled CPA cannot prove fatigue or a spend response', () => {
    const flag = evaluateFlag({ ...fatigued, cpa: 52, bookings: 4 })
    expect(flag?.flag_type).toBe('creative_refresh')
    expect(flag?.reason).toMatch(/\$52\.00 CPA/)
    // The rule no longer authors action copy. The candidate must classify this as a
    // CREATIVE refresh (not a money action), and the authority-rendered copy must not instruct a spend
    // change — which is the stronger form of the old "do NOT pause" assertion.
    expect(flag?.candidate.kind).toBe('creative_refresh')
    const rendered = renderFlagAction(flag!, 'calendar_period_signal')
    expect(rendered.isMoneyAction).toBe(false)
    expect(rendered.tier).toBe('owner_review')
    expect(assertsMoneyAuthority(rendered.copy)).toBe(false)
    expect(flag?.candidate.observation).toMatch(/cause and response are not established|neither the cause nor a refresh response is proven/i)
    expect(flag?.candidate.observation).not.toMatch(/withdraw|pause|scale/i)
  })

  it('a non-converting fatigued ad is honest about zero bookings', () => {
    const flag = evaluateFlag({ ...fatigued, cpa: null, bookings: 0 })
    expect(flag?.flag_type).toBe('creative_refresh')
    expect(flag?.reason).toMatch(/No Meta-modelled conversions in the window/)
  })
})
