import './_support/outcome-noun-booking'
import { describe, it, expect } from 'vitest'
import {
  detectOperatingMode,
  type InteractionCohortPairSignal,
  type InteractionCohortSignal,
  type ModeSignals,
} from '@/lib/modes/operating-mode'
import { buildLaunchReadinessReport } from '@/lib/modes/launch-readiness'
import type { ContributionWindowEvidence } from '@/lib/economics/profit-policy'

const cohortSignal = (
  kind: 'recent' | 'matured',
  overrides: Partial<InteractionCohortSignal> = {},
): InteractionCohortSignal => ({
  generationId: kind === 'recent'
    ? '00000000-0000-4000-8000-000000000101'
    : '00000000-0000-4000-8000-000000000102',
  windowStart: kind === 'recent' ? '2026-07-15' : '2026-07-01',
  windowEnd: kind === 'recent' ? '2026-07-28' : '2026-07-14',
  asOfDate: '2026-07-29',
  complete: true,
  allUnitsComplete: true,
  blockerCodes: [],
  spend: 480,
  bookings: 16,
  bookedValue: 3_520,
  ...overrides,
})

const cohortPair = (overrides: {
  recent?: Partial<InteractionCohortSignal>
  matured?: Partial<InteractionCohortSignal>
} = {}): InteractionCohortPairSignal => ({
  evaluationRunId: '00000000-0000-4000-8000-000000000100',
  recentScale: cohortSignal('recent', overrides.recent),
  maturedCut: cohortSignal('matured', overrides.matured),
})

const contribution = (
  spend = 480,
  direction: 'positive' | 'negative' = 'positive',
): ContributionWindowEvidence => direction === 'positive'
  ? {
      status: 'complete', currency: 'USD', metricDefinitionVersion: 'maxx-causal-contribution-v1',
      realizationHorizonDays: 30, costPolicyVersion: 'cost-v1',
      causalDecisionPackageId: 'decision-package-v1', measurementDesignId: 'design-v1',
      estimand: 'marginal_contribution_vs_current_state', collectedRevenue: 1_280, refundsAndChargebacks: 0,
      paymentProcessingFees: 36, variableFulfillmentCosts: 264, observedTreatmentAdSpend: spend, adSpend: spend,
      contributionAfterAds: 980 - spend,
      contributionInterval: { lower: 880 - spend, upper: 1_080 - spend, confidence: 0.9 },
      observedSettledPayments: 6, matured: true, collectionLineage: 'processor_settled',
      measurementLineage: 'quasi_experimental_comparison', costLineage: 'governed_cost_policy',
      incrementality: 'quasi_experimental',
    }
  : {
      status: 'complete', currency: 'USD', metricDefinitionVersion: 'maxx-causal-contribution-v1',
      realizationHorizonDays: 30, costPolicyVersion: 'cost-v1',
      causalDecisionPackageId: 'decision-package-v1', measurementDesignId: 'design-v1',
      estimand: 'total_contribution_vs_no_ads', collectedRevenue: 100, refundsAndChargebacks: 0,
      paymentProcessingFees: 3, variableFulfillmentCosts: 47, observedTreatmentAdSpend: spend, adSpend: spend,
      contributionAfterAds: 50 - spend,
      contributionInterval: { lower: -spend - 50, upper: 150 - spend, confidence: 0.9 },
      observedSettledPayments: 1, matured: true, collectionLineage: 'processor_settled',
      measurementLineage: 'quasi_experimental_comparison', costLineage: 'governed_cost_policy',
      incrementality: 'quasi_experimental',
    }

const profit = (
  recent = contribution(),
  matured: ContributionWindowEvidence | null = contribution(),
  currentAccountDailyBudget = 50,
  proposedAccountDailyBudget: number | null = 60,
): NonNullable<ModeSignals['profit']> => ({
  currentAccountDailyBudget,
  proposedAccountDailyBudget,
  recent,
  proposedTotal: recent.estimand === 'marginal_contribution_vs_current_state'
    ? { ...recent, estimand: 'total_contribution_vs_no_ads' }
    : null,
  matured,
  lineageMatchesEvaluationWindows: true,
})

