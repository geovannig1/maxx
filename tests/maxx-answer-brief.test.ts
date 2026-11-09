import { describe, expect, it } from 'vitest'
import {
  parseAnswerBrief,
  parseAnswerBriefClaims,
  renderAnswerBrief,
  type AnswerBriefClaim,
} from '@/lib/maxx/answer-brief'
import { createMetricClaim } from '@/lib/cockpit/contracts'

const claim = (overrides: Partial<AnswerBriefClaim> = {}): AnswerBriefClaim => createMetricClaim({
  claimId: 'claim-meta-results',
  metricKey: 'meta_results',
  label: 'Meta Results',
  value: 18,
  unit: 'count' as const,
  formula: null,
  definitionVersion: 1,
  source: { system: 'meta', role: 'delivery_truth', head: 'meta-head', evidencePlane: 'meta_delivery' },
  entity: { level: 'account', id: 'active' },
  attributionScope: 'meta_platform_modelled',
  window: { start: '2026-04-04', end: '2026-04-23', basis: 'closed_account_days', timezone: 'America/New_York' },
  comparison: { method: 'none', window: null },
  asOf: '2026-04-24T12:00:00.000Z',
  availability: { state: 'available', blockerCodes: [] },
  coverage: { state: 'complete', numerator: 20, denominator: 20 },
  maturity: { state: 'settled', matureThrough: '2026-04-23' },
  freshness: { state: 'fresh', observedAt: '2026-04-24T12:00:00.000Z', maxAgeHours: 24 },
  setupFingerprint: 'setup-v1',
  authority: { state: 'context', policyVersion: 'meta-results-v1' },
  measurementKind: 'modelled',
  inputClaimIds: [],
  ...overrides,
})

