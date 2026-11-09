import './_support/outcome-noun-booking'
import { describe, expect, it } from 'vitest'
import { recToRow } from '@/lib/recommendations/store'
import {
  buildRecommendationMetricClaimBindings,
} from '@/lib/recommendations/metric-claim-binding'
import { flagToRecommendationInput } from '@/lib/recommendations/generate'
import type { Recommendation } from '@/lib/recommendations/types'

const FLAG_ID = '00000000-0000-4000-8000-000000001231'
const FLAG_GENERATION_ID = '00000000-0000-4000-8000-000000001232'

function recommendation(): Recommendation {
  return {
    recommendation_type: 'investigate',
    target_entity_type: 'adset',
    target_entity_id: '00000000-0000-4000-8000-000000001233',
    target_entity_name: 'Prospecting',
    observed_fact: 'CPA is above the account target.',
    metric_values: [
      { name: 'CPA', value: 72, unit: '$', source: 'meta_api' },
      { name: 'Spend', value: 360, unit: '$', source: 'meta_api' },
      { name: 'Bookings', value: 5, unit: 'count', source: 'meta_api' },
    ],
    date_range: { start: '2026-08-15', end: '2026-08-21' },
    data_sources: ['meta_api', 'flag_engine'],
    confidence_score: 0.4,
    confidence_label: 'low',
    risk_level: 'medium',
    evidence_summary: 'CPA=$72 (meta_api), Spend=$360 (meta_api)',
    reason_for_action: 'Inspect delivery evidence.',
    what_could_make_this_wrong: ['The source can change on a fresher sync.'],
    approval_required: false,
    action_allowed_now: false,
    low_data_warning: null,
    estimate_warning: null,
    attribution_warning: null,
    no_oscillation_check: { is_reversal_class: false, allowed: true, reason: 'Not applicable.', blocking_factors: [] },
    recommended_next_check_date: null,
    target_evaluation: null,
    grounding: {
      passed: false, decision: 'hold', confidence_score: 0.4, confidence_label: 'low', risk_level: 'medium',
      checks: [], reasons: [], warnings: { low_data: null, estimate: null, attribution: null },
    },
  }
}

describe('recommendation MetricClaim binding', () => {
  it('creates frozen source-backed Meta snapshots and carries their generated IDs into the durable row', () => {
    const rec = recommendation()
    const binding = buildRecommendationMetricClaimBindings({
      sourceFlagId: FLAG_ID,
      sourceFlagGenerationId: FLAG_GENERATION_ID,
      target: { level: 'adset', id: rec.target_entity_id! },
      window: rec.date_range!,
      metrics: rec.metric_values,
      sourceObservedAt: '2026-08-21T10:00:00.000Z',
      asOf: '2026-08-21T12:00:00.000Z',
    })

    expect(binding.claimIds).toHaveLength(3)
    expect(binding.claimIds).not.toContain('recommendation-row-id')
    expect(binding.snapshots).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source_flag_id: FLAG_ID,
        source_flag_generation_id: FLAG_GENERATION_ID,
        snapshot: expect.objectContaining({
          claimId: expect.stringMatching(/^metric_claim:/),
          metricKey: 'meta_delivery.cpa',
          source: {
            system: 'meta', role: 'delivery_truth', evidencePlane: 'meta_delivery',
            head: `flag-generation:${FLAG_GENERATION_ID}`,
          },
          entity: { level: 'adset', id: rec.target_entity_id },
          window: { start: '2026-08-15', end: '2026-08-21', basis: 'closed_account_days', timezone: 'America/New_York' },
          freshness: { state: 'fresh', observedAt: '2026-08-21T10:00:00.000Z', maxAgeHours: 26 },
          maturity: { state: 'not_applicable', matureThrough: null },
          authority: { state: 'diagnostic', policyVersion: 'recommendation_metric_claim_v1' },
          measurementKind: 'derived',
          formula: 'meta_delivery.spend / meta_delivery.bookings',
          coverage: { state: 'complete', numerator: 2, denominator: 2 },
        }),
      }),
    ]))
    expect(Object.isFrozen(binding.snapshots[0].snapshot)).toBe(true)

    const row = recToRow({ ...rec, metric_claim_ids: binding.claimIds }, FLAG_ID)
    expect(row).toMatchObject({ source_flag_id: FLAG_ID, metric_claim_ids: binding.claimIds })
  })

  it('does not bind multi-day frequency because daily insights cannot establish a native period frequency', () => {
    const rec = recommendation()
    const binding = buildRecommendationMetricClaimBindings({
      sourceFlagId: FLAG_ID,
      sourceFlagGenerationId: FLAG_GENERATION_ID,
      target: { level: 'adset', id: rec.target_entity_id! },
      window: rec.date_range!,
      metrics: [{ name: 'Frequency', value: 4.2, unit: 'x', source: 'meta_api' }],
      sourceObservedAt: '2026-08-21T10:00:00.000Z',
      asOf: '2026-08-21T12:00:00.000Z',
    })

    expect(binding).toEqual({ claimIds: [], snapshots: [] })
  })

  it('derives CPA from its frozen spend and modelled-result inputs instead of trusting a duplicate display value', () => {
    const rec = recommendation()
    const binding = buildRecommendationMetricClaimBindings({
      sourceFlagId: FLAG_ID,
      sourceFlagGenerationId: FLAG_GENERATION_ID,
      target: { level: 'adset', id: rec.target_entity_id! },
      window: rec.date_range!,
      metrics: [
        { name: 'CPA', value: 999, unit: '$', source: 'meta_api' },
        { name: 'Spend', value: 360, unit: '$', source: 'meta_api' },
        { name: 'Bookings', value: 5, unit: 'count', source: 'meta_api' },
      ],
      sourceObservedAt: '2026-08-21T10:00:00.000Z',
      asOf: '2026-08-21T12:00:00.000Z',
    })

    expect(binding.snapshots.find((snapshot) => snapshot.source_metric_key === 'cpa')?.snapshot)
      .toMatchObject({ value: 72, formula: 'meta_delivery.spend / meta_delivery.bookings' })
  })

  it('removes legacy multi-day frequency from recommendation action inputs', () => {
    const input = flagToRecommendationInput({
      id: FLAG_ID,
      entity_level: 'adset', campaign_id: 'campaign-id', adset_id: 'adset-id', ad_id: null,
      flag_type: 'creative_refresh', reason: 'Legacy frequency flag', recommended_action: null, watch_next: null,
      window_days: 7,
      evidence: { spend: 100, bookings: 0, frequency: 4.2, window_days: 7 },
    }, 'Prospecting', '2026-08-21')

    expect(input.primary_metric).toEqual({ metric: 'frequency', value: null })
    expect((input.metric_values ?? []).map((metric) => metric.name)).not.toContain('Frequency')
  })

  it('emits no claim IDs when the exact Meta source freshness cannot support an immutable snapshot', () => {
    const rec = recommendation()
    const binding = buildRecommendationMetricClaimBindings({
      sourceFlagId: FLAG_ID,
      sourceFlagGenerationId: FLAG_GENERATION_ID,
      target: { level: 'adset', id: rec.target_entity_id! },
      window: rec.date_range!,
      metrics: rec.metric_values,
      sourceObservedAt: null,
      asOf: '2026-08-21T12:00:00.000Z',
    })

    expect(binding).toEqual({ claimIds: [], snapshots: [] })
  })
})
