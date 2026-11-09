import { describe, it, expect } from 'vitest'
import { defaultManifest, entityKeyForSetup, SETTING_LABELS } from '@/lib/recommendations/manifest'
import { unresolvedConflicts, historyForEntity, currentValueOf, type LedgerRow } from '@/lib/recommendations/setup-ledger'
import { evaluateConflict } from '@/lib/recommendations/conflict-guard'

// UI surfaces — the pure logic behind the launch manifest and the conflict/history views.
// A context-free manifest must fail closed: objective/event/page/audience settings come from an approved
// CampaignPlan, not a universal booking doctrine. The view selectors must never hide an unresolved switch.

function row(over: Partial<LedgerRow>): LedgerRow {
  return {
    id: 'R-' + Math.abs(JSON.stringify(over).split('').reduce((a, c) => a + c.charCodeAt(0), 0)),
    entity_type: 'campaign',
    entity_key: 'example-studio-launch',
    entity_name: 'Example Studio — Launch',
    setting_category: 'budget',
    setting_name: 'Budget',
    previous_value: null,
    proposed_value: null,
    final_value: '$30/day',
    actual_launched_value: null,
    origin: 'launch_setup',
    reason: null,
    user_decision: null,
    decision_note: null,
    decided_by: null,
    action_taken: false,
    conflicts_with_prior: false,
    prior_decision_id: null,
    prior_deprecated: false,
    change_summary: null,
    why_changed: null,
    switch_risk: null,
    follow_up_date: null,
    created_at: '2026-07-01T00:00:00Z',
    ...over,
  }
}

describe('defaultManifest — refuses to invent a campaign without an approved plan', () => {
  const m = defaultManifest('2026-07-01')

  it('blocks every setting until an approved CampaignPlan supplies it', () => {
    for (const row of m) {
      expect(row.proposal_status).toBe('blocked')
      expect(row.blocker_codes).toContain('campaign_plan_missing')
      expect(row.proposed_value).toMatch(/^BLOCKED —/)
    }
  })

  it('does not prescribe /book, Book Now, or lookalikes as universal launch settings', () => {
    const planningRows = m.filter((r) => ['audience', 'creative', 'landing_page'].includes(r.setting_category))
    for (const row of planningRows) {
      expect(row.proposed_value).not.toMatch(/example-studio\.com\/book|CTA = Book Now|1–2% LAL/i)
    }
  })

  it('the high-stakes rows carry "do not change too soon" switch risks', () => {
    for (const cat of ['optimization_event', 'conversion_event', 'attribution_window', 'budget']) {
      expect(m.find((r) => r.setting_category === cat)!.switch_risk).toBeTruthy()
    }
  })

  it('does not manufacture a review date or paste-ready threshold', () => {
    expect(m.find((r) => r.setting_category === 'follow_up')!.proposed_value).not.toMatch(/2026-07-08/)
    const thresh = m.find((r) => r.setting_category === 'min_data_threshold')!
    expect(thresh.proposed_value).toMatch(/^BLOCKED —/)
    expect(thresh.proposed_value).not.toMatch(/\$20|3d|3-day|≥ 3/)
  })

  it('states URL-parameter evidence needs without emitting a canonical template', () => {
    const utm = m.find((r) => r.setting_category === 'utm')!
    expect(utm.proposed_value).toMatch(/^BLOCKED —/)
    expect(utm.proposed_value).not.toMatch(/utm_source|campaign\.id|adset\.id|ad\.id/)
    expect(utm.reason).toMatch(/readable names.*immutable Meta IDs/i)
  })

  it('every manifest row has a human label registered', () => {
    for (const r of m) expect(SETTING_LABELS[r.setting_category]).toBeTruthy()
  })
})

describe('entityKeyForSetup (pure module, re-exported for server callers)', () => {
  it('slugs planned names and passes ids through', () => {
    expect(entityKeyForSetup(null, 'Example Studio — Launch')).toBe('example-studio-launch')
    expect(entityKeyForSetup('camp_9', 'ignored')).toBe('camp_9')
    expect(entityKeyForSetup(null, null)).toBe('account')
  })
})