describe('Maxx structured AnswerBrief', () => {
  it('renders numeric values only from referenced governed claims', () => {
    const brief = parseAnswerBrief(JSON.stringify({
      summary: 'governed_claims',
      observations: [{
        claim_ids: [claim().claimId],
      }],
      action_decision_ids: [],
      unavailable_claim_ids: [],
      next_check: null,
    }))

    const rendered = renderAnswerBrief(brief, [claim()])

    expect(rendered).toContain('**Meta Results — 18**')
    expect(rendered).toContain('source: meta; measurement lane: modelled; authority: context')
    expect(rendered).toContain('2026-04-04 to 2026-04-23 America/New_York')
    // Summary first, composed from the same claim; the evidence follows its heading.
    expect(rendered.startsWith('Apr 4 – Apr 23, 2026: Meta Results came to 18.')).toBe(true)
    expect(rendered).toContain('**Evidence (1 claim)**')
    expect(rendered.indexOf('**Evidence (1 claim)**')).toBeLessThan(rendered.indexOf('**Meta Results — 18**'))
  })

  it('rejects any model-authored prose, including uncited qualitative summaries', () => {
    expect(() => parseAnswerBrief(JSON.stringify({
      summary: 'Campaign quality is strong.',
      observations: [],
      action_decision_ids: [],
      unavailable_claim_ids: [],
      next_check: null,
    }))).toThrow(/governed_claims/i)
  })

  it('rejects forged claim predicates and action-decision references', () => {
    const brief = parseAnswerBrief(JSON.stringify({
      summary: 'governed_claims',
      observations: [{ claim_ids: ['missing'] }],
      action_decision_ids: ['decision-missing'],
      unavailable_claim_ids: [],
      next_check: null,
    }))

    expect(() => renderAnswerBrief(brief, [claim()], new Map()))
      .toThrow(/unknown claim/i)
  })

  it('renders unavailable and partial claims without a numeric value', () => {
    const unavailableClaim = claim({
      claimId: 'claim-return',
      metricKey: 'tracked_checkout_roas',
      label: 'Tracked checkout ROAS',
      value: null,
      unit: 'ratio',
      availability: { state: 'unavailable', blockerCodes: ['paid_manifest_missing'] },
      coverage: { state: 'partial', numerator: 1, denominator: 20 },
      authority: { state: 'blocked', policyVersion: 'paid-cohort-v3' },
    })
    const brief = parseAnswerBrief(JSON.stringify({
      summary: 'governed_claims',
      observations: [],
      action_decision_ids: [],
      unavailable_claim_ids: [unavailableClaim.claimId],
      next_check: null,
    }))
    const rendered = renderAnswerBrief(brief, [unavailableClaim])

    expect(rendered).toContain('**Tracked checkout ROAS — unavailable**')
    expect(rendered).not.toContain('8.7')
  })

  it('accepts a brief with next_check OMITTED, which is the reason it has a default', () => {
    // Measured live: the model returned an otherwise perfect brief with `next_check` simply left out,
    // and `z.null()` rejects `undefined`, so the whole answer was withheld as malformed. Every
    // fixture in this repo writes the key explicitly, so nothing covered the case the change exists
    // for — deleting `.default(null)` left the whole suite green.
    const governed = claim()
    const omitted = parseAnswerBrief(JSON.stringify({
      summary: 'governed_claims',
      observations: [{ claim_ids: [governed.claimId] }],
      action_decision_ids: [],
      unavailable_claim_ids: [],
      // next_check deliberately absent
    }))
    expect(omitted.next_check).toBeNull()
    expect(renderAnswerBrief(omitted, [governed])).toContain('**Meta Results — 18**')

    // The guarantee is unchanged: only null. Any value is still refused.
    for (const illegal of ['Pause the campaign now.', '', false, 0, [], {}]) {
      expect(() => parseAnswerBrief(JSON.stringify({
        summary: 'governed_claims', observations: [], action_decision_ids: [],
        unavailable_claim_ids: [], next_check: illegal,
      }))).toThrow()
    }
  })

  it('gives the model no channel to assert a claim property alongside the id', () => {
    // REPLACES 'requires every predicate dimension to exactly match a governed claim'. That test
    // forged `measurement_lane` on a transcribed predicate and asserted the render threw. A brief now
    // carries ids, so the forgery is unconstructible — and a deleted test is a silently weakened
    // contract. What it defended is now structural, so this proves the structure holds.
    const governed = claim()

    // A claim property smuggled in beside the id: rejected by `.strict()`.
    expect(() => parseAnswerBrief(JSON.stringify({
      summary: 'governed_claims',
      observations: [{ claim_ids: [governed.claimId], measurement_lane: 'measured' }],
      action_decision_ids: [],
      unavailable_claim_ids: [],
      next_check: null,
    }))).toThrow()

    // A whole claim object supplied where an id belongs: rejected by the string schema.
    expect(() => parseAnswerBrief(JSON.stringify({
      summary: 'governed_claims',
      observations: [{ claim_ids: [{ claim_id: governed.claimId, measurement_lane: 'measured' }] }],
      action_decision_ids: [],
      unavailable_claim_ids: [],
      next_check: null,
    }))).toThrow()

    // And the property the forgery targeted is rendered from the GOVERNED claim, never from the brief.
    const valid = parseAnswerBrief(JSON.stringify({
      summary: 'governed_claims',
      observations: [{ claim_ids: [governed.claimId] }],
      action_decision_ids: [],
      unavailable_claim_ids: [],
      next_check: null,
    }))
    expect(renderAnswerBrief(valid, [governed])).toContain('modelled')
  })

  it('only renders action evidence when a typed persisted final decision is supplied', () => {
    const brief = parseAnswerBrief(JSON.stringify({
      summary: 'governed_claims',
      observations: [],
      action_decision_ids: ['decision-final'],
      unavailable_claim_ids: [],
      next_check: null,
    }))

    expect(() => renderAnswerBrief(brief, [claim()], new Map())).toThrow(/unknown action decision/i)
    expect(renderAnswerBrief(brief, [claim()], new Map([['decision-final', {
      id: 'decision-final',
      persisted: true,
      final: true,
      record_type: 'action_decisions',
      policy_version: 5,
      authority_tier: 'owner_review',
      approval_state: 'pending',
      lineage: { source_kind: 'recommendation', source_id: 'recommendation-final' },
    }]]))).toContain('Persisted final ActionDecision: decision-final')
  })

  it('accepts the cockpit claim map without losing claim identity', () => {
    expect(parseAnswerBriefClaims({
      'claim-meta-results': claim(),
    })).toEqual([expect.objectContaining({ claimId: 'claim-meta-results' })])
  })
})
