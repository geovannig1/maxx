import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { detectOperatingMode, type InteractionCohortPairSignal, type ModeSignals } from '@/lib/modes/operating-mode'
import {
  buildPragmaticProfitInputFromCohortPair,
  PRAGMATIC_DAILY_BUDGET_CEILING,
  recommendedScaleBudget,
} from '@/lib/economics/pragmatic-profit-evidence'
import { enrichPragmaticMediaBuyerRecommendation, MEDIA_BUYER_RULES } from '@/lib/recommendations/pragmatic-media-buyer'
import type { Recommendation } from '@/lib/recommendations/types'

const cohortSignal = (
  kind: 'recent' | 'matured',
  overrides: Partial<InteractionCohortPairSignal['recentScale']> = {},
): InteractionCohortPairSignal['recentScale'] => ({
  generationId: kind === 'recent'
    ? '00000000-0000-4000-8000-000000000101'
    : '00000000-0000-4000-8000-000000000102',
  windowStart: kind === 'recent' ? '2026-07-15' : '2026-07-01',
  windowEnd: kind === 'recent' ? '2026-07-28' : '2026-07-14',
  asOfDate: '2026-07-29',
  complete: true,
  allUnitsComplete: true,
  blockerCodes: [],
  spend: kind === 'recent' ? 480 : 400,
  bookings: kind === 'recent' ? 16 : 0,
  bookedValue: kind === 'recent' ? 3_520 : 0,
  recordedRevenue: kind === 'recent' ? 3_360 : 0,
  ...overrides,
})

const cohortPair = (overrides: {
  recent?: Partial<InteractionCohortPairSignal['recentScale']>
  matured?: Partial<InteractionCohortPairSignal['recentScale']>
} = {}): InteractionCohortPairSignal => ({
  evaluationRunId: '00000000-0000-4000-8000-000000000100',
  recentScale: cohortSignal('recent', overrides.recent),
  maturedCut: cohortSignal('matured', overrides.matured),
})

const baseSignals = (pair: InteractionCohortPairSignal, currentBudget = 50): ModeSignals => ({
  spend30d: 800,
  businessBookings30d: 16,
  exactPaidBookings30d: 16,
  metaModelledBookings30d: 16,
  attributedShare: 0.7,
  campaignMappingComplete: true,
  campaignSpendComplete: true,
  authoritativeSpendBasis: true,
  laggedPeriod: { spend: 400, exactPaidBookings: 8, daysSinceEnd: 14, start: '2026-05-15', end: '2026-06-14' },
  postPeriod: { spend: 800, exactPaidBookings: 8, daysSinceEnd: 14, start: '2026-06-15', end: '2026-06-28' },
  structuralContinuity: true,
  interactionCohorts: pair,
  profit: buildPragmaticProfitInputFromCohortPair(pair, currentBudget),
  targetCpa: 60,
  maxCpa: 100,
  targetPolicyStatus: 'governed',
  objective: 'bookings',
  daysSinceLastDelivery: 0,
  activeAdsDelivering: 4,
  anyAdsetExitedLearning: true,
  writeModeEnabled: false,
  mediaBuyerRecommendationsEnabled: true,
})