const base: ModeSignals = {
  spend30d: 800,
  businessBookings30d: 16, exactPaidBookings30d: 16, metaModelledBookings30d: 16,
  attributedShare: 0.7,
  campaignMappingComplete: true,
  authoritativeSpendBasis: true,
  // CUT evidence comes from a SEPARATE, LAGGED window whose spend and outcomes are matched and
  // settled. The reporting window always ends yesterday, so a "days since it ended" scalar was
  // permanently ~1-2 and made a cut unreachable however long the account lost money.
  laggedPeriod: { spend: 800, exactPaidBookings: 8, daysSinceEnd: 14, start: '2026-05-15', end: '2026-06-14' },
  // NON-OVERLAPPING corroboration slice, strictly AFTER the lagged period. Shares no dates with it:
  // the trailing 30-day window CONTAINS the lagged period, so it could never corroborate it
  // independently. Matured here so the base fixture can exercise both directions.
  postPeriod: { spend: 800, exactPaidBookings: 8, daysSinceEnd: 14, start: '2026-06-15', end: '2026-06-28' },
  campaignSpendComplete: true,
  // No material setting change separates the lagged period from now. Unknown fails CLOSED.
  structuralContinuity: true,
  interactionCohorts: cohortPair(),
  profit: profit(),
  objective: 'bookings',
  // EFFECTIVE targets, passed in — the pure function must never read a static default, so a
  // Performance-Targets override actually changes the verdict.
  targetCpa: 60,
  maxCpa: 100,
  // Hypothetical future governed policy. Production legacy rows are unversioned and stay diagnostic.
  targetPolicyStatus: 'governed',
  daysSinceLastDelivery: 0,
  activeAdsDelivering: 4,
  anyAdsetExitedLearning: true,
  writeModeEnabled: false,
  mediaBuyerRecommendationsEnabled: false,
}

