import { describe, expect, it } from 'vitest'
import { scoreBrief, type BriefExpectation } from '@/lib/eval/brief-rubric'
import { createMetricClaim, type MetricClaim } from '@/lib/cockpit/contracts'

/**
 * The eval must not grade the more complete answer lower.
 *
 * Before the exemption existed, a brief citing `meta.spend_change` alone scored 1.000 and admissible; the
 * same brief ALSO citing the prior-period spend the change was computed from scored 0.833 and
 * INADMISSIBLE, because G5 read the earlier window as "outside the asked period".
 *
 * So "spend was $480 then and $720 now, up 50.0%" graded below "up 50.0%" — an incentive gradient
 * toward less evidence, and the same shape as the cross-plane defect where the honest label was
 * refused and the dishonest one was not.
 *
 * The exemption is narrow on purpose: only a window a CITED trend explicitly declares in its
 * `comparison.window`. Everything else out of period still fails, which the last three cases pin.
 */

const W = (start: string, end: string) => ({
  start, end, basis: 'closed_account_days' as const, timezone: 'America/New_York' as const,
})

function claim(id: string, metricKey: string, window: ReturnType<typeof W>, comparison: MetricClaim['comparison']): MetricClaim {
  return createMetricClaim({
    claimId: id, metricKey, label: metricKey, value: 100, unit: 'money', formula: null, definitionVersion: 1,
    source: { system: 'meta', role: 'delivery_truth', head: 'daily_insights.account', evidencePlane: 'meta_delivery' },
    entity: { level: 'account', id: 'act_123' }, attributionScope: 'none',
    window, comparison, asOf: '2026-08-21T12:00:00.000Z',
    availability: { state: 'available', blockerCodes: [] },
    coverage: { state: 'complete', numerator: 20, denominator: 20 },
    maturity: { state: 'settled', matureThrough: window.end },
    freshness: { state: 'fresh', observedAt: '2026-08-21T12:00:00.000Z', maxAgeHours: 26 },
    setupFingerprint: null, authority: { state: 'context', policyVersion: 'cockpit-v3' },
    measurementKind: 'measured', inputClaimIds: [],
  })
}

const ASKED = W('2026-08-01', '2026-08-20')
const PRIOR = W('2026-07-12', '2026-07-31')
const UNRELATED = W('2026-05-01', '2026-05-20')

const EXPECTATION: BriefExpectation = {
  id: 'trend', requiredPlanes: ['meta_delivery'], businessTruthMetrics: [], mustDeclareUnavailable: [],
  entityLevels: { meta_delivery: ['account'], outcome_business: ['business'], ga4_telemetry: ['account'], paid_association: ['account'] },
  window: { start: ASKED.start, end: ASKED.end }, actionDecisions: 'forbidden',
}

const CURRENT = claim('cur', 'meta.spend', ASKED, { method: 'none', window: null })
const PRIOR_CLAIM = claim('pri', 'meta.spend', PRIOR, { method: 'none', window: null })
const UNRELATED_CLAIM = claim('old', 'meta.spend', UNRELATED, { method: 'none', window: null })
const TREND = claim('trend', 'meta.spend_change', ASKED, { method: 'prior_equal_period', window: PRIOR })

const CLAIMS = new Map([CURRENT, PRIOR_CLAIM, UNRELATED_CLAIM, TREND].map((c) => [c.claimId, c]))

const score = (ids: string[], claims = CLAIMS) => scoreBrief(
  EXPECTATION,
  { summary: 'governed_claims', observations: [{ claim_ids: ids }], action_decision_ids: [], unavailable_claim_ids: [], next_check: null },
  claims,
)
const g5 = (ids: string[], claims = CLAIMS) => score(ids, claims).gates.find((g) => g.gate === 'G5_window_respected')!

describe('a cited trend legitimises the prior window it declares', () => {
  it('a trend alone is admissible (so the comparisons below mean something)', () => {
    expect(score(['trend']).admissible).toBe(true)
    expect(g5(['trend']).passed).toBe(true)
  })

  it('showing the prior number BESIDE the trend is no longer penalised', () => {
    expect(g5(['trend', 'cur', 'pri']).passed).toBe(true)
    expect(score(['trend', 'cur', 'pri']).admissible).toBe(true)
  })

  it('the fuller answer does not score BELOW the thinner one', () => {
    // The property that matters, stated directly rather than as two absolute numbers.
    expect(score(['trend', 'cur', 'pri']).score).toBeGreaterThanOrEqual(score(['trend']).score)
  })
})

describe('the exemption is narrow, and G5 still does its job', () => {
  it('a prior-period claim with NO trend citing it still fails', () => {
    // The exemption is granted by a cited trend, not by the window being early. Without the trend in
    // the brief, nothing declares that period as evidence.
    expect(g5(['cur', 'pri']).passed).toBe(false)
    expect(g5(['cur', 'pri']).detail).toContain('2026-07-12')
  })

  it('an unrelated out-of-period claim fails even when a trend IS cited', () => {
    // May 1-20 is not the window the trend declares, so citing a trend does not launder it.
    expect(g5(['trend', 'old']).passed).toBe(false)
    expect(g5(['trend', 'old']).detail).toContain('2026-05-01')
  })

  it('a trend declaring a DIFFERENT prior window does not exempt this one', () => {
    // Per-metric comparable windows mean two trends genuinely name different periods. Only the window
    // actually declared is exempt.
    const otherTrend = claim('t2', 'meta.results_change', ASKED, { method: 'prior_equal_period', window: W('2026-07-19', '2026-07-31') })
    const claims = new Map([...CLAIMS, [otherTrend.claimId, otherTrend]])
    expect(g5(['t2', 'pri'], claims).passed).toBe(false)
    expect(g5(['t2', 'pri'], claims).detail).toContain('2026-07-12')
  })

  it('a claim whose comparison method is none exempts nothing, whatever window it carries', () => {
    // Only `prior_equal_period` declares a comparison. A point value carries `method: 'none'`.
    expect(g5(['cur', 'pri']).passed).toBe(false)
  })
})