describe('pragmatic media-buyer operating mode', () => {
  it('does not manufacture processor-settled profit evidence from booked appointment value', () => {
    const pair = cohortPair({ recent: { spend: 480, bookings: 16, bookedValue: 3_520 } })
    expect(buildPragmaticProfitInputFromCohortPair(pair, 50)).toBeNull()
  })

  it('does not allow scale from positive booked appointment value alone', () => {
    const pair = cohortPair({ recent: { spend: 480, bookings: 16, bookedValue: 3_520 } })
    const r = detectOperatingMode(baseSignals(pair, 50))
    expect(r.canRecommendBudgetScale).toBe(false)
    expect(r.canRecommendBudgetCut).toBe(false)
    expect(r.budgetVerdict).toBe('insufficient_evidence')
    expect(r.scaleAuthorityBasis).toBe('calendar_period_signal')
    expect(r.restrictions.join(' ')).toMatch(/PROFIT EVIDENCE UNAVAILABLE/)
  })

  it('does not let the media-buyer feature flag raise the governed ceiling', () => {
    const pair = cohortPair({ recent: { spend: 480, bookings: 16, bookedValue: 3_520 } })
    const r = detectOperatingMode(baseSignals(pair, 110))
    expect(r.canRecommendBudgetScale).toBe(false)
    expect(r.restrictions.join(' ')).toContain(`ceiling is $${PRAGMATIC_DAILY_BUDGET_CEILING}`)
    expect(baseSignals(pair, 110).profit).toBeNull()
  })

  it('blocks scale when the account is already at the governed ceiling', () => {
    const pair = cohortPair({ recent: { spend: 480, bookings: 16, bookedValue: 3_520 } })
    const r = detectOperatingMode(baseSignals(pair, PRAGMATIC_DAILY_BUDGET_CEILING))
    expect(r.canRecommendBudgetScale).toBe(false)
    expect(r.restrictions.join(' ')).toContain(`ceiling is $${PRAGMATIC_DAILY_BUDGET_CEILING}`)
  })

  it('does not allow a cut from negative booked-value windows alone', () => {
    const pair = cohortPair({
      recent: { spend: 300, bookings: 2, bookedValue: 80 },
      matured: { spend: 400, bookings: 2, bookedValue: 80 },
    })
    const r = detectOperatingMode(baseSignals(pair, 50))
    expect(r.canRecommendBudgetScale).toBe(false)
    expect(r.canRecommendBudgetCut).toBe(false)
    expect(r.budgetVerdict).toBe('insufficient_evidence')
    expect(r.cutAuthorityBasis).toBe('calendar_period_signal')
  })

  it('remains silent when pragmatic mode is disabled', () => {
    const pair = cohortPair({ recent: { spend: 480, bookings: 16, bookedValue: 3_520 } })
    const s = baseSignals(pair, 50)
    s.mediaBuyerRecommendationsEnabled = false
    s.profit = null
    const r = detectOperatingMode(s)
    expect(r.canRecommendBudgetScale).toBe(false)
    expect(r.budgetVerdict).toBe('insufficient_evidence')
    expect(r.restrictions.join(' ')).toContain(`ceiling is $${PRAGMATIC_DAILY_BUDGET_CEILING}`)
  })
})

describe('recommendation generation ordering', () => {
  it('makes final ActionAuthority the last writer after any booked-value enrichment', () => {
    const source = readFileSync('src/lib/recommendations/generate.ts', 'utf8')
    expect(source.lastIndexOf('rec = enrichPragmaticMediaBuyerRecommendation')).toBeLessThan(
      source.lastIndexOf('rec = applyRecommendationAuthority'),
    )
  })
})

