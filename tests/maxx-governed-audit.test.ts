import { describe, expect, it } from 'vitest'
import { createMetricClaim } from '@/lib/cockpit/contracts'
import { resolveAudience, type AudienceRef } from '@/lib/audience/resolver'
import { classifyMaxxAuditFocus } from '@/lib/maxx/audit-focus'
import { buildGovernedAuditEvidence } from '@/lib/maxx/governed-audit'
import { projectInternalFinalActionDecisions } from '@/lib/maxx/governed-audit-runtime'
import type { StoredRecommendation } from '@/lib/recommendations/store'
import { BRIEF_EXPECTATIONS, UNREACHABLE_GATES } from '@/lib/eval/brief-expectations'
import { normalizeAnswerBriefValue, renderAnswerBrief } from '@/lib/maxx/answer-brief'
import { scoreBrief } from '@/lib/eval/brief-rubric'

const cockpitClaim = createMetricClaim({
  claimId: 'meta.spend:2026-08-01:2026-08-20',
  metricKey: 'meta.spend',
  label: 'Meta spend',
  value: 1200,
  unit: 'money',
  formula: null,
  definitionVersion: 1,
  source: {
    system: 'meta', role: 'delivery_truth', head: 'cockpit-head', evidencePlane: 'meta_delivery',
  },
  entity: { level: 'account', id: 'act-1' },
  attributionScope: 'none',
  window: {
    start: '2026-08-01', end: '2026-08-20', basis: 'closed_account_days',
    timezone: 'America/New_York',
  },
  comparison: { method: 'none', window: null },
  asOf: '2026-08-21T12:00:00.000Z',
  availability: { state: 'available', blockerCodes: [] },
  coverage: { state: 'complete', numerator: 20, denominator: 20 },
  maturity: { state: 'settled', matureThrough: '2026-08-20' },
  freshness: { state: 'fresh', observedAt: '2026-08-21T12:00:00.000Z', maxAgeHours: 24 },
  setupFingerprint: 'setup-v1',
  authority: { state: 'context', policyVersion: 'cockpit-v1' },
  measurementKind: 'measured',
  inputClaimIds: [],
})

describe('Maxx governed audit focus', () => {
  it.each([
    ['Audit my current campaign, warm and cold ad sets, tracking changes, and scaling.', 'owner_ads_audit'],
    ['Is my Warm retargeting ad set set up and optimized correctly?', 'adset_setup'],
    ['Are my ad creatives good and diverse enough?', 'creative_quality'],
    ['Am I optimizing for the right conversion event, and is my budget spent well?', 'budget_goal'],
    ['How are the ads doing?', 'general'],
  ] as const)('routes %s to %s', (question, focus) => {
    expect(classifyMaxxAuditFocus(question)).toBe(focus)
  })
})

describe('owner-audit acceptance contract', () => {
  it('enforces every supplied owner evidence plane with no disabled gate', () => {
    expect(BRIEF_EXPECTATIONS['q1-flagship-diagnosis'].requiredPlanes).toEqual([
      'meta_delivery', 'outcome_business', 'ga4_telemetry',
      'paid_association', 'capi_delivery', 'decision',
    ])
    expect(BRIEF_EXPECTATIONS['q1-flagship-diagnosis'].businessTruthMetrics)
      .toEqual(['appointments'])
    expect(BRIEF_EXPECTATIONS['q1-flagship-diagnosis'].mustDeclareUnavailable)
      .toEqual(['paid.cpa', 'paid.roas'])
    expect(UNREACHABLE_GATES).toEqual([])
  })
})

