import { describe, expect, it } from 'vitest'
import { MetricClaimSchema, assertNoCrossPlaneLineage, type MetricClaim } from '@/lib/cockpit/contracts'

/**
 * The blended cost-per-booking must be unconstructible, not merely discouraged.
 *
 * Meta spend is paid-only. An Acuity booking count is all sources, organic and paid together.
 * Dividing one by the other produces a number that looks exactly like a paid CPA and is not one —
 * the error Meta's own AI chat has been seen to make. With a handful of verified paid touches against
 * over a thousand active bookings there is no honest paid denominator to build it from at all.
 *
 * `MetricClaimSchema` cannot catch it: `inputClaimIds` are strings, so the schema validates that
 * lineage exists and is unique but never sees the planes behind it. Copying the `meta.cost_per_result`
 * block and swapping the denominator yields a fully valid, deep-frozen claim indistinguishable
 * downstream from a governed Meta metric. Hence a check where the whole claim set is in hand.
 */

const base = {
  claimId: 'meta.spend:2026-04-04:2026-04-23', metricKey: 'meta.spend', label: 'Meta spend',
  value: 585, unit: 'money', formula: null, definitionVersion: 1,
  source: { system: 'meta', role: 'delivery_truth', head: 'h', evidencePlane: 'meta_delivery' },
  entity: { level: 'account', id: 'act_1' }, attributionScope: 'none',
  window: { start: '2026-04-04', end: '2026-04-23', basis: 'closed_account_days', timezone: 'America/New_York' },
  comparison: { method: 'none', window: null }, asOf: '2026-04-24T12:00:00.000Z',
  availability: { state: 'available', blockerCodes: [] },
  coverage: { state: 'complete', numerator: 20, denominator: 20 },
  maturity: { state: 'settled', matureThrough: '2026-04-23' },
  freshness: { state: 'fresh', observedAt: '2026-04-24T12:00:00.000Z', maxAgeHours: 24 },
  setupFingerprint: 'sf', authority: { state: 'context', policyVersion: 'v1' },
  measurementKind: 'measured', inputClaimIds: [],
}

const claim = (over: Record<string, unknown>): MetricClaim =>
  MetricClaimSchema.parse({ ...base, ...over })

const SPEND = claim({})
const BOOKINGS = claim({
  claimId: 'outcomes.value_bearing_bookings:2026-04-04:2026-04-23',
  metricKey: 'outcomes.value_bearing_bookings', label: 'Value-bearing bookings (all sources)',
  value: 26, unit: 'count', attributionScope: 'all_sources',
  source: { system: 'outcomes', role: 'business_truth', head: 'ledger', evidencePlane: 'outcome_business' },
  entity: { level: 'business', id: 'biz_1' },
})
const META_RESULTS = claim({
  claimId: 'meta.appointment_confirmed_results:2026-04-04:2026-04-23',
  metricKey: 'meta.appointment_confirmed_results', label: 'Meta Results', value: 15, unit: 'count',
  attributionScope: 'meta_platform_modelled',
})

const set = (...claims: MetricClaim[]) => Object.fromEntries(claims.map((c) => [c.claimId, c]))

