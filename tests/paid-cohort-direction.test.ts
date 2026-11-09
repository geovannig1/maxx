import { describe, expect, it } from 'vitest'
import {
  buildPaidCohortDirectionalEvidence,
  resolvePaidCohortActionEvidence,
  type PaidCohortDirectionInput,
} from '@/lib/authority/paid-cohort-direction'
import { evaluateDirection } from '@/lib/authority/directional-policy'
import type { ContributionWindowEvidence } from '@/lib/economics/profit-policy'
import type { InteractionCohortPairSignal, InteractionCohortSignal } from '@/lib/modes/operating-mode'

const signal = (
  kind: 'recent' | 'matured',
  over: Partial<InteractionCohortSignal> = {},
): InteractionCohortSignal => ({
  generationId: kind === 'recent'
    ? '00000000-0000-4000-8000-000000000401'
    : '00000000-0000-4000-8000-000000000402',
  windowStart: kind === 'recent' ? '2026-07-15' : '2026-07-01',
  windowEnd: kind === 'recent' ? '2026-07-28' : '2026-07-14',
  asOfDate: '2026-07-29', complete: true, allUnitsComplete: true, blockerCodes: [],
  spend: 480, bookings: 16, bookedValue: 3_520,
  ...over,
})

const pair = (over: {
  recent?: Partial<InteractionCohortSignal>
  matured?: Partial<InteractionCohortSignal>
} = {}): InteractionCohortPairSignal => ({
  evaluationRunId: '00000000-0000-4000-8000-000000000400',
  recentScale: signal('recent', over.recent),
  maturedCut: signal('matured', over.matured),
})

const contribution = (
  over: Partial<ContributionWindowEvidence> = {},
): ContributionWindowEvidence => {
  const row = {
    status: 'complete' as const,
    currency: 'USD' as const,
    metricDefinitionVersion: 'maxx-causal-contribution-v1',
    realizationHorizonDays: 30,
    costPolicyVersion: 'cost-v1',
    causalDecisionPackageId: 'decision-package-v1',
    measurementDesignId: 'design-v1',
    estimand: 'marginal_contribution_vs_current_state' as const,
    collectedRevenue: 1_280,
    refundsAndChargebacks: 0,
    paymentProcessingFees: 36,
    variableFulfillmentCosts: 264,
    observedTreatmentAdSpend: over.observedTreatmentAdSpend ?? over.adSpend ?? 480,
    adSpend: 480,
    observedSettledPayments: 6,
    matured: true,
    collectionLineage: 'processor_settled' as const,
    measurementLineage: 'quasi_experimental_comparison' as const,
    costLineage: 'governed_cost_policy' as const,
    incrementality: 'quasi_experimental' as const,
    ...over,
  }
  const point = over.contributionAfterAds ?? row.collectedRevenue - row.refundsAndChargebacks
    - row.paymentProcessingFees - row.variableFulfillmentCosts - row.adSpend
  return {
    ...row,
    contributionAfterAds: point,
    contributionInterval: over.contributionInterval ?? { lower: point - 100, upper: point + 100, confidence: 0.9 },
  }
}

const input = (
  cohorts: InteractionCohortPairSignal | null,
  profit: PaidCohortDirectionInput['profit'] = null,
): PaidCohortDirectionInput => ({
  cohorts,
  objective: 'bookings',
  structuralContinuity: true,
  targetCpa: 60,
  maxCpa: 100,
  targetPolicyStatus: 'governed',
  profit,
})

