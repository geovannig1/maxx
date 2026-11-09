import './_support/outcome-noun-booking'
import { describe, it, expect } from 'vitest'
import { computeTrust, TRUST_BAR, trustLevelFor, type TrustContext } from '@/lib/trust/trust'
import { trustFromGrounding } from '@/lib/trust/adapters'
import { runGroundingGate, type GroundingInput } from '@/lib/recommendations/grounding-gate'

// A genuinely verified conversion claim: strong volume, fresh, GA4-actual, well-attributed, stable.
const verified: TrustContext = {
  spend: 600,
  bookings: 12,
  clicks: 400,
  impressions: 40_000,
  windowDays: 14,
  dataAgeHours: 5,
  sourceOfTruth: 'exact_paid_appointment_join',
  revenueClaim: true,
  attributionCoverage: 0.95,
  exitedLearning: true,
  trendStable: true,
  reconVariancePct: 2,
  dataSourcesCount: 2,
}

// A revenue claim resting on GA CONFIRMATION-EVENT TELEMETRY previously scored the same as
// the Acuity ledger, so a diagnostic could certify it "Verified (100%) — safe to act on without
// caveat". These fixtures now use `exact_appointment_join` — a ledger booking joined by appointment id
// — which is the only GA-derived source that may back a money claim.
describe('a revenue claim on GA telemetry can never read as verified', () => {
  it('caps GA-telemetry revenue well below the bar, and below a Meta estimate', () => {
    const ga = computeTrust({ spend: 600, bookings: 12, windowDays: 14, dataAgeHours: 5, sourceOfTruth: 'ga4_confirmation_telemetry', revenueClaim: true, attributionCoverage: 0.95, exitedLearning: true, trendStable: true, dataSourcesCount: 2 })
    expect(ga.score).toBeLessThan(60)
    expect(ga.level).not.toBe('verified')
    expect(ga.ceilings.map((c) => c.reason).join(' ')).toMatch(/no booking identity/)
    // The same context joined by appointment id IS verifiable.
    const exact = computeTrust({ spend: 600, bookings: 12, windowDays: 14, dataAgeHours: 5, sourceOfTruth: 'exact_paid_appointment_join', revenueClaim: true, attributionCoverage: 0.95, exitedLearning: true, trendStable: true, dataSourcesCount: 2 })
    expect(exact.score).toBeGreaterThan(ga.score)
  })
})

