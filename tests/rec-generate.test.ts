import { describe, it, expect } from 'vitest'
import {
  flagToRecommendationInput,
  insightWindowDataAgeHours,
  latestDataAgeHours,
  paidCohortOutcomeForAction,
  paidCohortRefForFlag,
  type FlagRow,
} from '@/lib/recommendations/generate'
import { buildRecommendation } from '@/lib/recommendations/builder'
import type { PaidCohortPairEvidence } from '@/lib/attribution/paid-cohort-store'
import { applyExampleOwnerTargetsPerTest } from './helpers/example-targets'

// cost metrics have no built-in target; these suites test behaviour WITH the owner's target set.
applyExampleOwnerTargetsPerTest()

const today = '2026-06-15'

const winnerGood: FlagRow = {
  id: 'f1', entity_level: 'adset', campaign_id: 'c1', adset_id: 'as1', ad_id: null,
  flag_type: 'winner', reason: 'CPA $50 over 7d with 5 bookings', recommended_action: 'Keep running.', watch_next: '',
  window_days: 7, evidence: { spend: 300, bookings: 5, cpa: 50, ctr: 2.5, frequency: 1.8, impressions: 2000, window_days: 7 },
}
const loserThin: FlagRow = {
  id: 'f2', entity_level: 'adset', campaign_id: 'c1', adset_id: 'as2', ad_id: null,
  flag_type: 'loser', reason: '$10 spent, 0 bookings', recommended_action: 'Pause and investigate.', watch_next: '',
  window_days: 3, evidence: { spend: 10, bookings: 0, cpa: null, ctr: 0.3, frequency: 1.1, impressions: 600, window_days: 3 },
}
const fatigue: FlagRow = {
  id: 'f3', entity_level: 'ad', campaign_id: 'c1', adset_id: 'as1', ad_id: 'ad1',
  flag_type: 'creative_refresh', reason: 'Frequency 4.0', recommended_action: 'Refresh creative.', watch_next: '',
  window_days: 7, evidence: { spend: 200, bookings: 2, cpa: 100, ctr: 1.0, frequency: 4.0, impressions: 5000, window_days: 7 },
}

describe('flagToRecommendationInput (pure mapping)', () => {
  it('maps flag types to recommendation types', () => {
    expect(flagToRecommendationInput(winnerGood, 'Cold', today).recommendation_type).toBe('keep')
    expect(flagToRecommendationInput(loserThin, 'Cold', today).recommendation_type).toBe('pause')
    expect(flagToRecommendationInput(fatigue, 'Ad 1', today).recommendation_type).toBe('refresh_creative')
  })
  it('withholds multi-day frequency while retaining CPA as the primary performance metric', () => {
    expect(flagToRecommendationInput(fatigue, null, today).primary_metric).toEqual({ metric: 'frequency', value: null })
    expect(flagToRecommendationInput(winnerGood, null, today).primary_metric).toEqual({ metric: 'cpa', value: 50 })
  })
  it('derives the date range from the window', () => {
    const inp = flagToRecommendationInput(winnerGood, null, today)
    expect(inp.date_range).toEqual({ start: '2026-06-09', end: '2026-06-15' }) // 7-day window through today
  })

  it('uses the level-specific Meta id for paid cohort evidence and never substitutes a DB id', () => {
    expect(paidCohortRefForFlag({
      ...winnerGood, meta_campaign_id: 'mc1', meta_adset_id: 'mas1', meta_ad_id: null,
    })).toEqual({ entityLevel: 'adset', entityId: 'mas1' })
    expect(paidCohortRefForFlag(winnerGood)).toBeNull()
  })

  it('selects the direction-specific committed cohort outcome for preflight', () => {
    const pair: PaidCohortPairEvidence = {
      evaluationRunId: '00000000-0000-4000-8000-000000000101',
      recentScale: {
        generationId: '00000000-0000-4000-8000-000000000102', cohortKind: 'recent_scale',
        windowStart: '2026-07-16', windowEnd: '2026-07-29', asOfDate: '2026-07-30',
        complete: true, blockerCodes: [], generationComplete: true, generationBlockerCodes: [],
        spend: 100, bookings: 4, bookedValue: 800, metrics: {},
      },
      maturedCut: {
        generationId: '00000000-0000-4000-8000-000000000103', cohortKind: 'matured_cut',
        windowStart: '2026-07-02', windowEnd: '2026-07-15', asOfDate: '2026-07-30',
        complete: true, blockerCodes: [], generationComplete: true, generationBlockerCodes: [],
        spend: 300, bookings: 0, bookedValue: 0, metrics: {},
      },
    }
    const ref = { entityLevel: 'adset' as const, entityId: 'meta-as-1' }

    expect(paidCohortOutcomeForAction(pair, ref, 'budget_scale', 'interaction_cohort_complete'))
      .toMatchObject({ value: 4, scope: 'adset' })
    expect(paidCohortOutcomeForAction(pair, ref, 'pause', 'interaction_cohort_complete'))
      .toMatchObject({ value: 0, scope: 'adset' })
    expect(paidCohortOutcomeForAction(pair, ref, 'pause', 'calendar_period_signal')).toBeNull()
  })
})

describe('latestDataAgeHours', () => {
  it('uses the newest valid entity insight sync and fails closed when none exists', () => {
    const now = Date.parse('2026-06-15T12:00:00Z')

    expect(latestDataAgeHours([
      '2026-06-14T12:00:00Z',
      'not-a-timestamp',
      '2026-06-15T10:00:00Z',
      null,
    ], now)).toBe(2)
    expect(latestDataAgeHours([null, 'not-a-timestamp'], now)).toBeNull()
  })

  it('cannot borrow a fresh stamp from outside the flag evidence window', () => {
    const now = Date.parse('2026-06-15T12:00:00Z')

    expect(insightWindowDataAgeHours([
      { date: '2026-06-01', syncedAt: '2026-06-15T11:00:00Z' },
      { date: '2026-06-10', syncedAt: '2026-06-13T12:00:00Z' },
    ], '2026-06-09', now)).toBe(48)
  })
})

describe('buildRecommendation from flags (grounded + range-aware)', () => {
  it('winner with adequate data → keep, CPA in healthy band', () => {
    const rec = buildRecommendation(flagToRecommendationInput(winnerGood, 'Cold AdSet', today))
    expect(rec.recommendation_type).toBe('keep')
    expect(rec.target_evaluation?.status).toBe('healthy')
    expect(rec.action_allowed_now).toBe(false) // read-only / write mode off
  })
  it('loser on thin data → gate downgrades the action to hold (never a confident pause)', () => {
    const rec = buildRecommendation(flagToRecommendationInput(loserThin, 'Cold AdSet', today))
    expect(rec.recommendation_type).toBe('hold')
    expect(rec.action_allowed_now).toBe(false)
  })
  it('withholds a multi-day frequency verdict', () => {
    const rec = buildRecommendation(flagToRecommendationInput(fatigue, 'Ad 1', today))
    expect(rec.target_evaluation?.status).toBe('unknown')
    expect(rec.action_allowed_now).toBe(false)
  })
})