describe('pragmatic recommendation enrichment', () => {
  const baseRec = (type: Recommendation['recommendation_type']): Recommendation => ({
    recommendation_type: type,
    target_entity_type: 'account',
    target_entity_id: null,
    target_entity_name: 'Test Account',
    observed_fact: 'Positive attributed ROAS signal.',
    metric_values: [
      { name: 'Spend', value: 480, unit: '$', source: 'meta_api' },
      { name: 'Bookings', value: 16, unit: 'count', source: 'meta_api' },
      { name: 'Frequency', value: 3.2, unit: '', source: 'meta_api' },
    ],
    date_range: { start: '2026-07-15', end: '2026-07-28' },
    data_sources: ['meta_api'],
    confidence_score: 0.7,
    confidence_label: 'medium',
    risk_level: 'medium',
    evidence_summary: 'Spend=$480, Bookings=16',
    reason_for_action: 'Initial reason.',
    what_could_make_this_wrong: ['Sample size is modest.'],
    approval_required: true,
    action_allowed_now: false,
    low_data_warning: null,
    estimate_warning: null,
    attribution_warning: null,
    no_oscillation_check: { is_reversal_class: true, allowed: true, reason: '', blocking_factors: [] },
    recommended_next_check_date: '2026-08-04',
    target_evaluation: null,
    grounding: {
      passed: true,
      decision: 'allow',
      confidence_score: 0.7,
      confidence_label: 'medium',
      risk_level: 'medium',
      checks: [],
      reasons: [],
      warnings: { low_data: null, estimate: null, attribution: null },
    },
    expected_upside: null,
    possible_downside: null,
    minimum_data_needed: null,
    learning_eligibility: false,
  })

  it('enriches a scale proposal with ROAS target language', () => {
    const pair = cohortPair({ recent: { spend: 480, bookings: 16, bookedValue: 3_520 } })
    const rec = enrichPragmaticMediaBuyerRecommendation(baseRec('scale'), {
      enabled: true,
      authorityTier: 'owner_review',
      pair,
      currentAccountDailyBudget: 50,
      targetCpa: 60,
      maxCpa: 100,
    })
    expect(rec.reason_for_action).toMatch(/PRAGMATIC SCALE PROPOSAL/)
    expect(rec.reason_for_action).toMatch(/\$50\.00 to \$60\.00/)
    expect(rec.expected_upside).toMatch(/7\.0x attributed revenue ROAS/)
    expect(rec.reason_for_action).toMatch(/\$3,360\.00 recorded collected value/)
    expect(rec.possible_downside).toMatch(/attributed association is not incremental proof/i)
    expect(rec.minimum_data_needed).not.toBeNull()
  })

  it('enriches a zero-outcome cut with explicit stop language', () => {
    const pair = cohortPair({
      recent: { spend: 300, bookings: 0, bookedValue: 0 },
      matured: { spend: 400, bookings: 0, bookedValue: 0 },
    })
    const rec = enrichPragmaticMediaBuyerRecommendation(baseRec('reduce_budget'), {
      enabled: true,
      authorityTier: 'owner_review',
      pair,
      currentAccountDailyBudget: 50,
      targetCpa: 60,
      maxCpa: 100,
    })
    expect(rec.reason_for_action).toMatch(/3x-zero-outcome/)
    expect(rec.expected_upside).toMatch(/prevents further losses/)
    expect(rec.possible_downside).toMatch(/temporary/)
  })

  it('enriches a creative refresh around the frequency fatigue band', () => {
    const pair = cohortPair({ recent: { spend: 480, bookings: 16, bookedValue: 3_520 } })
    const rec = enrichPragmaticMediaBuyerRecommendation(baseRec('refresh_creative'), {
      enabled: true,
      authorityTier: 'owner_review',
      pair,
      currentAccountDailyBudget: 50,
      targetCpa: 60,
      maxCpa: 100,
    })
    expect(rec.reason_for_action).toMatch(/frequency is 3\.2/)
    expect(rec.expected_upside).toMatch(/lift CTR/)
  })

  it('is a no-op when pragmatic mode is disabled', () => {
    const pair = cohortPair({ recent: { spend: 480, bookings: 16, bookedValue: 3_520 } })
    const rec = enrichPragmaticMediaBuyerRecommendation(baseRec('scale'), {
      enabled: false,
      authorityTier: 'diagnostic_only',
      pair,
      currentAccountDailyBudget: 50,
      targetCpa: 60,
      maxCpa: 100,
    })
    expect(rec.reason_for_action).toBe('Initial reason.')
    expect(rec.expected_upside).toBeNull()
  })

  it('does not add proposal copy to a diagnostic-only money recommendation', () => {
    const pair = cohortPair({ recent: { spend: 480, bookings: 16, bookedValue: 3_520 } })
    const initial = baseRec('scale')
    const rec = enrichPragmaticMediaBuyerRecommendation(initial, {
      enabled: true,
      authorityTier: 'diagnostic_only',
      pair,
      currentAccountDailyBudget: 50,
      targetCpa: 60,
      maxCpa: 100,
    })

    expect(rec).toBe(initial)
    expect(rec.reason_for_action).toBe('Initial reason.')
    expect(rec.expected_upside).toBeNull()
    expect(rec.possible_downside).toBeNull()
  })

  it('does not manufacture revenue ROAS when the cohort lacks recorded collected value', () => {
    const pair = cohortPair({ recent: { recordedRevenue: null, bookedValue: 3_520 } })
    const initial = baseRec('scale')
    const rec = enrichPragmaticMediaBuyerRecommendation(initial, {
      enabled: true,
      authorityTier: 'owner_review',
      pair,
      currentAccountDailyBudget: 50,
      targetCpa: 60,
      maxCpa: 100,
    })
    expect(rec).toBe(initial)
    expect(rec.reason_for_action).toBe('Initial reason.')
  })
})

describe('media-buyer budget math', () => {
  it('recommends a 20% scale step', () => {
    expect(recommendedScaleBudget(50)).toBe(60)
    expect(recommendedScaleBudget(60)).toBe(72)
    expect(recommendedScaleBudget(PRAGMATIC_DAILY_BUDGET_CEILING)).toBeNull()
  })

  it('returns null at or above the ceiling', () => {
    expect(recommendedScaleBudget(PRAGMATIC_DAILY_BUDGET_CEILING)).toBeNull()
    expect(recommendedScaleBudget(130)).toBeNull()
  })

  it('exposes best-practice rule constants', () => {
    expect(MEDIA_BUYER_RULES.SCALE_STEP_PCT).toBe(0.2)
    expect(MEDIA_BUYER_RULES.CPA_CUT_MULTIPLE_OF_TARGET).toBe(1.5)
    expect(MEDIA_BUYER_RULES.FREQUENCY_REFRESH_MIN).toBe(3.0)
    expect(MEDIA_BUYER_RULES.FREQUENCY_REFRESH_MAX).toBe(3.5)
  })
})
