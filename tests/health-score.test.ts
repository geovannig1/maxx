import { describe, it, expect } from 'vitest'
import {
  computeHealthScore,
  frequencyForHealthWindow,
  type HealthScoreInput,
} from '@/lib/creative/health-score'
import { applyExampleOwnerTargetsPerTest } from './helpers/example-targets'

// cost metrics have no built-in target; these suites test behaviour WITH the owner's target set.
applyExampleOwnerTargetsPerTest()

function input(overrides: Partial<HealthScoreInput>): HealthScoreInput {
  return {
    spend: 300,
    bookings: 5,
    ctr: 1.5,
    cpa: 55,
    frequency: 1.8,
    impressions: 5000,
    entity_age_days: 10,
    hook_rate: null,
    ...overrides,
  }
}

describe('computeHealthScore', () => {
  it('grades a top performer as excellent (max score)', () => {
    // A retention rate now needs a KNOWN length to be scored — the band ladder is length-specific.
    const r = computeHealthScore(input({ cpa: 40, ctr: 2.5, frequency: 1.2, entity_age_days: 5, hook_rate: 0.50, video_duration_seconds: 15 }))
    expect(r.score).toBe(100)
    expect(r.grade).toBe('excellent')
  })

  // The 'critical' tier IS reachable — a mature, failing ad must land there.
  it('grades a mature failing ad as critical', () => {
    const r = computeHealthScore(input({ cpa: 120, ctr: 0.3, frequency: 4.0, entity_age_days: 40, hook_rate: 0.02, video_duration_seconds: 15 }))
    // cpa>98→0, ctr<0.5→0, freq>3.5→0, age>30→2, retention 0.02 < short-weak 0.10 → 0
    expect(r.score).toBe(2)
    expect(r.grade).toBe('critical')
  })

  it('grades a mid ad as attention', () => {
    const r = computeHealthScore(input({ cpa: 70, ctr: 1.2, frequency: 2.2, entity_age_days: 20, hook_rate: null }))
    // cpa<=81→15, ctr>=1.0→15, freq<=2.5→11, age<=21→11, hook null→5  => 57
    expect(r.score).toBe(57)
    expect(r.grade).toBe('attention')
  })

  it('caps the score at 100', () => {
    const r = computeHealthScore(input({ cpa: 10, ctr: 5, frequency: 1.0, entity_age_days: 1, hook_rate: 0.9, video_duration_seconds: 30 }))
    expect(r.score).toBeLessThanOrEqual(100)
  })
})

describe('health-score frequency scope', () => {
  it('withholds the composite when required frequency is unavailable, even if every other component is maximal', () => {
    const result = computeHealthScore(input({
      cpa: 10,
      ctr: 5,
      frequency: null,
      entity_age_days: 1,
      hook_rate: 0.9,
      video_duration_seconds: 30,
    }))

    expect(result.score).toBeNull()
    expect(result.grade).toBe('unavailable')
    expect(result.breakdown.frequency_score).toBeNull()
    expect(result.dataSufficient).toBe(false)
    expect(result.color).toBe('var(--text-tertiary)')
    expect(result.signal).toMatch(/grade withheld.*frequency is unavailable/i)
  })

  it('withholds frequency for a requested multi-day daily-row window', () => {
    const frequency = frequencyForHealthWindow([
      { frequency: 4.2, impressions: 1_000, reach: 250 },
      { frequency: 4.4, impressions: 1_100, reach: 250 },
    ], { requestedWindowDays: 7 })

    expect(frequency).toBeNull()
  })

  it('withholds one sparse daily row when the requested scope is seven days', () => {
    expect(frequencyForHealthWindow([
      { frequency: 3.7, impressions: 1_000, reach: 270 },
    ], { requestedWindowDays: 7 })).toBeNull()
  })

  it('uses the stored frequency only for one explicitly requested daily row', () => {
    const frequency = frequencyForHealthWindow([
      { frequency: 3.7, impressions: 1_000, reach: 270 },
    ], { requestedWindowDays: 1 })
    expect(frequency).toBe(3.7)

    const result = computeHealthScore(input({ frequency }))
    expect(result.signal).toMatch(/High daily frequency observed/)
    expect(result.signal).toMatch(/no cause can be established/i)
    expect(result.signal).not.toMatch(/fatigue|frequency rising|setting in/i)
  })

  it('withholds malformed or absent daily frequency', () => {
    const scope = { requestedWindowDays: 1 }
    expect(frequencyForHealthWindow([{ frequency: null }], scope)).toBeNull()
    expect(frequencyForHealthWindow([{ frequency: 0 }], scope)).toBeNull()
    expect(frequencyForHealthWindow([{ frequency: 'not-a-number' }], scope)).toBeNull()
    expect(frequencyForHealthWindow([], scope)).toBeNull()
  })
})