describe('computeTrust — the 95% bar is hard and honest', () => {
  it('clears the bar only when everything is strong', () => {
    const t = computeTrust(verified)
    expect(t.score).toBeGreaterThanOrEqual(TRUST_BAR)
    expect(t.level).toBe('verified')
    expect(t.meetsBar).toBe(true)
    expect(t.ceilings).toHaveLength(0)
    expect(t.gaps).toHaveLength(0)
  })

  it('caps hard on thin spend and tells you why', () => {
    const t = computeTrust({ ...verified, spend: 8 })
    expect(t.score).toBeLessThanOrEqual(50)
    expect(t.meetsBar).toBe(false)
    expect(t.ceilings.some((c) => /spend/i.test(c.reason))).toBe(true)
    expect(t.gaps.some((g) => /Spend more than/i.test(g))).toBe(true)
  })

  it('caps a revenue claim that leans on a Meta estimate at 60', () => {
    const t = computeTrust({ ...verified, sourceOfTruth: 'meta_modelled' })
    expect(t.score).toBeLessThanOrEqual(60)
    expect(t.ceilings.some((c) => /MODELLED attribution|under- or over-attribute/i.test(c.reason))).toBe(true)
    expect(t.gaps.some((g) => /recorded collected value from the outcome ledger/i.test(g))).toBe(true)
  })

  it('labels telemetry and modelled outcomes without calling them bookings', () => {
    const ga = computeTrust({ ...verified, sourceOfTruth: 'ga4_confirmation_telemetry' })
    const meta = computeTrust({ ...verified, sourceOfTruth: 'meta_modelled' })

    expect(ga.factors.find((f) => f.key === 'volume')?.detail).toMatch(/GA confirmation events/)
    expect(ga.factors.find((f) => f.key === 'volume')?.detail).not.toMatch(/\bbookings\b/)
    expect(meta.factors.find((f) => f.key === 'volume')?.detail).toMatch(/Meta-modelled booking events/)
    expect(meta.factors.find((f) => f.key === 'volume')?.detail).not.toMatch(/\bbookings\b/)
  })

  it('caps a per-campaign ROAS claim with low attribution at 40', () => {
    const t = computeTrust({ ...verified, perCampaignRoasClaim: true, attributionCoverage: 0.2 })
    expect(t.score).toBeLessThanOrEqual(40)
    expect(t.ceilings.some((c) => /attribution coverage/i.test(c.reason))).toBe(true)
  })

  it('treats a dormant account as insufficient', () => {
    const t = computeTrust({ ...verified, dormant: true })
    expect(t.level).toBe('insufficient')
    expect(t.score).toBeLessThanOrEqual(25)
  })

  it('caps stale / unknown-age data at 70', () => {
    expect(computeTrust({ ...verified, dataAgeHours: 60 }).score).toBeLessThanOrEqual(70)
    expect(computeTrust({ ...verified, dataAgeHours: null }).score).toBeLessThanOrEqual(70)
  })

  it('does NOT penalise an engagement metric for "no GA4 source" — Meta is the legitimate source', () => {
    // A CTR reading with real click volume should be high-trust without a revenue/attribution drag.
    const t = computeTrust({ spend: 300, clicks: 600, impressions: 60_000, windowDays: 14, dataAgeHours: 4, revenueClaim: false, dataSourcesCount: 1 })
    expect(t.score).toBeGreaterThanOrEqual(80)
    // source & attribution are marked N/A (weight 0), not scored as failures
    expect(t.factors.find((f) => f.key === 'source')?.weight).toBe(0)
    expect(t.factors.find((f) => f.key === 'attribution')?.weight).toBe(0)
  })

  it('a weak reconciliation variance drags cross-source agreement down', () => {
    const strong = computeTrust(verified).score
    const drifted = computeTrust({ ...verified, reconVariancePct: 35 }).score
    expect(drifted).toBeLessThan(strong)
  })

  it('level thresholds are monotonic', () => {
    expect(trustLevelFor(96)).toBe('verified')
    expect(trustLevelFor(85)).toBe('high')
    expect(trustLevelFor(65)).toBe('moderate')
    expect(trustLevelFor(40)).toBe('low')
    expect(trustLevelFor(10)).toBe('insufficient')
  })

  it('engagement-only data can be HIGH but NEVER Verified — no outcome to corroborate it', () => {
    const t = computeTrust({ clicks: 600, impressions: 60_000, spend: 300, windowDays: 14, dataAgeHours: 1, exitedLearning: true, trendStable: true, dataSourcesCount: 2, revenueClaim: false })
    expect(t.meetsBar).toBe(false)
    expect(t.score).toBeLessThanOrEqual(94)
    expect(t.score).toBeGreaterThanOrEqual(80)
    expect(t.ceilings.some((c) => /engagement-only/i.test(c.reason))).toBe(true)
  })

  it('reports learning state without changing evidence trust', () => {
    const base: TrustContext = { spend: 600, bookings: 12, windowDays: 14, dataAgeHours: 5, sourceOfTruth: 'exact_paid_appointment_join', revenueClaim: true, attributionCoverage: 0.95, dataSourcesCount: 2 }
    expect(computeTrust(base).score).toBe(computeTrust({ ...base, exitedLearning: false }).score)
    expect(computeTrust({ ...base, exitedLearning: false }).factors.find((factor) => factor.key === 'stability')?.detail).toMatch(/delivery context only/i)
  })

  it('does NOT trust an unset/0-day window more than a known 1-day window', () => {
    const base: TrustContext = { spend: 300, clicks: 600, impressions: 60_000, dataAgeHours: 1, revenueClaim: false, dataSourcesCount: 2 }
    const unset = computeTrust(base) // windowDays omitted → 0
    const oneDay = computeTrust({ ...base, windowDays: 1 })
    expect(unset.score).toBeLessThanOrEqual(oneDay.score)
    expect(unset.score).toBeLessThanOrEqual(60) // window-unknown is capped like a thin window, not waved through
  })
})

describe('trustFromGrounding — recommendations speak the same vocabulary', () => {
  const groundedScale: GroundingInput = {
    recommendation_type: 'scale',
    spend: 600, bookings: 16, window_days: 14, data_age_hours: 5, data_sources_count: 2,
    uses_meta_estimate_as_revenue: false, days_since_last_change: 14, exited_learning: true,
    trend_stable: true, conflicting_signal: false, basis: 'observed_performance', reversible: true,
  }

  it('maps a grounded (high-risk) scale to high trust, not blindly verified', () => {
    const t = trustFromGrounding(runGroundingGate(groundedScale))
    // a high-risk scale is capped at 0.85 by the gate → can't be "verified" without caveat
    expect(t.score).toBeLessThanOrEqual(85)
    expect(t.level).toBe('high')
    expect(t.factors.length).toBeGreaterThan(0)
  })

  it('maps a thin/held recommendation to a low trust score with reasons', () => {
    const held = runGroundingGate({ ...groundedScale, recommendation_type: 'pause', spend: 8, window_days: 2, bookings: 0 })
    const t = trustFromGrounding(held)
    expect(t.meetsBar).toBe(false)
    expect(t.score).toBeLessThan(60)
    expect(t.gaps.length).toBeGreaterThan(0)
  })
})