describe('detectOperatingMode', () => {
  it('detects pre-launch when dormant (no spend / no delivery)', () => {
    const r = detectOperatingMode({ ...base, spend30d: 0, businessBookings30d: 0, exactPaidBookings30d: 0, metaModelledBookings30d: 0, activeAdsDelivering: 0, daysSinceLastDelivery: 30, anyAdsetExitedLearning: false })
    expect(r.dataMode).toBe('pre_launch')
    expect(r.authority).toBe('approval_only')
    expect(r.canMakePerformanceClaims).toBe(false)
    expect(r.canRecommendBudgetChanges).toBe(false)
  })

  it('detects sparse modelled volume without inventing paid-performance authority', () => {
    const r = detectOperatingMode({ ...base, spend30d: 200, businessBookings30d: 1, exactPaidBookings30d: 1, metaModelledBookings30d: 1, interactionCohorts: null, anyAdsetExitedLearning: false })
    expect(r.dataMode).toBe('low_data')
    expect(r.canMakePerformanceClaims).toBe(false)
  })

  it('reports active learning separately without promoting cohort economics to causal authority', () => {
    const r = detectOperatingMode({ ...base, spend30d: 400, businessBookings30d: 5, exactPaidBookings30d: 5, metaModelledBookings30d: 5, anyAdsetExitedLearning: false })
    expect(r.dataMode).toBe('active_learning')
    expect(r.canMakePerformanceClaims).toBe(true)
    expect(r.canRecommendBudgetScale).toBe(false)
    expect(r.canRecommendBudgetCut).toBe(false)
    expect(r.budgetVerdict).toBe('healthy_signal_review')
  })

  it('keeps a favorable recent cohort diagnostic when the older cut cohort is blocked', () => {
    const r = detectOperatingMode({
      ...base,
      exactPaidBookings30d: null,
      laggedPeriod: null,
      postPeriod: null,
      interactionCohorts: cohortPair({ matured: {
        complete: false,
        allUnitsComplete: false,
        blockerCodes: ['insight_source_incomplete'],
        spend: null,
        bookings: null,
        bookedValue: null,
      } }),
      profit: profit(contribution(), null),
    })
    expect(r.canRecommendBudgetScale).toBe(false)
    expect(r.canRecommendBudgetCut).toBe(false)
    expect(r.scaleAuthorityBasis).toBe('interaction_cohort_complete')
    expect(r.cutAuthorityBasis).toBe('unavailable')
  })

  it('keeps a mature loss diagnostic until an exact causal estimate is bound', () => {
    const r = detectOperatingMode({
      ...base,
      interactionCohorts: cohortPair({
        recent: { spend: 300, bookings: 0, bookedValue: 0 },
        matured: { spend: 400, bookings: 0, bookedValue: 0 },
      }),
      profit: profit(contribution(300, 'negative'), contribution(400, 'negative'), 65, null),
    })
    expect(r.canRecommendBudgetScale).toBe(false)
    expect(r.canRecommendBudgetCut).toBe(false)
    expect(r.budgetVerdict).toBe('loss_signal_review')
    expect(r.cutAuthorityBasis).toBe('interaction_cohort_complete')
  })

  it('treats historical loss plus recent recovery as a conflict and authorises neither direction', () => {
    const recentUnitRecovery = { ...contribution(240), estimand: 'total_contribution_vs_no_ads' as const }
    const r = detectOperatingMode({
      ...base,
      interactionCohorts: cohortPair({
        recent: { spend: 240, bookings: 8, bookedValue: 1_760 },
        matured: { spend: 400, bookings: 0, bookedValue: 0 },
      }),
      profit: profit(recentUnitRecovery, contribution(400, 'negative')),
    })
    expect(r.canRecommendBudgetScale).toBe(false)
    expect(r.canRecommendBudgetCut).toBe(false)
    expect(r.budgetVerdict).toBe('conflicting_signals_review')
    expect(r.restrictions.join(' ')).toMatch(/CONFLICTING WINDOWS/)
  })

  it.each([false, null] as const)('fails a historical cut closed when structural continuity is %s', (structuralContinuity) => {
    const r = detectOperatingMode({
      ...base,
      structuralContinuity,
      interactionCohorts: cohortPair({
        recent: { spend: 300, bookings: 0, bookedValue: 0 },
        matured: { spend: 400, bookings: 0, bookedValue: 0 },
      }),
      profit: profit(contribution(300, 'negative'), contribution(400, 'negative'), 65, null),
    })
    expect(r.canRecommendBudgetCut).toBe(false)
    expect(r.budgetVerdict).toBe('conflicting_signals_review')
  })

  it('never promotes a blocked cohort by borrowing calendar-period ratios', () => {
    const r = detectOperatingMode({
      ...base,
      spend30d: 240,
      exactPaidBookings30d: 8,
      interactionCohorts: cohortPair({
        recent: { complete: false, blockerCodes: ['stale_insight_source'] },
        matured: { complete: false, blockerCodes: ['stale_appointment_state'] },
      }),
    })
    expect(r.canRecommendBudgetScale).toBe(false)
    expect(r.canRecommendBudgetCut).toBe(false)
    expect(r.scaleAuthorityBasis).toBe('calendar_period_signal')
    expect(r.cutAuthorityBasis).toBe('calendar_period_signal')
    expect(r.budgetVerdict).toBe('insufficient_evidence')
  })

  it('delivery-objective labels do not replace the commercial contribution objective', () => {
    for (const objective of ['awareness', 'leads', 'unknown'] as const) {
      const scale = detectOperatingMode({ ...base, objective })
      const cut = detectOperatingMode({
        ...base,
        objective,
        interactionCohorts: cohortPair({
          recent: { spend: 300, bookings: 0, bookedValue: 0 },
          matured: { spend: 400, bookings: 0, bookedValue: 0 },
        }),
        profit: profit(contribution(300, 'negative'), contribution(400, 'negative'), 65, null),
      })
      expect(scale.canRecommendBudgetScale, objective).toBe(false)
      expect(cut.canRecommendBudgetCut, objective).toBe(false)
    }
  })

  it.each(['unversioned', 'missing', 'invalid', 'unavailable', 'not_evaluated'] as const)(
    'keeps legacy CPA-target policy %s diagnostic and lets profit evidence decide',
    (targetPolicyStatus) => {
      const scale = detectOperatingMode({ ...base, targetPolicyStatus })
      const cut = detectOperatingMode({
        ...base,
        targetPolicyStatus,
        interactionCohorts: cohortPair({
          recent: { spend: 300, bookings: 0, bookedValue: 0 },
          matured: { spend: 400, bookings: 0, bookedValue: 0 },
        }),
        profit: profit(contribution(300, 'negative'), contribution(400, 'negative'), 65, null),
      })
      expect(scale.canRecommendBudgetScale).toBe(false)
      expect(cut.canRecommendBudgetCut).toBe(false)
      expect(cut.restrictions.join(' ')).not.toMatch(/TARGET POLICY/)
    },
  )

  it('never treats CPA targets as causal proof and retains the account-wide ceiling', () => {
    const within = detectOperatingMode({ ...base, targetCpa: 1, maxCpa: 2 })
    const over = detectOperatingMode({
      ...base,
      targetCpa: 1_000,
      maxCpa: 2_000,
      profit: profit(contribution(), contribution(), 100, 101),
    })
    expect(within.canRecommendBudgetScale).toBe(false)
    expect(over.canRecommendBudgetScale).toBe(false)
    expect(over.restrictions.join(' ')).toMatch(/\$100/)
  })

  it('requires every unit complete before making per-campaign CPA or ROAS claims', () => {
    expect(detectOperatingMode(base).canClaimPerCampaignRoas).toBe(true)
    const partial = detectOperatingMode({
      ...base,
      interactionCohorts: cohortPair({ recent: { allUnitsComplete: false } }),
    })
    expect(partial.canClaimPerCampaignRoas).toBe(false)
  })

  it('reports calendar evidence as diagnostic and no evidence as unavailable', () => {
    const calendar = detectOperatingMode({ ...base, spend30d: 240, exactPaidBookings30d: 8, interactionCohorts: null })
    expect(calendar.canRecommendBudgetScale).toBe(false)
    expect(calendar.budgetVerdict).toBe('insufficient_evidence')
    expect(calendar.authorityBasis).toBe('calendar_period_signal')

    const unavailable = detectOperatingMode({
      ...base,
      spend30d: 0,
      businessBookings30d: null,
      exactPaidBookings30d: null,
      laggedPeriod: null,
      postPeriod: null,
      interactionCohorts: null,
    })
    expect(unavailable.authorityBasis).toBe('unavailable')
  })

  it('authorises at most one money direction across contribution signs and continuity states', () => {
    for (const recentDirection of ['positive', 'negative'] as const) {
      for (const maturedDirection of ['positive', 'negative'] as const) {
        for (const structuralContinuity of [true, false, null] as const) {
          const r = detectOperatingMode({
            ...base,
            structuralContinuity,
            profit: profit(contribution(480, recentDirection), contribution(480, maturedDirection)),
          })
          expect(
            r.canRecommendBudgetScale && r.canRecommendBudgetCut,
            `both authorised at recent=${recentDirection} matured=${maturedDirection} continuity=${structuralContinuity}`,
          ).toBe(false)
        }
      }
    }
  })

  it('reports write authority only when write mode is enabled', () => {
    expect(detectOperatingMode(base).authority).toBe('approval_only')
    expect(detectOperatingMode({ ...base, writeModeEnabled: true }).authority).toBe('write')
  })
})

