import { afterEach, describe, expect, it, vi } from 'vitest'
import { evaluateFlag, type FlagInput } from '@/lib/flags/rules'
import { applyTargetOverrides } from '@/lib/targets/target-ranges'
import { REC_THRESHOLDS } from '@/lib/recommendations/thresholds'
import { checkZeroConversions } from '@/lib/alerts/thresholds'

// Decision: the zero-outcome review (2x the CPA target) and stop (3x the maximum CPA) tiers need an
// owner-set CPA target and never fire without one. A fallback built from the spend floor would be an
// invented commercial threshold (removed built-in targets): NEXT_PUBLIC_MIN_SPEND_TO_JUDGE says when
// there is enough data to look, not how much spend without outcomes is too much for this business.
// Without a target the owner is asked to set one ("Set a target"), and an entity that normally converts
// is still reported by the zero-conversion alert when it spends with none.

const zeroOutcomes = (spend: number): FlagInput => ({
  spend, cpa: null, cpl: null, ctr: 1.5, frequency: 1.2, impressions: 20_000, bookings: 0, leads: 0, roas: null,
  window_days: 7, entity_age_days: 14, audience_type: 'cold' as FlagInput['audience_type'],
})

afterEach(() => {
  applyTargetOverrides(null)
  vi.unstubAllEnvs()
})

describe('zero-outcome tiers need a CPA target', () => {
  it('never fires a zero-outcome tier without a target, however large the spend, in USD or JPY', () => {
    expect(REC_THRESHOLDS.MAX_CPA).toBeNull()
    for (const spend of [100, 10_000, 1_000_000]) expect(evaluateFlag(zeroOutcomes(spend)), `USD ${spend}`).toBeNull()
    vi.stubEnv('NEXT_PUBLIC_ACCOUNT_CURRENCY', 'JPY')
    vi.stubEnv('NEXT_PUBLIC_MIN_SPEND_TO_JUDGE', '3000')
    for (const spend of [15_000, 1_000_000, 100_000_000]) expect(evaluateFlag(zeroOutcomes(spend)), `JPY ${spend}`).toBeNull()
  })

  it('fires the review tier at 2x the target and the stop tier at 3x the maximum once a target is set (control)', () => {
    applyTargetOverrides({ cpa: { healthy: 64, watch: 98 } })
    expect(evaluateFlag(zeroOutcomes(127))).toBeNull()
    const review = evaluateFlag(zeroOutcomes(128))
    expect([review?.flag_type, review?.reason]).toEqual(['loser', expect.not.stringContaining('stop tier')])
    const stop = evaluateFlag(zeroOutcomes(294))
    expect([stop?.flag_type, stop?.reason]).toEqual(['loser', expect.stringContaining('3x stop tier')])
  })

  it('still reports spend without outcomes for an entity that normally converts, with no target set', () => {
    expect(REC_THRESHOLDS.TARGET_CPA).toBeNull()
    expect(checkZeroConversions({ todayConversions: 0, spend: 20, baselineConversions: 2 })).toBe('warning')
    expect(checkZeroConversions({ todayConversions: 0, spend: 20, baselineConversions: 0 })).toBeNull()
  })
})