// Regression: the batch runner passed hook_rate:null so the component was inert for every ad. It now
// feeds the real retention fraction. A later change made the ladder LENGTH-AWARE: the input is retention at the
// 25% milestone (25% of the video's LENGTH), never a three-second hook, and reaching it on a 125s
// creative is a far higher bar than on a 15s one. These lock the FRACTION contract (so nobody
// reintroduces a percent-scaled value) AND the length contract.
describe('computeHealthScore — retention component (fractional, length-aware)', () => {
  it('bands a SHORT video on the short ladder', () => {
    const d = { video_duration_seconds: 15 }
    expect(computeHealthScore(input({ hook_rate: 0.50, ...d })).breakdown.retention_score).toBe(10)
    expect(computeHealthScore(input({ hook_rate: 0.30, ...d })).breakdown.retention_score).toBe(8)
    expect(computeHealthScore(input({ hook_rate: 0.20, ...d })).breakdown.retention_score).toBe(6)
    expect(computeHealthScore(input({ hook_rate: 0.10, ...d })).breakdown.retention_score).toBe(3)
    expect(computeHealthScore(input({ hook_rate: 0.09, ...d })).breakdown.retention_score).toBe(0)
  })

  it('bands a LONG video on the long ladder — the same rate scores higher', () => {
    const d = { video_duration_seconds: 125 }
    expect(computeHealthScore(input({ hook_rate: 0.20, ...d })).breakdown.retention_score).toBe(10)
    expect(computeHealthScore(input({ hook_rate: 0.12, ...d })).breakdown.retention_score).toBe(8)
    expect(computeHealthScore(input({ hook_rate: 0.07, ...d })).breakdown.retention_score).toBe(6)
    expect(computeHealthScore(input({ hook_rate: 0.03, ...d })).breakdown.retention_score).toBe(3)
    expect(computeHealthScore(input({ hook_rate: 0.02, ...d })).breakdown.retention_score).toBe(0)
  })

  it('the SAME rate is scored differently by length — the core length-aware property', () => {
    const short = computeHealthScore(input({ hook_rate: 0.20, video_duration_seconds: 15 })).breakdown.retention_score
    const long = computeHealthScore(input({ hook_rate: 0.20, video_duration_seconds: 125 })).breakdown.retention_score
    expect(long).toBeGreaterThan(short)
  })

  it('an UNKNOWN video length scores the neutral 5 — no ladder is guessed', () => {
    expect(computeHealthScore(input({ hook_rate: 0.22, video_duration_seconds: null })).breakdown.retention_score).toBe(5)
    expect(computeHealthScore(input({ hook_rate: 0.22 })).breakdown.retention_score).toBe(5)
  })

  it('scores the neutral 5 for a non-video ad (null rate)', () => {
    expect(computeHealthScore(input({ hook_rate: null, video_duration_seconds: 15 })).breakdown.retention_score).toBe(5)
  })

  it('unit guard: a percent-scaled value is out of contract — 15 must not be passed here', () => {
    // hook_rate is a FRACTION. A percent leaking in saturates the band, which is why the batch runner
    // computes total_p25 / video-starts rather than reusing a daily percentage.
    expect(computeHealthScore(input({ hook_rate: 15, video_duration_seconds: 15 })).breakdown.retention_score).toBe(10)
  })
})