describe('governed audit evidence packet', () => {
  it('preserves each source plane native window instead of relabelling it with the audit window', () => {
    const packet = buildGovernedAuditEvidence({
      focus: 'creative_quality',
      accountId: 'act-1',
      window: { start: '2026-08-01', end: '2026-08-20' },
      asOf: '2026-08-21T12:00:00.000Z',
      cockpit: { claims: [] },
      diagnosis: null,
      reconciliation: {
        window: { from: '2026-07-25', to: '2026-08-19' },
        ga4_available: true,
        utm: {
          ads_total: 2, ads_correct: 2, ads_missing: 0, ads_misconfigured: 0,
          ads_unverified: 0,
        },
        signals: {
          dataset_quality: {
            available: true,
            provenance: {
              apiVersion: 'v25.0',
              respondedAt: '2026-08-20T17:00:00.000Z',
              windowStart: '2026-08-13T17:00:00.000Z',
              windowEnd: '2026-08-20T17:00:00.000Z',
            },
          },
        },
      },
      economics: {
        window: { start: '2026-07-27', end: '2026-08-18' },
        business: { confirmed_appointments: 3, outcome_recorded_checkout_revenue: 100 },
        paid: { cpa: null, revenue_roas: null },
        profit_view: { daily_budget_ceiling: 100 },
      },
      operatingMode: null,
      recommendations: { read_health: 'healthy', count: 0 },
      creative: {
        period: { start: '2026-07-22', end: '2026-08-21' },
        format_mix: {
          total_creatives: 2,
          shares: [{ format: 'video' }, { format: 'static' }],
        },
        ad_delivery_sub_statuses: [{
          ad_id: 'ad-1', ad_name: 'Video One',
          delivery_sub_status: {
            read_available: true,
            payload: { status: 'warning', substatuses: ['creative_fatigue'] },
            synced_at: '2026-08-20T16:00:00.000Z',
          },
        }],
      },
    })

    const byKey = new Map(packet.claims.map((claim) => [claim.metricKey, claim]))
    expect(byKey.get('appointments')?.window).toMatchObject({
      start: '2026-07-27', end: '2026-08-18', basis: 'booking_created_date_et',
    })
    expect(byKey.get('paid.cpa')?.window).toMatchObject({
      start: '2026-07-27', end: '2026-08-18',
    })
    expect(byKey.get('ga4.confirmation_telemetry_status')?.window).toMatchObject({
      start: '2026-07-25', end: '2026-08-19',
    })
    expect(byKey.get('capi.dataset_quality')?.window).toMatchObject({
      start: '2026-08-13', end: '2026-08-20', basis: 'interaction_date_et',
    })
    expect(byKey.get('capi.dataset_quality')?.freshness.observedAt)
      .toBe('2026-08-20T17:00:00.000Z')
    expect(byKey.get('tracking.utm_health')?.source).toMatchObject({
      system: 'meta', evidencePlane: 'meta_delivery',
    })
    expect(byKey.get('tracking.utm_health')?.window).toMatchObject({
      start: '2026-08-21', end: '2026-08-21', basis: 'partial_today',
    })
    expect(byKey.get('meta.creative.format_mix')?.window).toMatchObject({
      start: '2026-07-22', end: '2026-08-21', basis: 'closed_account_days',
    })
    expect(byKey.get('meta.ad.delivery_sub_status')?.value)
      .toBe('Meta status warning; substatuses: creative_fatigue')
    expect(byKey.get('meta.ad.delivery_sub_status')?.freshness.observedAt)
      .toBe('2026-08-20T16:00:00.000Z')
  })

  it('turns the owner audit into citable multi-plane facts, explicit unavailability, and a decision boundary', () => {
    const packet = buildGovernedAuditEvidence({
      focus: 'owner_ads_audit',
      accountId: 'act-1',
      window: { start: '2026-08-01', end: '2026-08-20' },
      asOf: '2026-08-21T12:00:00.000Z',
      cockpit: { claims: [cockpitClaim] },
      diagnosis: {
        verdict: 'still_learning',
        conversions: { meta_modelled_bookings: 24 },
        adsets_detail: [
          {
            id: 'warm-1', name: 'Warm', learning_phase: 'LEARNING_LIMITED',
            learning_conversions: 2, results_to_exit: 48,
            delivery_sub_status: {
              read_available: true,
              payload: { status: 'warning', substatuses: ['auction_overlap'] },
              synced_at: '2026-08-20T15:00:00.000Z',
            },
          },
          {
            id: 'cold-1', name: 'Cold', learning_phase: 'LEARNING',
            learning_conversions: 3, results_to_exit: 47,
            delivery_sub_status: {
              read_available: true, payload: null,
              synced_at: '2026-08-20T15:37:00.000Z',
            },
          },
        ],
        audiences: [
          { adset_id: 'cold-1', adset_name: 'Cold', resolution: { composition: 'broad_advantage' } },
          { adset_id: 'warm-1', adset_name: 'Warm', resolution: { composition: 'mixed' } },
        ],
      },
      reconciliation: {
        ga4_available: true,
        utm: {
          ads_total: 2, ads_correct: 1, ads_missing: 1, ads_misconfigured: 0,
          ads_unverified: 0,
        },
        signals: { dataset_quality: { available: false, reason: 'token unavailable' } },
      },
      economics: {
        business: {
          confirmed_appointments: 56,
          outcome_recorded_checkout_revenue: 4200,
          amount_paid_coverage: { withRecordedAmount: 56, total: 56 },
        },
        paid: { cpa: null, revenue_roas: null },
        profit_view: { daily_budget_ceiling: 100 },
      },
      operatingMode: {
        mode: { canRecommendBudgetScale: false, budgetVerdict: 'insufficient_evidence' },
      },
      recommendations: {
        read_health: 'healthy', count: 0, persisted_final_action_decisions: [],
      },
      creative: null,
    })

    const claims = new Map(packet.claims.map((claim) => [claim.claimId, claim]))
    const required = packet.required_claim_ids.map((id) => claims.get(id)!)
    expect(new Set(required.map((claim) => claim.source.evidencePlane))).toEqual(new Set([
      'meta_delivery', 'outcome_business', 'ga4_telemetry', 'paid_association', 'capi_delivery', 'decision',
    ]))
    expect(required.some((claim) => claim.entity.level === 'adset' && claim.entity.id === 'warm-1')).toBe(true)
    expect(required.some((claim) => claim.entity.level === 'adset' && claim.entity.id === 'cold-1')).toBe(true)
    expect(required.find((claim) => claim.metricKey === 'meta.adset.audience_composition'
      && claim.entity.id === 'warm-1')?.value).toBe('Mixed acquisition and retargeting')
    expect(required.find((claim) => claim.metricKey === 'meta.adset.audience_composition'
      && claim.entity.id === 'cold-1')?.value).toBe('Broad Advantage+ acquisition')
    expect(required.find((claim) => claim.metricKey === 'meta.adset.delivery_sub_status'
      && claim.entity.id === 'warm-1')?.value)
      .toBe('Meta status warning; substatuses: auction_overlap')
    expect(required.find((claim) => claim.metricKey === 'meta.adset.delivery_sub_status'
      && claim.entity.id === 'cold-1')?.value).toBe('Meta reported no delivery sub-status')
    expect(required.some((claim) => claim.metricKey === 'meta.spend')).toBe(true)
    expect(required.find((claim) => claim.metricKey === 'paid.cpa')?.availability.state).toBe('unavailable')
    expect(required.find((claim) => claim.metricKey === 'paid.roas')?.availability.state).toBe('unavailable')
    expect(required.find((claim) => claim.metricKey === 'decision.scale_authority')?.value)
      .toMatch(/not authorized/i)
    expect(packet.persisted_final_action_decisions).toEqual([])

    const brief = normalizeAnswerBriefValue({
      summary: 'governed_claims', observations: [], action_decision_ids: [],
      unavailable_claim_ids: [], next_check: null,
    }, claims, packet.required_claim_ids)
    expect(scoreBrief(
      BRIEF_EXPECTATIONS['q1-flagship-diagnosis'], brief, claims, new Set(),
    ).admissible).toBe(true)
  })

  it('never turns a missing Acuity read or CAPI token into zero', () => {
    const packet = buildGovernedAuditEvidence({
      focus: 'owner_ads_audit',
      accountId: 'act-1',
      window: { start: '2026-08-01', end: '2026-08-20' },
      asOf: '2026-08-21T12:00:00.000Z',
      cockpit: { claims: [] },
      diagnosis: null,
      reconciliation: {
        ga4_available: false,
        utm: null,
        signals: { dataset_quality: { available: false, reason: 'META_ACCESS_TOKEN is not configured' } },
      },
      economics: {
        business: { confirmed_appointments: null, outcome_recorded_checkout_revenue: null },
        paid: { cpa: null, revenue_roas: null },
        profit_view: { daily_budget_ceiling: 100 },
      },
      operatingMode: null,
      recommendations: { read_health: 'unavailable', count: 0 },
      creative: null,
    })
    const byKey = new Map(packet.claims.map((claim) => [claim.metricKey, claim]))
    expect(byKey.get('appointments')?.value).toBeNull()
    expect(byKey.get('appointments')?.availability.state).toBe('unavailable')
    expect(byKey.get('capi.dataset_quality')?.value).toBeNull()
    expect(byKey.get('capi.dataset_quality')?.availability.state).toBe('unavailable')
  })

  it('marks UTM health unavailable when every scoped ad is unverified', () => {
    const packet = buildGovernedAuditEvidence({
      focus: 'owner_ads_audit', accountId: 'act-1',
      window: { start: '2026-08-01', end: '2026-08-20' },
      asOf: '2026-08-21T12:00:00.000Z', cockpit: { claims: [] }, diagnosis: null,
      reconciliation: {
        ga4_available: false,
        utm: {
          ads_total: 5, ads_correct: 0, ads_missing: 0, ads_misconfigured: 0,
          ads_unverified: 5, coverage: null,
        },
        signals: { dataset_quality: { available: false } },
      },
      economics: null, operatingMode: null,
      recommendations: { read_health: 'healthy', count: 0 }, creative: null,
    })
    const utm = packet.claims.find((claim) => claim.metricKey === 'tracking.utm_health')
    expect(utm).toMatchObject({
      value: null,
      availability: { state: 'unavailable', blockerCodes: ['utm_health_unverified'] },
      source: { system: 'meta', evidencePlane: 'meta_delivery' },
    })
  })

  it('renders included, excluded, failed, and unknown audience readiness without collapsing them', () => {
    const observedAt = '2026-08-21T11:00:00.000Z'
    const accountId = 'act-1'
    const audience = (
      id: string,
      operationStatus: unknown,
      deliveryStatus: unknown,
    ): AudienceRef => ({
      id, name: id, subtype: 'WEBSITE', accountId,
      operationStatus, deliveryStatus, lastSyncedAt: observedAt,
    })
    const warm = resolveAudience({
      adsetName: 'Warm', targetingSyncedAt: observedAt, accountId,
      targeting: {
        custom_audiences: [{ id: 'included-op-433' }],
        excluded_custom_audiences: [{ id: 'excluded-delivery-300' }],
        targeting_automation: { advantage_audience: 0 },
      },
      audiencesById: {
        'included-op-433': audience('included-op-433', { code: 433 }, { code: 200 }),
        'excluded-delivery-300': audience(
          'excluded-delivery-300', { code: 200 }, { code: 300 },
        ),
      },
    }, Date.parse('2026-08-21T12:00:00.000Z'))
    const cold = resolveAudience({
      adsetName: 'Cold', targetingSyncedAt: observedAt, accountId,
      targeting: {
        custom_audiences: [{ id: 'included-operation-absent' }],
        targeting_automation: { advantage_audience: 0 },
      },
      audiencesById: {
        'included-operation-absent': audience(
          'included-operation-absent', null, { code: 200 },
        ),
      },
    }, Date.parse('2026-08-21T12:00:00.000Z'))
    const packet = buildGovernedAuditEvidence({
      focus: 'owner_ads_audit', accountId,
      window: { start: '2026-08-01', end: '2026-08-20' },
      asOf: '2026-08-21T12:00:00.000Z', cockpit: { claims: [] },
      diagnosis: {
        adsets_detail: [
          { id: 'warm-1', name: 'Warm', learning_phase: 'LEARNING' },
          { id: 'cold-1', name: 'Cold', learning_phase: 'LEARNING' },
        ],
        audiences: [
          { adset_id: 'warm-1', resolution: warm },
          { adset_id: 'cold-1', resolution: cold },
        ],
      },
      reconciliation: null, economics: null, operatingMode: null,
      recommendations: { read_health: 'healthy', count: 0 }, creative: null,
    })
    const claims = new Map(packet.claims.map((item) => [item.claimId, item]))
    const brief = normalizeAnswerBriefValue({
      summary: 'governed_claims', observations: [], action_decision_ids: [],
      unavailable_claim_ids: [], next_check: null,
    }, claims, packet.required_claim_ids)
    const rendered = renderAnswerBrief(brief, packet.claims)

    expect(rendered).toContain('Included audience included-op-433: Meta operation status 433')
    expect(rendered).toContain('contributes no reachable people')
    expect(rendered).toContain(
      'Excluded audience excluded-delivery-300: Meta delivery status 300',
    )
    expect(rendered).toContain('exclusion is not suppressing anyone')
    expect(rendered).toContain(
      'Included audience included-operation-absent: Meta operation status unavailable',
    )
    expect(rendered).toContain('audience and budget conclusions are frozen')
    expect(rendered.match(/observed at: 2026-08-21T11:00:00.000Z/g)).toHaveLength(3)
    expect(rendered).not.toContain('status null')
  })
})

