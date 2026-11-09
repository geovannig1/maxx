import { describe, it, expect, afterEach } from 'vitest'
import { getMetricStatus, applyTargetOverrides, mergeRanges, validateRangeOrdering, METRIC_RANGES } from '@/lib/targets/target-ranges'
import { computeHealthScore } from '@/lib/creative/health-score'
import { applyExampleOwnerTargetsPerTest } from '../helpers/example-targets'

// cost metrics have no built-in target; these suites test behaviour WITH the owner's target set.
applyExampleOwnerTargetsPerTest()

// Reset the module-global active ranges after every test so no override leaks between tests.
afterEach(() => applyTargetOverrides(null))

// ─────────────────────────────────────────────────────────────────────────────────────────────
// overrides with healthy>watch silently INVERT the bands (no ordering validation today).
// ─────────────────────────────────────────────────────────────────────────────────────────────
describe('inverted target overrides corrupt banding', () => {
  it('a bad $80 CPA reads as "healthy" once healthy/watch are inverted', () => {
    applyTargetOverrides({ cpa: { healthy: 98, watch: 64 } }) // invalid: for lower_is_better, healthy must be ≤ watch
    const ev = getMetricStatus('cpa', 80, { spend: 200, bookings: 5, windowDays: 7 })
    // $80 is ABOVE the $64 target — it should be "watch", not "healthy". classifyBand checks ≤healthy(98)
    // first, so the watch band becomes unreachable. This is the corruption the PUT route must reject.
    expect(ev.status).toBe('healthy')
  })

  it('with the correct default ordering, $80 CPA is "watch" (the honest result)', () => {
    const ev = getMetricStatus('cpa', 80, { spend: 200, bookings: 5, windowDays: 7 })
    expect(ev.status).toBe('watch')
  })

  // validateRangeOrdering (used by the PUT route) rejects the inverted override.
  it('validateRangeOrdering accepts the defaults', () => {
    expect(validateRangeOrdering(METRIC_RANGES).ok).toBe(true)
  })

  it('validateRangeOrdering rejects an inverted lower_is_better override (healthy>watch)', () => {
    const effective = mergeRanges({ cpa: { healthy: 98, watch: 64 } })
    const res = validateRangeOrdering(effective)
    expect(res.ok).toBe(false)
    expect(res.errors.some((e) => e.includes('cpa'))).toBe(true)
  })

  it('validateRangeOrdering rejects an inverted higher_is_better override (roas excellent<healthy)', () => {
    const effective = mergeRanges({ roas: { excellent: 1, healthy: 2, watch: 3 } }) // inverted for higher_is_better
    expect(validateRangeOrdering(effective).ok).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────────────────────
// health score is NOT range-aware and has NO min-data gate.
// ─────────────────────────────────────────────────────────────────────────────────────────────
describe('health score is now min-data gated and override-aware', () => {
  it('flags a 1-day, $5, 1-impression entity as dataSufficient=false', () => {
    const r = computeHealthScore({
      spend: 5, bookings: 0, ctr: 0.3, cpa: null, frequency: 1, impressions: 1, entity_age_days: 1, hook_rate: null,
    })
    expect(r.dataSufficient).toBe(false)
    expect(r.signal).toMatch(/provisional/i)
    // The honest range engine agrees — it refuses to judge CTR below 500 impressions.
    expect(getMetricStatus('ctr', 0.3, { impressions: 1, spend: 5, windowDays: 1 }).status).toBe('needs_data')
  })

  it('marks a well-delivered entity dataSufficient=true', () => {
    const r = computeHealthScore({ spend: 300, bookings: 5, ctr: 1.5, cpa: 55, frequency: 1.8, impressions: 5000, entity_age_days: 10, hook_rate: null })
    expect(r.dataSufficient).toBe(true)
  })

  it('default config is unchanged (range-derived breakpoints equal the old constants)', () => {
    // The previously-pinned mid-ad score must still be 57 under default ranges.
    const r = computeHealthScore({ spend: 300, bookings: 5, ctr: 1.2, cpa: 70, frequency: 2.2, impressions: 5000, entity_age_days: 20, hook_rate: null })
    expect(r.score).toBe(57)
  })

  it('NOW respects target-range overrides: re-banding CPA targets changes the health score', () => {
    const input = { spend: 300, bookings: 5, ctr: 1.5, cpa: 75, frequency: 1.8, impressions: 5000, entity_age_days: 10, hook_rate: null }
    const before = computeHealthScore(input).breakdown.cpa_score // $75 vs default → 15
    applyTargetOverrides({ cpa: { excellent: 80, healthy: 100, watch: 140 } }) // make $75 "excellent"
    const after = computeHealthScore(input).breakdown.cpa_score // → 30
    expect(after).not.toBe(before)
    expect(after).toBe(30)
  })
})

// ─────────────────────────────────────────────────────────────────────────────────────────────
// CPA's estimateBound flag is inert (estimate_only needs sourceOfTruth ga4_actual).
// ─────────────────────────────────────────────────────────────────────────────────────────────
describe('CPA never becomes estimate_only even though it is attribution-bound', () => {
  it('returns a hard band for CPA regardless of attribution coverage', () => {
    const ev = getMetricStatus('cpa', 50, { spend: 200, bookings: 5, windowDays: 7, attributionCoverage: 0.0 })
    expect(ev.status).toBe('healthy') // not estimate_only — the estimateBound flag is unused for meta_estimate metrics
  })

  it('ROAS, by contrast, DOES become estimate_only on low coverage', () => {
    const ev = getMetricStatus('roas', 4, { spend: 200, bookings: 5, windowDays: 7, attributionCoverage: 0.1 })
    expect(ev.status).toBe('estimate_only')
  })
})
