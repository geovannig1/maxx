import { describe, it, expect } from 'vitest'
import { getMetricStatus, shouldEvaluateMetric, getConfidenceAdjustment } from '@/lib/targets/target-ranges'
import { applyExampleOwnerTargetsPerTest } from './helpers/example-targets'

// cost metrics have no built-in target; these suites test behaviour WITH the owner's target set.
applyExampleOwnerTargetsPerTest()

// Enough data to allow a band verdict for CPA-class metrics.
const ok = { spend: 300, bookings: 5, windowDays: 7, attributionCoverage: 0.7 }

describe('getMetricStatus — CPA bands', () => {
  it('CPA inside the healthy range → healthy', () => {
    expect(getMetricStatus('cpa', 55, ok).status).toBe('healthy')
  })
  it('CPA excellent', () => {
    expect(getMetricStatus('cpa', 40, ok).status).toBe('excellent')
  })
  it('CPA slightly above healthy but not critical → watch (the $66.40 case)', () => {
    expect(getMetricStatus('cpa', 66.4, ok).status).toBe('watch')
    expect(getMetricStatus('cpa', 95, ok).status).toBe('watch')
  })
  it('CPA above max acceptable → critical', () => {
    expect(getMetricStatus('cpa', 130, ok).status).toBe('critical')
  })
  it('High CPA with low spend → needs_data, NOT critical/loser', () => {
    const r = getMetricStatus('cpa', 150, { spend: 10, bookings: 0, windowDays: 1 })
    expect(r.status).toBe('needs_data')
    expect(r.reason).toMatch(/spend|bookings|days/)
  })
})

describe('getMetricStatus — CTR', () => {
  it('low CTR with enough impressions → critical', () => {
    expect(getMetricStatus('ctr', 0.3, { impressions: 1000 }).status).toBe('critical')
  })
  it('low CTR but too few impressions → needs_data (not a verdict)', () => {
    expect(getMetricStatus('ctr', 0.3, { impressions: 100 }).status).toBe('needs_data')
  })
  it('high CTR → excellent (band only — "winner" is a separate, multi-signal decision)', () => {
    expect(getMetricStatus('ctr', 3, { impressions: 1000 }).status).toBe('excellent')
  })
})

describe('getMetricStatus — ROAS attribution', () => {
  it('ROAS with low attribution coverage → estimate_only', () => {
    expect(getMetricStatus('roas', 4, { ...ok, attributionCoverage: 0.1 }).status).toBe('estimate_only')
  })
  it('ROAS with unknown attribution → estimate_only', () => {
    expect(getMetricStatus('roas', 4, { spend: 300, bookings: 5, windowDays: 7, attributionCoverage: null }).status).toBe('estimate_only')
  })
  it('ROAS with good attribution → real band', () => {
    expect(getMetricStatus('roas', 4, { ...ok, attributionCoverage: 0.7 }).status).toBe('excellent')
  })
})

describe('getMetricStatus — frequency / dormant / unknown', () => {
  it('frequency > 3.5 → critical, ≤2.5 → healthy', () => {
    expect(getMetricStatus('frequency', 4, { windowDays: 7 }).status).toBe('critical')
    expect(getMetricStatus('frequency', 2, { windowDays: 7 }).status).toBe('healthy')
  })
  it('dormant account → never a performance verdict', () => {
    expect(getMetricStatus('cpa', 55, { ...ok, dormant: true }).status).toBe('needs_data')
  })
  it('null value → unknown', () => {
    expect(getMetricStatus('cpa', null, ok).status).toBe('unknown')
  })
})

describe('shouldEvaluateMetric', () => {
  it('blocks below min spend / bookings / days', () => {
    expect(shouldEvaluateMetric('cpa', { spend: 10, bookings: 5, windowDays: 7 })).toBe(false)
    expect(shouldEvaluateMetric('cpa', { spend: 300, bookings: 1, windowDays: 7 })).toBe(false)
    expect(shouldEvaluateMetric('cpa', { spend: 300, bookings: 5, windowDays: 1 })).toBe(false)
    expect(shouldEvaluateMetric('cpa', { spend: 300, bookings: 5, windowDays: 7 })).toBe(true)
  })
})

describe('getConfidenceAdjustment', () => {
  it('low when thin or attribution poor; high when rich + attributed', () => {
    expect(getConfidenceAdjustment({ bookings: 0, spend: 5, windowDays: 1 })).toBe('low')
    expect(getConfidenceAdjustment({ bookings: 5, spend: 300, windowDays: 7, attributionCoverage: 0.7 })).toBe('high')
    expect(getConfidenceAdjustment({ dormant: true })).toBe('low')
  })
})