describe('server-only persisted decision projection', () => {
  it('admits current single-line owner copy and rejects legacy or multiline copy', () => {
    const row = {
      metric_claim_lineage_verified: true,
      action_decision: {
        id: 'decision-1', source_kind: 'recommendation', source_id: 'rec-1',
        action_kind: 'observe', authority_tier: 'diagnostic_only',
        policy_version: 5, approval_state: 'not_requested',
        owner_copy: 'Observe Warm; no live change is authorized.',
      },
    } as unknown as StoredRecommendation
    expect(projectInternalFinalActionDecisions([row])).toEqual([{
      id: 'decision-1', persisted: true, final: true, record_type: 'action_decisions',
      policy_version: 5, action_kind: 'observe', authority_tier: 'diagnostic_only',
      approval_state: 'not_requested', owner_copy: 'Observe Warm; no live change is authorized.',
      lineage: { source_kind: 'recommendation', source_id: 'rec-1' },
    }])
    expect(projectInternalFinalActionDecisions([{
      ...row, action_decision: { ...row.action_decision!, policy_version: 4 },
    }])).toEqual([])
    expect(projectInternalFinalActionDecisions([{
      ...row, action_decision: { ...row.action_decision!, owner_copy: 'Observe.\nScale now.' },
    }])).toEqual([])
  })
})