describe('a value computed across evidence planes cannot be constructed', () => {
  it('refuses paid-only spend divided by an all-source booking count', () => {
    const blendedCpa = claim({
      claimId: 'paid.cost_per_booking:2026-04-04:2026-04-23', metricKey: 'paid.cost_per_booking',
      label: 'Cost per booking', value: 585 / 26, unit: 'money', measurementKind: 'derived',
      inputClaimIds: [SPEND.claimId, BOOKINGS.claimId],
    })
    // The schema itself is perfectly happy with it — that is the point.
    expect(() => MetricClaimSchema.parse(blendedCpa)).not.toThrow()
    expect(() => assertNoCrossPlaneLineage(set(SPEND, BOOKINGS, blendedCpa)))
      .toThrow(/computed across evidence planes/)
  })

  it('names both planes in the error so the reader knows which populations were mixed', () => {
    const blended = claim({
      claimId: 'paid.cpa:2026-04-04:2026-04-23', metricKey: 'paid.cpa', label: 'CPA',
      value: 22.5, unit: 'money', measurementKind: 'derived',
      inputClaimIds: [BOOKINGS.claimId],
    })
    expect(() => assertNoCrossPlaneLineage(set(SPEND, BOOKINGS, blended)))
      .toThrow(/meta_delivery.*outcome_business|outcome_business/)
  })

  it('allows a derived claim whose inputs share one plane', () => {
    const costPerResult = claim({
      claimId: 'meta.cost_per_result:2026-04-04:2026-04-23', metricKey: 'meta.cost_per_result',
      label: 'Meta cost per Result', value: 585 / 15, unit: 'money', measurementKind: 'derived',
      attributionScope: 'meta_platform_modelled',
      inputClaimIds: [SPEND.claimId, META_RESULTS.claimId],
    })
    expect(() => assertNoCrossPlaneLineage(set(SPEND, META_RESULTS, costPerResult))).not.toThrow()
  })

  it.each(['associated_noncausal', 'causal_estimate'])(
    'refuses a cross-plane %s claim that keeps a paid-only attribution scope',
    (kind) => {
      // THE ONE-WORD BYPASS. The first version of this guard skipped these kinds outright, so
      // relabelling the blended claim built $22.50/booking from paid-only spend over an all-source
      // denominator and passed — while the honest `derived` label was blocked. Proven by execution.
      const relabelled = claim({
        claimId: `paid.cost_per_booking.${kind}:2026-04-04:2026-04-23`,
        metricKey: 'paid.cost_per_booking', label: 'Cost per booking', value: 585 / 26, unit: 'money',
        measurementKind: kind, attributionScope: 'none',
        inputClaimIds: [SPEND.claimId, BOOKINGS.claimId],
      })
      expect(() => assertNoCrossPlaneLineage(set(SPEND, BOOKINGS, relabelled)))
        .toThrow(/declare[\s\S]*causal_estimate|across planes/)
    },
  )

  it('leaves a SAME-plane associational claim untouched', () => {
    // The rule must fire on the crossing, not on the label. An associational claim whose inputs share
    // a plane is ordinary and legal.
    const sameplane = claim({
      claimId: 'meta.assoc:2026-04-04:2026-04-23', metricKey: 'meta.assoc', label: 'Assoc',
      value: 2, unit: 'count', measurementKind: 'associated_noncausal', attributionScope: 'none',
      inputClaimIds: [SPEND.claimId, META_RESULTS.claimId],
    })
    expect(() => assertNoCrossPlaneLineage(set(SPEND, META_RESULTS, sameplane))).not.toThrow()
  })

  it('permits a crossing that declares itself as modelled', () => {
    // Combining planes is what a causal estimate is FOR. The exemption is the measurement kind
    // announcing the crossing, not a hole in the guard.
    const lift = claim({
      claimId: 'paid.incremental_bookings:2026-04-04:2026-04-23',
      metricKey: 'paid.incremental_bookings', label: 'Incremental bookings', value: 3, unit: 'count',
      measurementKind: 'causal_estimate', attributionScope: 'causal_estimate',
      inputClaimIds: [SPEND.claimId, BOOKINGS.claimId],
    })
    expect(() => assertNoCrossPlaneLineage(set(SPEND, BOOKINGS, lift))).not.toThrow()
  })

  it('refuses lineage that resolves to nothing', () => {
    // A claim asserting a derivation nobody can check is the shape of a forged reference.
    const orphan = claim({
      claimId: 'meta.made_up:2026-04-04:2026-04-23', metricKey: 'meta.made_up', label: 'Made up',
      value: 1, unit: 'count', measurementKind: 'derived', inputClaimIds: ['does.not.exist:1:2'],
    })
    expect(() => assertNoCrossPlaneLineage(set(SPEND, orphan))).toThrow(/not in the claim set/)
  })

  it('ignores claims with no lineage at all', () => {
    expect(() => assertNoCrossPlaneLineage(set(SPEND, BOOKINGS))).not.toThrow()
  })
})