describe('currentValueOf — what a row currently stands for (the conflict baseline value)', () => {
  it('launched > chosen > proposed > null', () => {
    expect(currentValueOf({ actual_launched_value: 'A', final_value: 'B', proposed_value: 'C' })).toBe('A')
    expect(currentValueOf({ actual_launched_value: null, final_value: 'B', proposed_value: 'C' })).toBe('B')
    expect(currentValueOf({ actual_launched_value: null, final_value: null, proposed_value: 'C' })).toBe('C')
    expect(currentValueOf({ actual_launched_value: null, final_value: null, proposed_value: null })).toBeNull()
  })

  it('CRITICAL regression: a manual action (actual_launched_value only) still triggers the conflict guard', () => {
    // A manual action stores only what was launched — final_value is null. The baseline must coalesce,
    // or every switch after a manual action is silent.
    const manualRow = { actual_launched_value: '7-day click', final_value: null, proposed_value: null }
    const c = evaluateConflict(
      { setting_category: 'attribution_window', final_value: currentValueOf(manualRow) },
      { setting_category: 'attribution_window', proposed_value: '1-day click' }
    )
    expect(c.conflicts).toBe(true)
    expect(c.is_high_stakes).toBe(true)
  })
})

describe('unresolvedConflicts — resolution is marked on the row; a pending switch is never hidden', () => {
  const prior = row({ id: 'PRIOR', setting_category: 'optimization_event', final_value: 'Landing Page Views' })
  const conflicting = row({
    id: 'NEW',
    setting_category: 'optimization_event',
    final_value: 'AppointmentConfirmed',
    conflicts_with_prior: true,
    prior_decision_id: 'PRIOR',
  })

  it('a flagged, undecided switch is unresolved', () => {
    expect(unresolvedConflicts([prior, conflicting]).map((r) => r.id)).toEqual(['NEW'])
  })

  it('an approved switch (flag cleared on the row by PATCH approve_switch) is resolved', () => {
    expect(unresolvedConflicts([{ ...prior, prior_deprecated: true }, { ...conflicting, conflicts_with_prior: false }])).toHaveLength(0)
  })

  it('the prior row being retired ALONE does not hide the pending switch (safe: explicit resolution only)', () => {
    expect(unresolvedConflicts([{ ...prior, prior_deprecated: true }, conflicting]).map((r) => r.id)).toEqual(['NEW'])
  })

  it('rejecting the new decision (keep prior) resolves it', () => {
    expect(unresolvedConflicts([prior, { ...conflicting, user_decision: 'rejected' as const }])).toHaveLength(0)
  })

  it('prior row outside the fetched window → still surfaced (no lookup dependence)', () => {
    expect(unresolvedConflicts([conflicting])).toHaveLength(1)
  })

  it('non-conflicting rows are never included', () => {
    expect(unresolvedConflicts([prior])).toHaveLength(0)
  })
})

describe('historyForEntity — key match with name fallback', () => {
  const rows = [
    row({ id: 'A', entity_key: 'ad_123', entity_name: 'Holiday promo' }),
    row({ id: 'B', entity_key: 'example-studio-launch', entity_name: 'Example Studio — Launch' }),
    row({ id: 'C', entity_key: 'account', entity_name: null }),
  ]
  it('matches the stable key', () => {
    expect(historyForEntity(rows, 'ad_123').map((r) => r.id)).toEqual(['A'])
  })
  it('falls back to the entity name (manual rows may use Meta ids while recs use DB ids)', () => {
    expect(historyForEntity(rows, 'db-uuid-999', 'Holiday promo').map((r) => r.id)).toEqual(['A'])
  })
  it('the name fallback is constrained by entity_type when given (same-named entities at different levels)', () => {
    expect(historyForEntity(rows, 'db-uuid-999', 'Holiday promo', 'campaign').map((r) => r.id)).toEqual(['A']) // rows are campaign-typed
    expect(historyForEntity(rows, 'db-uuid-999', 'Holiday promo', 'ad')).toHaveLength(0)
  })
  it('no match → empty (an empty name never matches everything)', () => {
    expect(historyForEntity(rows, 'nope', '')).toHaveLength(0)
    expect(historyForEntity(rows, 'nope', null)).toHaveLength(0)
  })
})