describe('buildLaunchReadinessReport', () => {
  it('produces a launch-readiness plan (not a performance diagnosis) with all required sections', () => {
    const mode = detectOperatingMode({ ...base, spend30d: 0, activeAdsDelivering: 0, businessBookings30d: 0, exactPaidBookings30d: 0, metaModelledBookings30d: 0, anyAdsetExitedLearning: false })
    const r = buildLaunchReadinessReport({ mode, today: '2026-06-28', attributedShare: 0, trackingHealthy: true, activeAdSets: 2 })
    expect(r.tracking_readiness.length).toBeGreaterThan(0)
    expect(r.audience_test_plan.length).toBeGreaterThan(0)
    expect(r.creative_test_plan.length).toBeGreaterThan(0)
    expect(r.budget_learning_plan.length).toBeGreaterThan(0)
    expect(r.campaign_structure_check.join(' ')).toMatch(/approved CampaignPlan/i)
    expect(r.audience_test_plan.join(' ')).toMatch(/Cold is not automatically Awareness or direct booking/i)
    expect(r.audience_test_plan.join(' ')).toMatch(/failed.*lookalike|lookalike.*failed/i)
    expect(r.audience_test_plan.join(' ')).toMatch(/exclude every approved warm pool/i)
    expect(r.creative_test_plan.join(' ')).not.toMatch(/CTA = Book Now/i)
    expect(r.creative_test_plan.join(' ')).toMatch(/video-only/i)
    expect(r.creative_test_plan.join(' ')).toMatch(/three genuinely distinct concepts/i)
    expect(r.landing_booking_checks.join(' ')).toMatch(/audience test.*destination.*constant/i)
    expect(r.do_not_change_yet.join(' ')).toMatch(/objective|optimization event/i)
    expect(r.next_review_date).toBe('2026-07-05')
    expect(r.markdown).toMatch(/Launch-Readiness Report/)
  })

  it('reports legacy UTM coverage without prescribing a context-free tracking string', () => {
    const mode = detectOperatingMode({ ...base, spend30d: 0, activeAdsDelivering: 0, businessBookings30d: 0, exactPaidBookings30d: 0, metaModelledBookings30d: 0, anyAdsetExitedLearning: false })
    const r = buildLaunchReadinessReport({ mode, today: '2026-06-28', attributedShare: 0, utmCoverage: 0.06 })
    const utmLine = r.tracking_readiness.find((l) => l.startsWith('OBSERVED: only'))
    expect(utmLine).toContain('6% of active ads')
    expect(utmLine).toMatch(/tracking defect, not a launch-setting prescription/i)
    expect(utmLine).not.toContain('utm_source=meta')
  })
})

