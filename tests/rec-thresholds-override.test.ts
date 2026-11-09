import { afterEach, describe, expect, it } from 'vitest'
import { REC_THRESHOLDS } from '@/lib/recommendations/thresholds'
import { applyTargetOverrides, getTargetRange } from '@/lib/targets/target-ranges'

/**
 * REC_THRESHOLDS must read the LIVE CPA band, not a snapshot taken at import time.
 *
 * The defect this pins: `TARGET_CPA` and `MAX_CPA` were `METRIC_RANGES.cpa.healthy` / `.watch`,
 * evaluated once when the module was first imported — before `applyTargetOverrides` runs. An
 * owner-approved band change was therefore accepted by the Settings page, returned correctly by
 * `getTargetRange`, and IGNORED by every consumer of REC_THRESHOLDS: the grounding gate, the
 * operating-mode detector, the flag engine, the health route.
 *
 * That is worse than not supporting overrides at all, because everyone believes the approval took:
 * a band that is too strict for the business's economics keeps biasing every CPA verdict toward
 * kill/reduce even after the owner has corrected it.
 */
describe('REC_THRESHOLDS reads the live CPA band', () => {
  afterEach(() => {
    applyTargetOverrides(null) // reset to defaults so ordering cannot leak between tests
  })

  it('matches the default band when no override is applied', () => {
    applyTargetOverrides(null)
    expect(REC_THRESHOLDS.TARGET_CPA).toBe(getTargetRange('cpa').healthy)
    expect(REC_THRESHOLDS.MAX_CPA).toBe(getTargetRange('cpa').watch)
  })

  it('follows an owner override — the whole point', () => {
    const before = REC_THRESHOLDS.TARGET_CPA
    applyTargetOverrides({ cpa: { healthy: 112, watch: 171 } })
    expect(REC_THRESHOLDS.TARGET_CPA).toBe(112)
    expect(REC_THRESHOLDS.MAX_CPA).toBe(171)
    // Guard the test itself: if the default already equalled the override, the assertions above
    // would pass on a frozen snapshot and prove nothing.
    expect(before).not.toBe(112)
  })

  it('follows a SECOND override without a reload, proving it is not cached after first read', () => {
    applyTargetOverrides({ cpa: { healthy: 112, watch: 171 } })
    expect(REC_THRESHOLDS.TARGET_CPA).toBe(112)
    applyTargetOverrides({ cpa: { healthy: 87, watch: 133 } })
    expect(REC_THRESHOLDS.TARGET_CPA).toBe(87)
    expect(REC_THRESHOLDS.MAX_CPA).toBe(133)
  })

  it('returns to the default when the override is cleared', () => {
    const original = getTargetRange('cpa').healthy
    applyTargetOverrides({ cpa: { healthy: 112, watch: 171 } })
    expect(REC_THRESHOLDS.TARGET_CPA).toBe(112)
    applyTargetOverrides(null)
    expect(REC_THRESHOLDS.TARGET_CPA).toBe(original)
  })
})
