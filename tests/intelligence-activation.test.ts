import { describe, it, expect } from 'vitest'
import { learningStatus, outcomeLearningLabel } from '@/lib/recommendations/learning-status'
import { summarizeIntelligence, type RecSummaryRow } from '@/lib/recommendations/intelligence-summary'

// tests for the activation/visibility layer: the learning-status chip states, the outcome
// review gate labels, and the intelligence rollup. These prove the UI never overstates and that the
// human review gate is honored.

describe('learningStatus (open recommendation chip) — never overstates', () => {
  it('external + gate-demoted → external inspiration only', () => {
    expect(learningStatus({ external_knowledge_used: ['JonLoomer: broad works'], gate_decision: 'downgrade_to_hypothesis' }).state).toBe('external_inspiration')
  })
  it('gate-demoted without external → hypothesis only', () => {
    expect(learningStatus({ gate_decision: 'downgrade_to_hypothesis' }).state).toBe('hypothesis')
  })
  it('attribution warning OR low coverage → attribution unclear', () => {
    expect(learningStatus({ attribution_warning: 'coverage 20%' }).state).toBe('attribution_unclear')
    expect(learningStatus({ attribution_confidence: 0.3 }).state).toBe('attribution_unclear')
  })
  it('low-data / insufficient → not enough data', () => {
    expect(learningStatus({ low_data_warning: 'only $12' }).state).toBe('not_enough_data')
    expect(learningStatus({ confidence_label: 'insufficient' }).state).toBe('not_enough_data')
  })
  it('learning_eligibility true → eligible', () => {
    expect(learningStatus({ learning_eligibility: true, confidence_label: 'high' }).state).toBe('eligible')
  })
  it('grounded read/keep with nothing flagged → no outcome data yet', () => {
    expect(learningStatus({ learning_eligibility: false, confidence_label: 'high' }).state).toBe('no_outcome_yet')
  })
  it('precedence: external inspiration wins over thin-data', () => {
    expect(learningStatus({ external_knowledge_used: ['x'], gate_decision: 'downgrade_to_hypothesis', low_data_warning: 'thin', attribution_confidence: 0.9 }).state).toBe('external_inspiration')
  })
})

describe('outcomeLearningLabel (review gate) — trusted only after approval', () => {
  it('worked + approved → learned pattern', () => {
    expect(outcomeLearningLabel({ outcome: 'worked', review_status: 'approved', metric_name: 'causal_incremental_contribution' }).state).toBe('learned')
    // A row stored before the rename reads as the same metric.
    expect(outcomeLearningLabel({ outcome: 'worked', review_status: 'approved', metric_name: 'causal_incremental_contribution_dollars' }).state).toBe('learned')
    expect(outcomeLearningLabel({ outcome: 'worked', review_status: 'approved', metric_name: 'cpa' }).state).toBe('attribution_unclear')
  })
  it('worked + pending → pending review (NOT learned)', () => {
    const l = outcomeLearningLabel({ outcome: 'worked', review_status: 'pending', metric_name: 'causal_incremental_contribution' })
    expect(l.state).toBe('pending_review')
    expect(l.label).toMatch(/pending review/i)
  })
  it('estimate-only never becomes a trusted learning even if approved', () => {
    expect(outcomeLearningLabel({ outcome: 'worked', review_status: 'approved', estimate_only: true }).state).toBe('attribution_unclear')
  })
  it('inconclusive is never a win or a loss', () => {
    expect(outcomeLearningLabel({ outcome: 'inconclusive', review_status: 'approved' }).state).toBe('inconclusive')
  })
  it('rejected → not learned', () => {
    expect(outcomeLearningLabel({ outcome: 'failed', review_status: 'rejected' }).state).toBe('no_outcome_yet')
  })
})

describe('summarizeIntelligence rollups', () => {
  const recs: RecSummaryRow[] = [
    { confidence_label: 'high', risk_level: 'high', learning_eligibility: true },
    { confidence_label: 'medium', risk_level: 'medium', gate_decision: 'downgrade_to_hypothesis' },
    { confidence_label: 'insufficient', risk_level: 'low', low_data_warning: 'thin' },
    { confidence_label: 'low', risk_level: 'low', attribution_confidence: 0.2 },
  ]
  const today = '2026-07-01'

  it('counts confidence, risk, and learning posture', () => {
    const s = summarizeIntelligence({ recs, outcomes: [], insights: [], benchmarkSeeded: false, writeModeEnabled: false, today })
    expect(s.totalOpen).toBe(4)
    expect(s.confidence).toEqual({ high: 1, medium: 1, low: 1, insufficient: 1 })
    expect(s.risk).toEqual({ high: 1, medium: 1, low: 2 })
    expect(s.posture.eligible).toBe(1)
    expect(s.posture.hypothesis).toBe(1)
    expect(s.posture.not_enough_data).toBe(1)
    expect(s.posture.attribution_unclear).toBe(1)
  })

  it('needsReview counts only decisive, non-estimate, pending outcomes', () => {
    const s = summarizeIntelligence({
      recs: [],
      outcomes: [
        { outcome: 'worked', review_status: 'pending', estimate_only: false, metric_name: 'causal_incremental_contribution' }, // needs review
        { outcome: 'worked', review_status: 'approved', estimate_only: false, metric_name: 'causal_incremental_contribution' }, // already learned
        { outcome: 'worked', review_status: 'pending', estimate_only: true },   // estimate-only, not reviewable
        { outcome: 'inconclusive', review_status: 'pending', estimate_only: false }, // not decisive
      ],
      insights: [], benchmarkSeeded: false, writeModeEnabled: false, today,
    })
    expect(s.outcomes.needsReview).toBe(1)
    expect(s.outcomes.approved).toBe(1)
    expect(s.outcomes.pending).toBe(3)
  })

  it('classifies expert insights active vs expired vs not-applicable, and reports benchmark/write-mode', () => {
    const s = summarizeIntelligence({
      recs: [], outcomes: [],
      insights: [
        { applies_to_account: true, expires_at: null, summary: 'Broad + Advantage+ trending', title: null, published_at: '2026-06-30' },
        { applies_to_account: true, expires_at: '2026-01-01', summary: 'stale', title: null, published_at: '2025-12-01' }, // expired
        { applies_to_account: false, expires_at: null, summary: 'irrelevant', title: null, published_at: '2026-06-30' }, // not applicable
      ],
      benchmarkSeeded: false, writeModeEnabled: false, today,
    })
    expect(s.expertInsights.active).toBe(1)
    expect(s.expertInsights.expired).toBe(1)
    expect(s.expertInsights.latest?.text).toMatch(/Broad/)
    expect(s.benchmark).toMatch(/^neutral/)
    expect(s.writeMode).toBe('off')
  })
})