// Regression: a page whose spend evidence is unreadable must pass null, not 0. Coercing an unknown to
// 0 (`spend30d > 0` on a null yields false, so `activeAdsDelivering: 0`) made the dormancy branch fire
// and detectOperatingMode declare 'pre_launch' for an actively-spending account — which explainQuiet
// then stated as fact: "the account is pre-launch — spend over the last 30 days is at or under $200".
describe('detectOperatingMode — unknown delivery is not zero delivery', () => {
  it('does not declare pre_launch when delivery evidence is unknown', () => {
    const unknownDelivery = detectOperatingMode({
      ...base,
      spend30d: null,
      businessBookings30d: null,
      metaModelledBookings30d: null,
      activeAdsDelivering: null,
      daysSinceLastDelivery: null,
    })
    expect(unknownDelivery.dataMode).not.toBe('pre_launch')
  })

  it('still declares pre_launch on genuinely observed zero delivery', () => {
    const observedZero = detectOperatingMode({
      ...base,
      spend30d: 0,
      businessBookings30d: 0,
      exactPaidBookings30d: 0,
      metaModelledBookings30d: 0,
      activeAdsDelivering: 0,
      daysSinceLastDelivery: 30,
      anyAdsetExitedLearning: false,
    })
    expect(observedZero.dataMode).toBe('pre_launch')
  })
})
