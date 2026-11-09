import { describe, it, expect } from 'vitest'
import { evaluateFlag, type FlagInput } from '@/lib/flags/rules'
import { getTargetRange } from '@/lib/targets/target-ranges'
import { applyExampleOwnerTargetsPerTest } from './helpers/example-targets'

// cost metrics have no built-in target; these suites test behaviour WITH the owner's target set.
applyExampleOwnerTargetsPerTest()

// The creative_refresh flag picks its DIAGNOSIS from a bare `cpa <= targetCpa()`:
//   pass → "the AD works; the CREATIVE is tiring"
//   fail → "the audience looks saturated for this asset"
// Two completely different causes, and at a small account's volume (a handful of bookings a week) the comparison
// is noise. One booking either way flips the story.
//
// decisiveCpaVsTarget() was written for exactly this ("2 bookings flips worked↔failed") and
// lives in lib/learning/model.ts, wired only into pattern learning — never into the flags that
// actually drive recommendations.

const target = () => getTargetRange('cpa').healthy! // set by applyExampleOwnerTargetsPerTest

function fatigued(over: Partial<FlagInput> = {}): FlagInput {
  return {
    spend: 300,
    cpa: null,
    cpl: null,
    ctr: 1.2,
    frequency: 5.0, // above freqCritical → creative_refresh path
    impressions: 20_000,
    bookings: 0,
    leads: 0,
    roas: null,
    window_days: 7,
    audience_type: 'consumer',
    peak_ctr: 2.4,
    ...over,
  }
}

describe('creative_refresh diagnosis must survive the booking-count noise floor', () => {
  it('does not assert "the AD works" from a CPA beat on 2 bookings', () => {
    // 2 bookings, CPA nominally under target. Poisson interval on a count of 2 is roughly
    // [0, 4.3] — the true CPA could be half or double. Not a basis for naming the cause.
    const cpa = target() * 0.8
    const rule = evaluateFlag(fatigued({ bookings: 2, cpa, spend: cpa * 2 }))

    expect(rule?.flag_type).toBe('creative_refresh')
    expect(rule?.reason).not.toMatch(/the AD works/i)
    expect(rule?.candidate?.observation ?? '').not.toMatch(/the creative is tiring, the ad is not failing/i)
    // It must say the comparison is not decisive rather than silently picking a side.
    expect(`${rule?.reason} ${rule?.candidate?.observation ?? ''}`).toMatch(/not decisive|inconclusive|too few/i)
  })

  it('does not assert saturation from a CPA miss on 2 bookings either', () => {
    // The failing branch is equally unearned — "the audience looks saturated" is a causal claim.
    const cpa = target() * 1.6
    const rule = evaluateFlag(fatigued({ bookings: 2, cpa, spend: cpa * 2 }))

    expect(rule?.flag_type).toBe('creative_refresh')
    expect(rule?.candidate?.observation ?? '').not.toMatch(/audience looks saturated/i)
    expect(`${rule?.reason} ${rule?.candidate?.observation ?? ''}`).toMatch(/not decisive|inconclusive|too few/i)
  })

  it('still withholds creative causality when the modelled CPA interval is precise', () => {
    // A precise modelled result can describe delivery economics, but it is not a controlled test of
    // whether the ad works or creative wear caused the frequency/CTR pattern.
    const cpa = target() * 0.4
    const rule = evaluateFlag(fatigued({ bookings: 40, cpa, spend: cpa * 40 }))

    expect(rule?.flag_type).toBe('creative_refresh')
    expect(rule?.reason).toMatch(/does not prove the ad works or that creative wear caused/i)
    expect(rule?.candidate?.observation ?? '').toMatch(/cause nor a refresh response is proven/i)
    expect(rule?.candidate?.observation ?? '').not.toMatch(/creative is tiring|fresh creative is the response/i)
  })

  it('zero bookings reports absence, and never claims saturation as the cause', () => {
    const rule = evaluateFlag(fatigued({ bookings: 0, cpa: null }))
    expect(rule?.reason).toMatch(/No Meta-modelled conversions in the window/i)
    // prompt-builder.ts rule 5: frequency is a raw delivery observation. Without a verified
    // audience definition/size it may not be called fatigue or proof of saturation — and audience
    // size is exactly what we cannot read (Ads Manager's bucket is unavailable; MAU is an estimate).
    expect(rule?.candidate?.observation ?? '').not.toMatch(/saturated/i)
  })
})
