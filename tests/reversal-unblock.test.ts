import { describe, it, expect } from 'vitest'
import { flagToRecommendationInput, type FlagRow } from '@/lib/recommendations/generate'
import { buildRecommendation } from '@/lib/recommendations/builder'
import { applyExampleOwnerTargetsPerTest } from './helpers/example-targets'

// cost metrics have no built-in target; these suites test behaviour WITH the owner's target set.
applyExampleOwnerTargetsPerTest()

// N1 regression: a WELL-GROUNDED, stable scale/pause must KEEP its action type instead of collapsing to
// `hold`. Before N1, flagToRecommendationInput never set trend_stable/exited_learning/days_since_last_change,
// so every reversal-class rec hard-blocked → hold. The generate caller now threads those fields from
// synced data; these tests pin the builder+gate outcome when they are present (grounded) vs absent (thin).

const today = '2026-06-15'

const scaleFlag: FlagRow = {
  id: 'f1', entity_level: 'adset', campaign_id: 'c1', adset_id: 'as1', ad_id: null,
  flag_type: 'scale_candidate', reason: 'CPA $64 over 14d with 10 bookings; headroom to scale',
  recommended_action: 'Scale budget +20%.', watch_next: '',
  window_days: 14, evidence: { spend: 640, bookings: 10, cpa: 64, ctr: 2.4, frequency: 1.9, impressions: 8000, window_days: 14 },
}

// A high-CPA loser: it DOES convert (≥3 bookings), but at ~3x the target CPA — a genuine, groundable pause.
const loserFlag: FlagRow = {
  id: 'f2', entity_level: 'adset', campaign_id: 'c1', adset_id: 'as2', ad_id: null,
  flag_type: 'loser', reason: 'CPA $192 over 7d — 3x the $64 target',
  recommended_action: 'Pause — unprofitable.', watch_next: '',
  window_days: 7, evidence: { spend: 768, bookings: 4, cpa: 192, ctr: 1.1, frequency: 1.6, impressions: 6000, window_days: 7 },
}

// N1b: a pure 0-booking waster — spent ≥ 2x target CPA over a full window and booked nothing. The
// absence of conversions IS the evidence to cut; grounding-gate check 5 now lets a waste-cut through.
const wasterFlag: FlagRow = {
  id: 'f4', entity_level: 'adset', campaign_id: 'c1', adset_id: 'as4', ad_id: null,
  flag_type: 'loser', reason: '$200 spent over 7d, 0 AppointmentConfirmed after 4,000 impressions',
  recommended_action: 'Pause — spend is not converting.', watch_next: '',
  window_days: 7, evidence: { spend: 200, bookings: 0, cpa: null, ctr: 0.4, frequency: 1.2, impressions: 4000, window_days: 7 },
}

// mimic the generate caller threading the reversal-class grounding fields onto the input
const grounded = <T extends object>(base: T) => ({ ...base, trend_stable: true, exited_learning: true, days_since_last_change: 14 })

describe('N1 — reversal-class recs keep their type when well-grounded and stable', () => {
  it('a well-grounded STABLE scale KEEPS scale (does not collapse to hold)', () => {
    const rec = buildRecommendation(grounded(flagToRecommendationInput(scaleFlag, 'Winner AdSet', today)))
    expect(rec.recommendation_type).toBe('scale')
    expect(rec.action_allowed_now).toBe(false) // still read-only / approval-gated
    expect(rec.approval_required).toBe(true)
  })

  it('a well-grounded STABLE loser KEEPS pause', () => {
    const rec = buildRecommendation(grounded(flagToRecommendationInput(loserFlag, 'Waster AdSet', today)))
    expect(rec.recommendation_type).toBe('pause')
    expect(rec.action_allowed_now).toBe(false)
  })

  it('the SAME scale still HOLDS when the trend is not confirmed stable (null)', () => {
    // no threading → trend_stable/exited_learning/days_since_last_change stay undefined (null in the gate)
    const rec = buildRecommendation(flagToRecommendationInput(scaleFlag, 'Winner AdSet', today))
    expect(rec.recommendation_type).toBe('hold')
    expect(rec.no_oscillation_check.blocking_factors.join(' ')).toMatch(/stable/i)
  })

  it('a thin loser still HOLDS even when marked stable (volume/window gate)', () => {
    const thin: FlagRow = { ...loserFlag, window_days: 3, evidence: { spend: 8, bookings: 0, cpa: null, ctr: 0.3, frequency: 1.1, impressions: 300, window_days: 3 } }
    const rec = buildRecommendation(grounded(flagToRecommendationInput(thin, 'Thin AdSet', today)))
    expect(rec.recommendation_type).toBe('hold')
  })
})

describe('N1b — a high-spend 0-booking waster is pausable (non-conversion is the evidence)', () => {
  it('a well-grounded 0-booking waster (spent ≥ 2x target CPA) KEEPS pause', () => {
    const rec = buildRecommendation(grounded(flagToRecommendationInput(wasterFlag, 'Waster AdSet', today)))
    expect(rec.recommendation_type).toBe('pause')
    expect(rec.action_allowed_now).toBe(false) // still approval-gated / write mode off
    expect(rec.confidence_label).not.toBe('high') // a cut on absence-of-conversions is medium at most
  })

  it('a thin 0-booking entity (spent < 2x target CPA) still HOLDS', () => {
    const thinWaster: FlagRow = { ...wasterFlag, evidence: { spend: 40, bookings: 0, cpa: null, ctr: 0.4, frequency: 1.1, impressions: 900, window_days: 7 } }
    const rec = buildRecommendation(grounded(flagToRecommendationInput(thinWaster, 'Thin Waster', today)))
    expect(rec.recommendation_type).toBe('hold')
  })

  it('does NOT let scale through on 0 bookings — positive claims still need the sample', () => {
    const scaleNoBookings: FlagRow = { ...scaleFlag, evidence: { spend: 600, bookings: 0, cpa: null, ctr: 2.4, frequency: 1.9, impressions: 8000, window_days: 14 } }
    const rec = buildRecommendation(grounded(flagToRecommendationInput(scaleNoBookings, 'No-booking scale', today)))
    expect(rec.recommendation_type).toBe('hold')
  })
})

describe('N8 — estimate flag is set per flag type (not hardcoded true)', () => {
  it('CPA-based flags rest on the Meta estimate → uses_meta_estimate_as_revenue true', () => {
    expect(flagToRecommendationInput(scaleFlag, null, today).uses_meta_estimate_as_revenue).toBe(true)
    expect(flagToRecommendationInput(loserFlag, null, today).uses_meta_estimate_as_revenue).toBe(true)
  })

  it('a frequency/fatigue (creative_refresh) claim does NOT rely on estimated revenue → false', () => {
    const fatigue: FlagRow = {
      id: 'f3', entity_level: 'ad', campaign_id: 'c1', adset_id: 'as1', ad_id: 'ad1',
      flag_type: 'creative_refresh', reason: 'Frequency 4.0', recommended_action: 'Refresh creative.', watch_next: '',
      window_days: 7, evidence: { spend: 200, bookings: 2, cpa: 100, ctr: 1.0, frequency: 4.0, impressions: 5000, window_days: 7 },
    }
    expect(flagToRecommendationInput(fatigue, null, today).uses_meta_estimate_as_revenue).toBe(false)
  })
})
