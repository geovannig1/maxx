import { describe, expect, it } from 'vitest'
import {
  buildDecisionQueue,
  decisionIdsForCockpit,
  recommendationDecisionForControl,
  visibleDecisionQueue,
  type DecisionQueueProjectionInput,
  type DecisionQueueRecommendationInput,
} from '@/lib/decisions/queue-v2'
import type { RecommendationEvidenceItem } from '@/lib/cockpit/contracts'

const recommendation = (
  overrides: Partial<DecisionQueueRecommendationInput> = {},
): DecisionQueueRecommendationInput => ({
  id: 'rec-1',
  recommendation_type: 'scale',
  target_entity_type: 'campaign',
  target_entity_id: 'campaign-1',
  target_entity_name: 'Cold',
  observed_fact: 'Delivery is stable.',
  reason_for_action: 'Review the evidence before changing budget.',
  date_range_start: '2026-08-14',
  date_range_end: '2026-08-20',
  recommended_next_check_date: '2026-08-24',
  risk_level: 'medium',
  confidence_score: 0.8,
  confidence_label: 'high',
  generated_at: '2026-08-21T12:00:00Z',
  expected_upside: null,
  possible_downside: 'Performance could regress.',
  minimum_data_needed: null,
  action_authority_tier: 'owner_review',
  action_decision_id: 'authority-1',
  metric_claim_ids: ['claim:rec-1'],
  metric_claim_lineage_verified: true,
  decision: null,
  ...overrides,
})

const input = (overrides: Partial<DecisionQueueProjectionInput> = {}): DecisionQueueProjectionInput => ({
  recommendations: [],
  alerts: [],
  tasks: [],
  outcomes: [],
  today: '2026-08-21',
  ...overrides,
})

