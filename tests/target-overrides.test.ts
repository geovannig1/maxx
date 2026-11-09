import { describe, it, expect, afterEach } from 'vitest'
import {
  mergeRanges, applyTargetOverrides, getActiveRanges, getMetricStatus, getTargetRange, METRIC_RANGES,
} from '@/lib/targets/target-ranges'
import { applyExampleOwnerTargetsPerTest, withExampleTargets } from './helpers/example-targets'

// cost metrics have no built-in target; these suites test behaviour WITH the owner's target set.
applyExampleOwnerTargetsPerTest()

afterEach(() => applyTargetOverrides(null)) // reset module state between tests

describe('mergeRanges', () => {
  it('returns the defaults when there are no overrides', () => {
    expect(mergeRanges(null)).toBe(METRIC_RANGES)
  })

  it('overrides only the given fields on the given metric, leaving others default', () => {
    const merged = mergeRanges({ cpl: { healthy: 30, watch: 45 } })
    expect(merged.cpl.healthy).toBe(30)
    expect(merged.cpl.watch).toBe(45)
    expect(merged.cpl.excellent).toBe(METRIC_RANGES.cpl.excellent) // untouched
    expect(merged.cpa.healthy).toBe(METRIC_RANGES.cpa.healthy) // other metric untouched
  })
})

describe('applyTargetOverrides', () => {
  const ctx = { spend: 100, windowDays: 7 }

  it('re-bands getMetricStatus once overrides are active', () => {
    // Example owner target: CPL 35 ≤ healthy(37) → healthy.
    expect(getMetricStatus('cpl', 35, ctx).status).toBe('healthy')
    applyTargetOverrides({ cpl: { healthy: 30, watch: 45 } })
    // Now healthy=30, watch=45 → 35 is in the watch band.
    expect(getMetricStatus('cpl', 35, ctx).status).toBe('watch')
    expect(getTargetRange('cpl').healthy).toBe(30)
  })

  it('applies tightened min-data gates', () => {
    // Default cpl minSpend=20 → spend 100 passes.
    expect(getMetricStatus('cpl', 35, { spend: 100, windowDays: 7 }).status).toBe('healthy')
    applyTargetOverrides(withExampleTargets({ cpl: { minSpend: 500 } }))
    // Spend 100 < 500 → needs_data.
    expect(getMetricStatus('cpl', 35, { spend: 100, windowDays: 7 }).status).toBe('needs_data')
  })

  it('resets to defaults with null', () => {
    applyTargetOverrides({ cpl: { healthy: 5 } })
    expect(getActiveRanges().cpl.healthy).toBe(5)
    applyTargetOverrides(null)
    expect(getActiveRanges().cpl.healthy).toBe(METRIC_RANGES.cpl.healthy)
  })
})
