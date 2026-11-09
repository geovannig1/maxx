import { describe, it, expect } from 'vitest'
import { evaluateFlag, type FlagInput } from '@/lib/flags/rules'
import { applyExampleOwnerTargetsPerTest } from './helpers/example-targets'

// cost metrics have no built-in target; these suites test behaviour WITH the owner's target set.
applyExampleOwnerTargetsPerTest()

// Sensible defaults; each test overrides only what it exercises.
function input(overrides: Partial<FlagInput>): FlagInput {
  return {
    spend: 100,
    cpa: null,
    cpl: null,
    ctr: 1.0,
    frequency: 1.5,
    impressions: 1000,
    bookings: 0,
    leads: 0,
    roas: null,
    window_days: 7,
    entity_age_days: 10,
    audience_type: 'consumer',
    ...overrides,
  }
}

describe('evaluateFlag', () => {
  it('flags too_early when spend is below the judging floor', () => {
    const flag = evaluateFlag(input({ spend: 10 }))
    expect(flag?.flag_type).toBe('too_early')
  })

  it('the too-early reason names only the floor that is actually short', () => {
    const shortAge = evaluateFlag(input({ spend: 1342.8, entity_age_days: 1, window_days: 7 }))
    expect(shortAge?.flag_type).toBe('too_early')
    expect(shortAge?.reason).toContain('age is 1 day(s)')
    expect(shortAge?.reason).not.toMatch(/Only 1342\.8 spent/)
    expect(shortAge?.reason).not.toMatch(/\$20 spend/)
    expect(shortAge?.candidate.observation).toContain('age is 1 day(s)')
    expect(shortAge?.candidate.observation).not.toContain('$1342.8')

    const shortSpend = evaluateFlag(input({ spend: 5, entity_age_days: 10, window_days: 7 }))
    expect(shortSpend?.flag_type).toBe('too_early')
    expect(shortSpend?.reason).toContain('$20 spend')
    expect(shortSpend?.reason).not.toContain('age is')
    expect(shortSpend?.candidate.observation).toContain('$20 spend')
    expect(shortSpend?.candidate.observation).not.toContain('10 day(s)')
  })

  it('flags a zero-booking burner as a loser on a ≥3-day window', () => {
    const flag = evaluateFlag(input({ bookings: 0, spend: 150, impressions: 1000, window_days: 7 }))
    expect(flag?.flag_type).toBe('loser')
  })

  // 3x zero-outcome stop tier: spend ≥ 3× max-acceptable CPA ($294) with zero bookings is a stop,
  // not a review — and it must win over the 2x review rule when both match.
  it('fires the 3x stop tier with explicit stop language when spend ≥ 3× max CPA with zero bookings', () => {
    const flag = evaluateFlag(input({ bookings: 0, spend: 320, impressions: 5000, window_days: 7 }))
    expect(flag?.flag_type).toBe('loser')
    expect(flag?.confidence).toBe('high')
    expect(flag?.reason).toMatch(/3x stop tier/)
    expect(flag?.candidate.kind).toBe('pause')
    expect(flag?.candidate.observation).toMatch(/continued delivery is the risk/i)
  })

  it('keeps the 2x review tier (no stop language) between 2× target and 3× max CPA', () => {
    const flag = evaluateFlag(input({ bookings: 0, spend: 200, impressions: 5000, window_days: 7 }))
    expect(flag?.flag_type).toBe('loser')
    expect(flag?.reason).not.toMatch(/3x stop tier/)
  })

  it('stop tier still requires the ≥3-day window and impression floor', () => {
    const shortWindow = evaluateFlag(input({ bookings: 0, spend: 320, impressions: 5000, window_days: 2 }))
    expect(shortWindow?.reason ?? '').not.toMatch(/3x stop tier/)
    const thinDelivery = evaluateFlag(input({ bookings: 0, spend: 320, impressions: 300, window_days: 7 }))
    expect(thinDelivery?.reason ?? '').not.toMatch(/3x stop tier/)
  })

  // A single bad day must not condemn an entity — conversions lag (7d-click attribution).
  it('does NOT flag a loser on a 1-day window', () => {
    const flag = evaluateFlag(input({ bookings: 0, spend: 150, impressions: 1000, window_days: 1 }))
    expect(flag?.flag_type).not.toBe('loser')
  })

  it('flags a winner with sustained low CPA over a ≥7-day window', () => {
    const flag = evaluateFlag(input({ cpa: 50, bookings: 4, leads: 4, ctr: 2, window_days: 7 }))
    expect(flag?.flag_type).toBe('winner')
    expect(flag?.confidence).toBe('medium') // bookings < 7 → medium, not high
  })

  it('does NOT promote to winner before a 7-day window', () => {
    const flag = evaluateFlag(input({ cpa: 50, bookings: 4, leads: 4, ctr: 2, window_days: 3 }))
    expect(flag?.flag_type).not.toBe('winner')
  })

  // Phase-4 fix: low CTR + cheap bookings must NOT be condemned as a loser (the funnel works).
  it('does NOT flag low CTR as a loser when the ad converts cheaply', () => {
    const flag = evaluateFlag(input({ ctr: 0.3, impressions: 5000, bookings: 4, leads: 4, cpa: 50, window_days: 7 }))
    expect(flag?.flag_type).not.toBe('loser')
  })

  it('DOES flag low CTR as a loser when there are no cheap bookings', () => {
    const flag = evaluateFlag(input({ ctr: 0.3, impressions: 5000, bookings: 0, cpa: null, spend: 60, window_days: 7 }))
    expect(flag?.flag_type).toBe('loser')
  })
})
