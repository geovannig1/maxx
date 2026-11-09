import { afterEach, describe, it, expect } from 'vitest'
import { runGroundingGate, type GroundingInput } from '@/lib/recommendations/grounding-gate'
import { applyTargetOverrides } from '@/lib/targets/target-ranges'

// A well-grounded baseline that PASSES; individual tests knock out one condition at a time.
const grounded: GroundingInput = {
  recommendation_type: 'scale',
  spend: 600,
  bookings: 16,
  window_days: 14,
  data_age_hours: 5,
  data_sources_count: 2,
  uses_meta_estimate_as_revenue: false,
  days_since_last_change: 14,
  exited_learning: true,
  trend_stable: true,
  conflicting_signal: false,
  basis: 'observed_performance',
  reversible: true,
}

describe('runGroundingGate', () => {
  afterEach(() => applyTargetOverrides(null))

  it('the low-data warning names only the half that is SHORT, never one already cleared', () => {
    // `enoughSpend && enoughWindow` is an AND, so this branch runs when EITHER is short — and the
    // message blamed both. An owner could read "Only $1343 over 1d — below the bar to judge performance"
    // on a unit whose spend cleared the $20 floor FIFTY TIMES over.
    //
    // This is the always-visible surface: `low_data_warning` renders in RecCard's warning well,
    // while the sibling sentence in `builder.ts` sits inside the collapsed "Evidence & why"
    // expander — and once a money decision reaches owner_review, `recommendation-authority.ts`
    // discards that one and KEEPS this one. Fixing only the hidden sentence made it worse.
    const shortWindow = runGroundingGate({ ...grounded, spend: 1342.8, window_days: 1 })
    expect(shortWindow.warnings.low_data).toBeTruthy()
    expect(shortWindow.warnings.low_data).not.toMatch(/\$20 spend/)      // cleared 50x
    expect(shortWindow.warnings.low_data).toMatch(/days \(only 1 so far\)/) // the half that is short

    // ANTI-VACUITY: when spend really is the short half, it IS named.
    const shortSpend = runGroundingGate({ ...grounded, spend: 5, window_days: 14 })
    expect(shortSpend.warnings.low_data).toMatch(/\$20 spend \(only \$5 so far\)/)

    // ...and when both are short, both are named.
    const bothShort = runGroundingGate({ ...grounded, spend: 5, window_days: 1 })
    expect(bothShort.warnings.low_data).toMatch(/\$20 spend/)
    expect(bothShort.warnings.low_data).toMatch(/days/)
  })

  it('passes a fully grounded scale (capped at high-risk ceiling)', () => {
    const r = runGroundingGate(grounded)
    expect(r.passed).toBe(true)
    expect(r.decision).toBe('allow')
    expect(r.confidence_label).toBe('high')
    expect(r.risk_level).toBe('high') // scaling spends real money
    expect(r.warnings.low_data).toBeNull()
  })

  it('HOLDS an action when there is not enough data', () => {
    const r = runGroundingGate({ ...grounded, recommendation_type: 'pause', spend: 8, window_days: 2, bookings: 0 })
    expect(r.passed).toBe(false)
    expect(r.decision).toBe('hold')
    expect(r.warnings.low_data).not.toBeNull()
  })

  it('caps confidence and warns when revenue is a Meta estimate', () => {
    const r = runGroundingGate({ ...grounded, recommendation_type: 'keep', uses_meta_estimate_as_revenue: true })
    expect(r.warnings.estimate).not.toBeNull()
    expect(r.confidence_score).toBeLessThanOrEqual(0.6)
  })

  it('HOLDS a reversal that violates the no-oscillation rule', () => {
    const r = runGroundingGate({ ...grounded, recommendation_type: 'change_optimization_event', days_since_last_change: 1, exited_learning: false })
    expect(r.passed).toBe(false)
    expect(r.decision).toBe('hold')
    const check6 = r.checks.find((c) => c.id === 6)
    expect(check6?.status).toBe('fail')
  })

  it('downgrades an action based on a test hypothesis (not a confident claim)', () => {
    const r = runGroundingGate({ ...grounded, recommendation_type: 'change_audience', basis: 'test_hypothesis', days_since_last_change: null })
    expect(r.decision).toBe('downgrade_to_hypothesis')
    expect(r.passed).toBe(false)
    expect(r.confidence_score).toBeLessThanOrEqual(0.5)
  })

  it('blocks per-campaign actual-ROAS claims when attribution coverage is low', () => {
    const r = runGroundingGate({ ...grounded, recommendation_type: 'keep', claims_per_campaign_roas: true, attributed_share: 0 })
    expect(r.warnings.attribution).not.toBeNull()
    expect(r.confidence_score).toBeLessThanOrEqual(0.4)
  })

  it('HOLDS performance actions when the account is dormant', () => {
    const r = runGroundingGate({ ...grounded, recommendation_type: 'pause', account_dormant: true })
    expect(r.passed).toBe(false)
    expect(r.warnings.low_data).toMatch(/dormant|pre-launch/)
  })

  it('flags conflicting signals and lowers confidence', () => {
    const r = runGroundingGate({ ...grounded, conflicting_signal: true, conflicting_signal_note: 'Meta says 5 bookings, GA4 says 1.' })
    const check7 = r.checks.find((c) => c.id === 7)
    expect(check7?.status).toBe('fail')
    expect(r.confidence_score).toBeLessThan(0.85)
  })

  it('low CTR but good CPA should not be condemnable: a keep stays allowed on thin-but-converting data', () => {
    // non-action "keep" with a couple bookings — gate must not block it just for low CTR concerns.
    const r = runGroundingGate({ ...grounded, recommendation_type: 'keep', bookings: 3, window_days: 7, spend: 180 })
    expect(r.decision).toBe('allow')
  })

  it('evaluates zero-conversion spend against the active CPA target, not a module-load default', () => {
    applyTargetOverrides({ cpa: { healthy: 100 } })
    const r = runGroundingGate({
      ...grounded,
      recommendation_type: 'pause',
      spend: 150,
      bookings: 0,
      window_days: 14,
    })

    expect(r.checks.find((check) => check.id === 5)).toMatchObject({ status: 'fail' })
  })
})