describe('DecisionQueueItemV2 projection', () => {
  it('keeps owner agreement separate from manual implementation', () => {
    const [item] = buildDecisionQueue(input({
      recommendations: [recommendation({
        decision: {
          user_decision: 'accepted',
          decision_date: '2026-08-21T13:00:00Z',
          action_taken: false,
          action_taken_date: null,
          follow_up_date: null,
        },
      })],
    }))

    expect(item.bucket).toBe('awaiting_implementation')
    expect(item.lifecycle).toBe('owner_decision')
    expect(item.implementation.recorded).toBe(false)
    expect(item.controls).toEqual(['mark_implemented', 'dismiss'])
    expect(item.claim_refs).toEqual(['claim:rec-1'])
    expect(item.authority_decision_id).toBe('authority-1')
  })

  it('projects resolved evidence with snapshot windows and missing-claim placeholders', () => {
    const evidence: RecommendationEvidenceItem[] = [
      {
        claimId: 'claim:rec-1',
        metricKey: 'meta_delivery.spend',
        label: 'Spend',
        value: 1234.56,
        unit: 'money',
        window: { start: '2026-08-14', end: '2026-08-20' },
        sourceSystem: 'meta',
        maturity: 'not_applicable',
        freshness: 'fresh',
        availability: 'available',
        missing: false,
      },
      {
        claimId: 'claim:missing',
        metricKey: 'claim:missing',
        label: 'Referenced claim',
        value: null,
        unit: 'state',
        window: { start: '', end: '' },
        sourceSystem: 'maxx',
        maturity: 'not_applicable',
        freshness: 'unknown',
        availability: 'unavailable',
        missing: true,
      },
    ]
    const [item] = buildDecisionQueue(input({
      recommendations: [recommendation({ evidence })],
    }))

    expect(item.evidence).toHaveLength(2)
    expect(item.evidence[0]).toMatchObject({ claimId: 'claim:rec-1', value: 1234.56, missing: false })
    expect(item.evidence[1]).toMatchObject({ claimId: 'claim:missing', missing: true })
  })

  it('quarantines accepted, snoozed, and implemented rows before their lifecycle branches when durable lineage is incomplete', () => {
    const decisions = [
      { user_decision: 'accepted', action_taken: false, action_taken_date: null, follow_up_date: null },
      { user_decision: 'snoozed', action_taken: false, action_taken_date: null, follow_up_date: '2026-08-28' },
      { user_decision: 'acted_on', action_taken: true, action_taken_date: '2026-08-21T13:00:00Z', follow_up_date: null },
    ]

    const queue = buildDecisionQueue(input({
      recommendations: decisions.map((decision, index) => recommendation({
        id: `rec-incomplete-${index}`,
        action_decision_id: null,
        metric_claim_ids: [],
        metric_claim_lineage_verified: false,
        decision: { ...decision, decision_date: '2026-08-21T13:00:00Z' },
      })),
    }))

    expect(queue.map((item) => item.bucket)).toEqual(['tracking_repair', 'tracking_repair', 'tracking_repair'])
    expect(queue.every((item) => item.lifecycle === 'blocked')).toBe(true)
    expect(queue.every((item) => item.controls.includes('mark_implemented'))).toBe(false)
  })

  it('projects governed decision provenance and owner-loop fields without turning legacy upside prose into an impact claim', () => {
    const [item] = buildDecisionQueue(input({
      recommendations: [recommendation({
        target_entity_type: 'adset',
        target_entity_id: 'adset-1',
        target_entity_name: 'Prospecting',
        target_language: 'Watch whether the ad set remains in the target range at review.',
        authority_version: 5,
        authority_target_level: 'campaign',
        authority_target_id: 'campaign-1',
        current_state: { delivery: 'active' },
        proposed_state: { delivery: 'paused' },
        decision: {
          user_decision: 'accepted',
          decision_date: '2026-08-21T13:00:00Z',
          action_taken: false,
          action_taken_date: null,
          follow_up_date: null,
        },
        learning_eligibility: true,
      })],
    }))

    expect(item.optimization_unit).toEqual({ level: 'campaign', id: 'campaign-1', name: null })
    expect(item.current_state).toEqual({ delivery: 'active' })
    expect(item.proposed_state).toEqual({ delivery: 'paused' })
    expect(item.authority_version).toBe(5)
    expect(item.validity).toEqual({ state: 'valid', review_date: '2026-08-24' })
    expect(item.owner_disposition).toBe('accepted')
    expect(item.outcome_eligible).toBe(false)
    expect(item.expected_observation).toBe('Watch whether the ad set remains in the target range at review.')
  })

  it('maps Agree to accepted intent and only the explicit implementation control to acted_on', () => {
    expect(recommendationDecisionForControl('agree')).toBe('accepted')
    expect(recommendationDecisionForControl('mark_implemented')).toBe('acted_on')
  })

  it('never gives a diagnostic recommendation a money-action control', () => {
    const [item] = buildDecisionQueue(input({
      recommendations: [recommendation({
        recommendation_type: 'tracking_issue',
        action_authority_tier: 'diagnostic_only',
      })],
    }))

    expect(item.bucket).toBe('tracking_repair')
    expect(item.ready).toBe(false)
    expect(item.controls).toEqual(['acknowledge', 'schedule', 'dismiss'])
    expect(item.controls).not.toContain('agree')
    expect(item.controls).not.toContain('mark_implemented')
  })

  it('quarantines a legacy recommendation with no immutable claim lineage', () => {
    const [item] = buildDecisionQueue(input({
      recommendations: [recommendation({ metric_claim_ids: [], metric_claim_lineage_verified: false })],
    }))

    expect(item.bucket).toBe('tracking_repair')
    expect(item.ready).toBe(false)
    expect(item.controls).not.toContain('agree')
  })

  it('projects alerts as notification-only diagnostics', () => {
    const [item] = buildDecisionQueue(input({
      alerts: [{
        id: 'alert-1',
        title: 'Paid booking identity missing',
        message: 'Appointment join coverage is incomplete.',
        alert_type: 'tracking_issue',
        severity: 'critical',
        detected_at: '2026-08-21T11:00:00Z',
        alert_date: '2026-08-21',
        amount_at_risk: 400,
      }],
    }))

    expect(item.bucket).toBe('tracking_repair')
    expect(item.authority).toBe('diagnostic_only')
    expect(item.controls).toEqual(['acknowledge'])
    expect(item.rank_reason).toMatch(/notification-only/i)
  })

  it('puts future snoozes in the snoozed view', () => {
    const [item] = buildDecisionQueue(input({
      recommendations: [recommendation({
        decision: {
          user_decision: 'snoozed',
          decision_date: '2026-08-21T13:00:00Z',
          action_taken: false,
          action_taken_date: null,
          follow_up_date: '2026-08-28',
        },
      })],
    }))

    expect(item.bucket).toBe('snoozed')
    expect(item.lifecycle).toBe('scheduled')
    expect(item.controls).toEqual(['agree', 'dismiss'])
  })

  it('keeps a diagnostic task out of awaiting implementation', () => {
    const [item] = buildDecisionQueue(input({ tasks: [{
      id: 'task-1', title: 'Review account signal', description: null, recommendation: null,
      priority: 'high', status: 'open', due_date: null, created_at: '2026-08-21T12:00:00Z',
      action_authority_tier: 'diagnostic_only', action_decision_id: null,
    }] }))

    expect(item.bucket).toBe('monitoring')
    expect(item.controls).toEqual(['acknowledge', 'schedule', 'dismiss'])
    expect(item.controls).not.toContain('mark_implemented')
  })

  it('caps visible ready actions at three after deterministic ranking', () => {
    const queue = buildDecisionQueue(input({
      recommendations: [
        recommendation({ id: 'rec-d', confidence_score: 0.7 }),
        recommendation({ id: 'rec-b', confidence_score: 0.9, risk_level: 'high' }),
        recommendation({ id: 'rec-c', confidence_score: 0.8 }),
        recommendation({ id: 'rec-a', confidence_score: 0.9, risk_level: 'high' }),
      ],
    }))
    const visible = visibleDecisionQueue(queue, 'needs_review')

    expect(visible.items.map((item) => item.source_id)).toEqual(['rec-a', 'rec-b', 'rec-c'])
    expect(visible.deferred_ready_count).toBe(1)
    expect(visible.items.every((item) => item.rank_reason.length > 0)).toBe(true)
  })

  it('exposes every unresolved critical alert through the alert-focused filter regardless of its normal queue bucket', () => {
    const queue = buildDecisionQueue(input({ alerts: [
      {
        id: 'tracking-critical', title: 'Pixel is not firing', message: 'Repair measurement.', alert_type: 'tracking_issue',
        severity: 'critical', detected_at: '2026-08-21T11:00:00Z', alert_date: '2026-08-21', amount_at_risk: null,
      },
      {
        id: 'spend-spike-critical', title: 'Spend spike', message: 'Inspect delivery.', alert_type: 'spend_spike',
        severity: 'critical', detected_at: '2026-08-21T10:00:00Z', alert_date: '2026-08-21', amount_at_risk: null,
      },
    ] }))

    expect(queue.find((item) => item.source_id === 'tracking-critical')?.bucket).toBe('tracking_repair')
    expect(queue.find((item) => item.source_id === 'spend-spike-critical')?.bucket).toBe('needs_review')
    expect(visibleDecisionQueue(queue, 'needs_review', 'unresolved_critical_alerts').items.map((item) => item.source_id).sort())
      .toEqual(['spend-spike-critical', 'tracking-critical'])
  })

  it('does not promote legacy expected-upside prose into an impact claim', () => {
    const [item] = buildDecisionQueue(input({
      recommendations: [recommendation({ expected_upside: 'ROAS rises 40% and saves $800.' })],
    }))

    expect(item.expected_observation).toBeNull()
  })

  it('withholds worked/failed learning review without a declared contract and action evidence', () => {
    const outcomes = [{
      id: 'outcome-1', recommendation: 'Scale Cold', outcome: 'worked', outcome_note: null,
      review_status: 'pending', recommended_on: '2026-08-14', evaluate_after: '2026-08-21',
      evaluated_at: '2026-08-21T12:00:00Z', estimate_only: false,
      learning_eligibility: false, action_evidence: false,
    }]
    const [item] = buildDecisionQueue(input({ outcomes }))

    expect(item.bucket).toBe('monitoring')
    expect(item.controls).toEqual([])
    expect(item.guardrail).toMatch(/contract.*action evidence/i)
  })

  it('exports the same deterministic decision order for Today deep links', () => {
    const queue = buildDecisionQueue(input({ recommendations: [
      recommendation({ id: 'rec-b', confidence_score: 0.8 }),
      recommendation({ id: 'rec-a', confidence_score: 0.8 }),
    ] }))

    expect(decisionIdsForCockpit(queue)).toEqual({
      decisionIds: ['rec-a', 'rec-b'],
      primaryDecisionId: 'rec-a',
    })
  })

  it('keeps only Meta-safe state in the manual action projection', () => {
    const [item] = buildDecisionQueue(input({
      recommendations: [recommendation({
        current_state: { spend: 90, meta_purchase_roas: 2.4, delivery: 'active' },
        proposed_state: { daily_budget: 90, checkout_value: 500, action: 'increase budget' },
      })],
    }))

    expect(item.current_state).toEqual({ spend: 90, delivery: 'active' })
    expect(item.proposed_state).toEqual({ daily_budget: 90, action: 'increase budget' })
  })

  it('carries engine confidence and the data-sufficiency signal to the owner surface', () => {
    const [item] = buildDecisionQueue(input({
      recommendations: [recommendation({
        confidence_score: 0.42,
        confidence_label: 'low',
        minimum_data_needed: 'Three more days of delivery at the current budget.',
      })],
    }))

    expect(item.confidence).toEqual({ score: 0.42, label: 'low' })
    expect(item.dataNeeded).toBe('Three more days of delivery at the current budget.')
  })

  it('routes data-needed copy through the owner-surface excluded-terms guard', () => {
    const [item] = buildDecisionQueue(input({
      recommendations: [recommendation({ minimum_data_needed: 'Wait for more ROAS observations.' })],
    }))

    expect(item.dataNeeded).toBe('More evidence is required before this can be acted on.')
  })

  it('projects null confidence and data-needed for alerts, tasks, and outcomes', () => {
    const queue = buildDecisionQueue(input({
      alerts: [{
        id: 'alert-1', title: 'Signal', message: 'Check.', alert_type: 'tracking_issue',
        severity: 'high', detected_at: '2026-08-21T11:00:00Z', alert_date: '2026-08-21',
        amount_at_risk: null,
      }],
      tasks: [{
        id: 'task-1', title: 'Review account signal', description: null, recommendation: null,
        priority: 'high', status: 'open', due_date: null, created_at: '2026-08-21T12:00:00Z',
        action_authority_tier: 'diagnostic_only', action_decision_id: null,
      }],
      outcomes: [{
        id: 'outcome-1', recommendation: 'Scale Cold', outcome: 'worked', outcome_note: null,
        review_status: 'pending', recommended_on: '2026-08-14', evaluate_after: '2026-08-21',
        evaluated_at: null, estimate_only: false, learning_eligibility: true, action_evidence: true,
      }],
    }))

    expect(queue.every((item) => item.confidence === null && item.dataNeeded === null)).toBe(true)
  })

  it('never lets confidence influence rank or leak into rank_reason', () => {
    const queue = buildDecisionQueue(input({ recommendations: [
      recommendation({ id: 'rec-b', confidence_score: 0.99, confidence_label: 'high' }),
      recommendation({ id: 'rec-a', confidence_score: 0.1, confidence_label: 'low' }),
    ] }))

    expect(queue.map((item) => item.source_id)).toEqual(['rec-a', 'rec-b'])
    for (const item of queue) {
      expect(item.rank_reason).not.toMatch(/confidence/i)
      expect(item.rank_reason).not.toContain(String(item.confidence?.score ?? ''))
    }
  })
})