describe('buildPaidCohortDirectionalEvidence', () => {
  it('booked-value cohorts alone cannot support scale, however healthy their CPA looks', () => {
    const evidence = buildPaidCohortDirectionalEvidence(input(pair({ matured: {
      complete: false, spend: null, bookings: null, bookedValue: null,
    } })))
    expect(evidence).not.toBeNull()
    expect(evaluateDirection('budget_scale', evidence!).ceiling).toBe('unsupported')
    expect(evaluateDirection('budget_cut', evidence!).ceiling).toBe('unsupported')
  })

  it('supports scale only with aligned, positive incremental contribution evidence inside the ceiling', () => {
    const cohorts = pair({ matured: { complete: false, spend: null, bookings: null, bookedValue: null } })
    const evidence = buildPaidCohortDirectionalEvidence(input(cohorts, {
      currentAccountDailyBudget: 50,
      proposedAccountDailyBudget: 60,
      recent: contribution(),
      proposedTotal: contribution({ estimand: 'total_contribution_vs_no_ads' }),
      matured: null,
      lineageMatchesEvaluationWindows: true,
    }))
    expect(evaluateDirection('budget_scale', evidence!).ceiling).toBe('execution')
  })

  it('supports a cut only from aligned mature contribution loss corroborated by the recent window', () => {
    const cohorts = pair({
      recent: { spend: 300, bookings: 0, bookedValue: 0 },
      matured: { spend: 400, bookings: 0, bookedValue: 0 },
    })
    const loss = (spend: number) => contribution({
      estimand: 'total_contribution_vs_no_ads',
      collectedRevenue: 100,
      refundsAndChargebacks: 0,
      paymentProcessingFees: 3,
      variableFulfillmentCosts: 47,
      adSpend: spend,
      contributionAfterAds: 50 - spend,
      contributionInterval: { lower: 50 - spend - 100, upper: 50 - spend + 100, confidence: 0.9 },
    })
    const evidence = buildPaidCohortDirectionalEvidence(input(cohorts, {
      currentAccountDailyBudget: 90,
      proposedAccountDailyBudget: null,
      recent: loss(300),
      proposedTotal: null,
      matured: loss(400),
      lineageMatchesEvaluationWindows: true,
    }))
    expect(evaluateDirection('budget_cut', evidence!).ceiling).toBe('execution')
    expect(evaluateDirection('budget_scale', evidence!).ceiling).toBe('unsupported')
  })

  it('marks mature contribution loss plus recent contribution recovery as a conflict', () => {
    const cohorts = pair({
      recent: { spend: 240, bookings: 8 },
      matured: { spend: 400, bookings: 0, bookedValue: 0 },
    })
    const evidence = buildPaidCohortDirectionalEvidence(input(cohorts, {
      currentAccountDailyBudget: 90,
      proposedAccountDailyBudget: null,
      recent: contribution({ collectedRevenue: 1_040, adSpend: 240, estimand: 'total_contribution_vs_no_ads' }),
      proposedTotal: null,
      matured: contribution({
        estimand: 'total_contribution_vs_no_ads',
        collectedRevenue: 100, paymentProcessingFees: 3, variableFulfillmentCosts: 47,
        adSpend: 400, contributionAfterAds: -350,
        contributionInterval: { lower: -500, upper: -200, confidence: 0.9 },
      }),
      lineageMatchesEvaluationWindows: true,
    }))
    expect(evidence?.windowsConflict).toBe(true)
    expect(evaluateDirection('budget_scale', evidence!).ceiling).toBe('unsupported')
    expect(evaluateDirection('budget_cut', evidence!).ceiling).toBe('unsupported')
  })

  it('fails closed on a torn, malformed, or entirely blocked pair', () => {
    expect(buildPaidCohortDirectionalEvidence(input(null))).toBeNull()
    expect(buildPaidCohortDirectionalEvidence(input(pair({
      recent: { complete: false }, matured: { complete: false },
    })))).toBeNull()
    expect(buildPaidCohortDirectionalEvidence(input(pair({
      recent: { asOfDate: '2026-07-30' },
    })))).toBeNull()
  })

  it('retains legacy target/objective context without letting it authorize money', () => {
    const evidence = buildPaidCohortDirectionalEvidence({
      ...input(pair()), targetCpa: 20, maxCpa: 200, objective: 'awareness',
    })
    expect(evidence).toMatchObject({ targetCpa: 20, maxCpa: 200, objective: 'awareness' })
    expect(evaluateDirection('budget_scale', evidence!).reason).toMatch(/account-total daily budgets|contribution evidence/i)
  })

  it('selects authority basis per action direction, never from one coarse scalar', () => {
    const partial = input(pair({ matured: {
      complete: false, spend: null, bookings: null, bookedValue: null,
    } }))
    expect(resolvePaidCohortActionEvidence({
      ...partial, kind: 'budget_scale', fallbackPlane: 'meta_modelled',
    })).toMatchObject({ basis: 'calendar_period_signal', plane: 'meta_modelled' })
    expect(resolvePaidCohortActionEvidence({
      ...partial, kind: 'budget_cut', fallbackPlane: 'meta_modelled',
    })).toMatchObject({ basis: 'calendar_period_signal', plane: 'meta_modelled' })
    expect(resolvePaidCohortActionEvidence({
      ...partial, kind: 'creative_refresh', fallbackPlane: 'structural',
    })).toMatchObject({ basis: 'calendar_period_signal', plane: 'structural', evidence: undefined })
  })

  // THE ESCAPE HATCH THAT WAS LOCKED BEHIND ITS OWN DOOR.
  //
  // The modelled fallback was written to end "the silence that has produced zero money
  // recommendations in three months" (its own comment). Its guard read
  // `if (input.modelled && analysis.evidence)` — but `analysis.evidence` is null exactly when BOTH
  // cohort windows are unusable, which is the ONLY situation in which a fallback is wanted. It
  // therefore never fired once. When a large share of paid touches carries no meta_ad_id, every
  // cohort unit is incomplete, so this branch was unreachable for the entire period it existed.
  //
  // Reaching it widens nothing: the modelled plane is capped at owner_review by construction, carries
  // a mandatory disclosure, and still requires two agreeing non-overlapping windows with real spend.
  describe('meta-modelled fallback when the cohort carries nothing', () => {
    const modelledWindowMeta = {
      source: 'daily_insights' as const,
      observedDays: 14,
      expectedDays: 14,
      earliestSyncedAt: '2026-08-19T10:30:00.000Z',
      latestSyncedAt: '2026-08-19T10:30:00.000Z',
    }
    const modelled = {
      recent: {
        windowStart: '2026-08-05', windowEnd: '2026-08-18',
        spend: 480, modelledBookings: 8, modelledCpa: 60,
        peakDailyFrequency: 1.4, windowFrequency: 2.0,
        ...modelledWindowMeta,
      },
      prior: {
        windowStart: '2026-07-22', windowEnd: '2026-08-04',
        spend: 460, modelledBookings: 7, modelledCpa: 65.71,
        peakDailyFrequency: 1.3, windowFrequency: 1.9,
        ...modelledWindowMeta,
      },
      sourceGeneration: {
        id: 'sync-generation-1', status: 'success', dateRangeStart: '2026-07-22',
        dateRangeEnd: '2026-08-18', startedAt: '2026-08-19T10:00:00.000Z',
        completedAt: '2026-08-19T10:30:00.000Z',
      },
      targetCpa: 60, watchCpa: 100, linkageCoverage: 0.2, blendedRoas: 2.1,
    }
    // Both windows unusable — the live shape while incomplete_touch_identity is set account-wide.
    const deadCohort = () => input(pair({
      recent: { complete: false, spend: null, bookings: null, bookedValue: null },
      matured: { complete: false, spend: null, bookings: null, bookedValue: null },
    }))

    it('reaches the modelled plane instead of falling through to a calendar-period signal', () => {
      const resolved = resolvePaidCohortActionEvidence({
        ...deadCohort(), modelled, kind: 'budget_scale', fallbackPlane: 'meta_modelled',
      })
      expect(resolved.basis).toBe('meta_modelled_association')
      expect(resolved.plane).toBe('meta_modelled')
      expect(resolved.evidence?.modelled).toEqual(modelled)
    })

    it('invents nothing the cohort did not establish', () => {
      const resolved = resolvePaidCohortActionEvidence({
        ...deadCohort(), modelled, kind: 'budget_scale', fallbackPlane: 'meta_modelled',
      })
      // The three cohort-derived diagnostics stay NULL, and no contribution evidence is manufactured —
      // a modelled fallback must never look like measured money.
      expect(resolved.evidence).toMatchObject({
        exactCpa: null, provenOutcomes: null, lagged: null,
        recentContribution: null, proposedTotalContribution: null, laggedContribution: null,
      })
    })

    it('still yields a calendar-period signal when there are no modelled numbers either', () => {
      expect(resolvePaidCohortActionEvidence({
        ...deadCohort(), kind: 'budget_scale', fallbackPlane: 'meta_modelled',
      }).basis).toBe('calendar_period_signal')
    })

    it('leaves non-money actions untouched', () => {
      expect(resolvePaidCohortActionEvidence({
        ...deadCohort(), modelled, kind: 'creative_refresh', fallbackPlane: 'structural',
      })).toMatchObject({ basis: 'calendar_period_signal', plane: 'structural', evidence: undefined })
    })
  })
})
