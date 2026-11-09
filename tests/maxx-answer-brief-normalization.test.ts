import { describe, expect, it } from 'vitest'
import { createMetricClaim, type MetricClaim } from '@/lib/cockpit/contracts'
import { normalizeAnswerBriefValue } from '@/lib/maxx/answer-brief'

function claim(id: string, availability: 'available' | 'unavailable'): MetricClaim {
  return createMetricClaim({
    claimId: id,
    metricKey: id,
    label: id,
    value: availability === 'available' ? 1 : null,
    unit: 'count',
    formula: null,
    definitionVersion: 1,
    source: {
      system: 'meta', role: 'delivery_truth', head: 'head', evidencePlane: 'meta_delivery',
    },
    entity: { level: 'account', id: 'act-1' },
    attributionScope: 'none',
    window: {
      start: '2026-08-01', end: '2026-08-20', basis: 'closed_account_days',
      timezone: 'America/New_York',
    },
    comparison: { method: 'none', window: null },
    asOf: '2026-08-21T12:00:00.000Z',
    availability: availability === 'available'
      ? { state: 'available', blockerCodes: [] }
      : { state: 'unavailable', blockerCodes: ['not_available'] },
    coverage: { state: 'complete', numerator: 20, denominator: 20 },
    maturity: { state: 'settled', matureThrough: '2026-08-20' },
    freshness: { state: 'fresh', observedAt: '2026-08-21T12:00:00.000Z', maxAgeHours: 24 },
    setupFingerprint: null,
    authority: { state: availability === 'available' ? 'context' : 'blocked', policyVersion: 'v1' },
    measurementKind: 'measured',
    inputClaimIds: [],
  })
}

describe('server-owned AnswerBrief normalization', () => {
  it('deduplicates, reclassifies by governed availability, chunks oversized observations, and adds required claims', () => {
    const available = Array.from({ length: 10 }, (_, index) => claim(`a-${index}`, 'available'))
    const unavailable = claim('u-1', 'unavailable')
    const claims = new Map([...available, unavailable].map((item) => [item.claimId, item]))

    const brief = normalizeAnswerBriefValue({
      summary: 'governed_claims',
      observations: [{ claim_ids: [...available.map((item) => item.claimId), 'u-1', 'a-0'] }],
      action_decision_ids: [],
      unavailable_claim_ids: ['a-1'],
      next_check: null,
    }, claims, ['u-1'])

    expect(brief.observations.map((observation) => observation.claim_ids.length)).toEqual([8, 2])
    expect(brief.observations.flatMap((observation) => observation.claim_ids)).toEqual(
      available.map((item) => item.claimId),
    )
    expect(brief.unavailable_claim_ids).toEqual(['u-1'])
  })

  it('still rejects unknown ids, extra fields, and too many action decisions', () => {
    const governed = claim('known', 'available')
    const claims = new Map([[governed.claimId, governed]])
    const valid = {
      summary: 'governed_claims', observations: [{ claim_ids: ['known'] }],
      action_decision_ids: [], unavailable_claim_ids: [], next_check: null,
    }
    expect(() => normalizeAnswerBriefValue({ ...valid, extra: true }, claims)).toThrow()
    expect(() => normalizeAnswerBriefValue({
      ...valid, observations: [{ claim_ids: ['unknown'] }],
    }, claims)).toThrow(/unknown claim/i)
    expect(() => normalizeAnswerBriefValue({
      ...valid, action_decision_ids: ['d1', 'd2', 'd3', 'd4'],
    }, claims)).toThrow()
  })

  it('retains a bounded two-ad-set outage packet instead of withholding it at nine gaps', () => {
    const unavailable = Array.from({ length: 12 }, (_, index) => claim(`u-${index}`, 'unavailable'))
    const claims = new Map(unavailable.map((item) => [item.claimId, item]))
    const brief = normalizeAnswerBriefValue({
      summary: 'governed_claims', observations: [], action_decision_ids: [],
      unavailable_claim_ids: [], next_check: null,
    }, claims, unavailable.map((item) => item.claimId))

    expect(brief.unavailable_claim_ids).toEqual(unavailable.map((item) => item.claimId))
  })
})
