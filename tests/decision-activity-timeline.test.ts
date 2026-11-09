import { describe, expect, it } from 'vitest'
import { buildDecisionActivityTimeline } from '@/lib/decisions/activity-timeline'

describe('decision activity timeline', () => {
  it('keeps owner decision and manual implementation as separate immutable events', () => {
    const entries = buildDecisionActivityTimeline({
      changes: [],
      ledger: [],
      decisions: [{
        id: 'decision-1',
        recommendation_id: 'rec-1',
        recommendation_type: 'scale',
        entity_key: 'campaign-1',
        user_decision: 'accepted',
        decision_note: null,
        decision_date: '2026-08-21T12:00:00Z',
        action_taken: true,
        action_taken_date: '2026-08-22T12:00:00Z',
        follow_up_date: '2026-08-29',
      }],
      outcomes: [],
    })

    expect(entries.map((entry) => entry.kind)).toEqual(['manual_implementation', 'owner_decision'])
    expect(entries[0]?.linked_ids).toEqual({ decision_id: 'decision-1', recommendation_id: 'rec-1' })
    expect(entries[1]?.detail).toMatch(/does not mean implemented/i)
  })

  it('links outcome review back to its durable source', () => {
    const [entry] = buildDecisionActivityTimeline({
      changes: [],
      ledger: [],
      decisions: [],
      outcomes: [{
        id: 'outcome-1', source_id: 'rec-1', recommendation: 'Hold', outcome: 'worked',
        outcome_note: 'Signal stayed stable.', review_status: 'approved', reviewed_at: '2026-08-25T12:00:00Z',
        evaluated_at: '2026-08-24T12:00:00Z', recommended_on: '2026-08-14',
      }],
    })

    expect(entry.kind).toBe('outcome_review')
    expect(entry.linked_ids).toEqual({ outcome_id: 'outcome-1', source_id: 'rec-1' })
  })

  it('does not place checkout or return language in the owner Activity timeline', () => {
    const entries = buildDecisionActivityTimeline({
      changes: [{
        id: 'change-1', action_type: 'scale', entity_level: 'adset', meta_entity_id: 'adset-1',
        reason: 'Raise checkout return after Acuity amount paid review.', risk_level: 'medium',
        status: 'pending', created_at: '2026-08-21T12:00:00Z',
      }],
      ledger: [], decisions: [], outcomes: [],
    })

    expect(entries[0]?.detail).toMatch(/Meta delivery rationale/i)
    expect(entries[0]?.detail).not.toMatch(/acuity|checkout|return|amount paid/i)
  })

  it('shows an owner-initiated change with its preview and initiator (ADR-059), and links a rollback to its original', () => {
    const [entry] = buildDecisionActivityTimeline({
      changes: [{
        id: 'change-2', action_type: 'adjust_budget', entity_level: 'adset', meta_entity_id: 'adset-1',
        reason: 'Owner-initiated from a Maxx decision.', risk_level: 'high', status: 'executed', created_at: '2026-11-08T12:00:00Z',
        initiated_by: 'owner', preview: 'Lower ad set "Broad" daily budget $40.00 → $30.00 (−25.0%).', rollback_of: 'change-1',
      }],
      ledger: [], decisions: [], outcomes: [],
    })
    expect(entry.title).toBe('your rollback · adjust budget')
    expect(entry.detail).toBe('Lower ad set "Broad" daily budget $40.00 → $30.00 (−25.0%). You initiated this change.')
    expect(entry.linked_ids).toEqual({ change_request_id: 'change-2', meta_entity_id: 'adset-1', rollback_of: 'change-1' })
  })
})
