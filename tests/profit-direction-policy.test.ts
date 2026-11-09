import { describe, expect, it } from 'vitest'
import {
  evaluateDirection,
  type ContributionWindowEvidence,
  type DirectionalEvidence,
} from '@/lib/authority/directional-policy'
import { MAXX_INSTRUCTIONS } from '@/mcp/instructions'

const contribution = (
  overrides: Partial<ContributionWindowEvidence> = {},
): ContributionWindowEvidence => ({
  status: 'complete',
  currency: 'USD',
  metricDefinitionVersion: 'maxx-causal-contribution-v1',
  realizationHorizonDays: 30,
  costPolicyVersion: 'cost-v1',
  causalDecisionPackageId: 'decision-package-v1',
  measurementDesignId: 'design-v1',
  estimand: 'marginal_contribution_vs_current_state',
  collectedRevenue: 1_200,
  refundsAndChargebacks: 0,
  paymentProcessingFees: 36,
  variableFulfillmentCosts: 264,
  observedTreatmentAdSpend: 400,
  adSpend: 400,
  contributionAfterAds: 500,
  contributionInterval: { lower: 100, upper: 900, confidence: 0.9 },
  observedSettledPayments: 6,
  matured: true,
  collectionLineage: 'processor_settled',
  measurementLineage: 'quasi_experimental_comparison',
  costLineage: 'governed_cost_policy',
  incrementality: 'quasi_experimental',
  ...overrides,
})

const evidence = (overrides: Partial<DirectionalEvidence> = {}): DirectionalEvidence => ({
  // Legacy booking/CPA fields stay diagnostic during the cutover and must not decide money direction.
  objective: 'bookings',
  exactCpa: 25,
  provenOutcomes: 16,
  lagged: { spend: 400, outcomes: 16, cpa: 25, matured: true },
  postPeriodCorroboratesLoss: true,
  structuralContinuity: true,
  windowsConflict: false,
  targetCpa: 60,
  maxCpa: 100,
  targetPolicyStatus: 'governed',
  profitPolicy: {
    status: 'governed',
    version: 'maxx-owner-profit-v1',
    objective: 'maximize_incremental_contribution_from_ad_attributed_collected_revenue',
    dailyBudgetCeiling: 100,
    currentAccountDailyBudget: 50,
    proposedAccountDailyBudget: 60,
  },
  recentContribution: contribution(),
  proposedTotalContribution: contribution({ estimand: 'total_contribution_vs_no_ads' }),
  laggedContribution: contribution(),
  ...overrides,
})

describe('owner profit direction policy', () => {
  it('gives Maxx the causal profit north star and demotes attribution to a proxy', () => {
    expect(MAXX_INSTRUCTIONS).toMatch(/NORTH STAR[\s\S]*incremental contribution from AD-ATTRIBUTED[\s\S]*processor-settled collected revenue/i)
    expect(MAXX_INSTRUCTIONS).toMatch(/incremental[\s\S]*caused by advertising[\s\S]*counterfactual/i)
    expect(MAXX_INSTRUCTIONS).toMatch(/exact paid-touch attribution[\s\S]*association[\s\S]*not causation/i)
    expect(MAXX_INSTRUCTIONS).toMatch(/\$100[\s\S]*hard[\s\S]*ceiling/i)
    expect(MAXX_INSTRUCTIONS).toMatch(/profit dollars[\s\S]*not[\s\S]*ROAS|ROAS[\s\S]*not[\s\S]*profit dollars/i)
  })

  it('rejects a cheap booking CPA when collected contribution is negative', () => {
    const negative = contribution({
      collectedRevenue: 500,
      refundsAndChargebacks: 50,
      paymentProcessingFees: 20,
      variableFulfillmentCosts: 180,
      adSpend: 400,
      contributionAfterAds: -150,
      contributionInterval: { lower: -400, upper: 50, confidence: 0.9 },
    })

    const verdict = evaluateDirection('budget_scale', evidence({ recentContribution: negative }))
    expect(verdict.ceiling).toBe('unsupported')
    expect(verdict.reason).toMatch(/negative contribution|does not prove profit/i)
    expect(verdict.reason).not.toMatch(/CPA target/i)
  })

  it('rejects a policy labeled governed when its version is not the owner-approved version', () => {
    const result = evaluateDirection('budget_scale', evidence({
      profitPolicy: {
        ...evidence().profitPolicy!,
        version: 'unapproved-profit-policy',
      },
    }))

    expect(result.ceiling).toBe('unsupported')
    expect(result.reason).toMatch(/owner-approved profit policy version/i)
  })

  it('fails closed when settled collections, refunds, or variable-cost lineage is incomplete', () => {
    const verdict = evaluateDirection('budget_scale', evidence({
      recentContribution: contribution({ status: 'incomplete', costLineage: 'unavailable' }),
    }))

    expect(verdict.ceiling).toBe('unsupported')
    expect(verdict.reason).toMatch(/contribution evidence is incomplete/i)
  })

  it('does not scale a one-outlier result whose contribution interval crosses zero', () => {
    const verdict = evaluateDirection('budget_scale', evidence({
      recentContribution: contribution({
        observedSettledPayments: 1,
        collectedRevenue: 1_400,
        contributionAfterAds: 700,
        contributionInterval: { lower: -450, upper: 1_850, confidence: 0.9 },
      }),
    }))

    expect(verdict.ceiling).toBe('owner_review')
    expect(verdict.reason).toMatch(/interval crosses zero/i)
  })

  it('does not make a low-confidence interval execution-grade merely because it clears zero', () => {
    const verdict = evaluateDirection('budget_scale', evidence({
      recentContribution: contribution({
        contributionInterval: { lower: 100, upper: 900, confidence: 0.5 },
      }),
    }))

    expect(verdict.ceiling).toBe('owner_review')
    expect(verdict.reason).toMatch(/confidence.*90%/i)
  })

  it('blocks any proposed account budget above the owner-approved daily ceiling', () => {
    const verdict = evaluateDirection('budget_scale', evidence({
      profitPolicy: {
        ...evidence().profitPolicy!,
        currentAccountDailyBudget: 100,
        proposedAccountDailyBudget: 101,
      },
    }))

    expect(verdict.ceiling).toBe('unsupported')
    expect(verdict.reason).toMatch(/\$100.*hard ceiling/i)
  })

  it('can support a within-ceiling increase only when the contribution lower bound is positive', () => {
    const verdict = evaluateDirection('budget_scale', evidence())
    expect(verdict.ceiling).toBe('execution')
    expect(verdict.reason).toMatch(/contribution.*above zero/i)
  })

  it('combines separate estimand designs only through one governed causal decision package', () => {
    const verdict = evaluateDirection('budget_scale', evidence({
      recentContribution: contribution({ measurementDesignId: 'marginal-design-v1' }),
      proposedTotalContribution: contribution({
        estimand: 'total_contribution_vs_no_ads',
        measurementDesignId: 'total-vs-no-ads-design-v1',
      }),
    }))
    expect(verdict.ceiling).toBe('execution')

    const mismatched = evaluateDirection('budget_scale', evidence({
      proposedTotalContribution: contribution({
        estimand: 'total_contribution_vs_no_ads',
        causalDecisionPackageId: 'different-decision-package',
      }),
    }))
    expect(mismatched.ceiling).toBe('unsupported')
    expect(mismatched.reason).toMatch(/causal decision package/i)
  })

  it('refuses to transport a positive contribution result across an unproven setup transition', () => {
    const verdict = evaluateDirection('budget_scale', evidence({ structuralContinuity: null }))
    expect(verdict.ceiling).toBe('unsupported')
    expect(verdict.reason).toMatch(/setup continuity.*not proven/i)
  })

  it('does not use positive average contribution as proof that the next dollar is profitable', () => {
    const verdict = evaluateDirection('budget_scale', evidence({
      recentContribution: contribution({ estimand: 'total_contribution_vs_no_ads' }),
    }))
    expect(verdict.ceiling).toBe('unsupported')
    expect(verdict.reason).toMatch(/positive total contribution.*does not prove.*proposed change/i)
  })

  it('rejects a locally improving change when the proposed treatment still loses versus no ads', () => {
    const proposedLoss = contribution({
      estimand: 'total_contribution_vs_no_ads',
      collectedRevenue: 200,
      paymentProcessingFees: 6,
      variableFulfillmentCosts: 94,
      observedTreatmentAdSpend: 400,
      adSpend: 400,
      contributionAfterAds: -300,
      contributionInterval: { lower: -450, upper: -150, confidence: 0.9 },
    })
    const verdict = evaluateDirection('budget_scale', evidence({ proposedTotalContribution: proposedLoss }))
    expect(verdict.ceiling).toBe('unsupported')
    expect(verdict.reason).toMatch(/locally improving change.*no ads/i)
  })

  it('refuses to compare contribution windows with different realization horizons', () => {
    const verdict = evaluateDirection('budget_scale', evidence({
      proposedTotalContribution: contribution({
        estimand: 'total_contribution_vs_no_ads',
        realizationHorizonDays: 60,
      }),
    }))
    expect(verdict.ceiling).toBe('unsupported')
    expect(verdict.reason).toMatch(/do not share.*realization horizon/i)
  })

  it('accepts randomized treatment assignment without requiring last-touch attribution', () => {
    const verdict = evaluateDirection('budget_scale', evidence({
      recentContribution: contribution({
        incrementality: 'controlled_experiment',
        measurementLineage: 'randomized_treatment_assignment',
      }),
      proposedTotalContribution: contribution({
        incrementality: 'controlled_experiment',
        measurementLineage: 'randomized_treatment_assignment',
        estimand: 'total_contribution_vs_no_ads',
      }),
    }))
    expect(verdict.ceiling).toBe('execution')
    expect(verdict.reason).toMatch(/controlled experiment/i)
  })

  it('rejects a causal label whose measurement lineage is only paid-touch association', () => {
    const verdict = evaluateDirection('budget_scale', evidence({
      recentContribution: contribution({ measurementLineage: 'exact_paid_touch' }),
    }))
    expect(verdict.ceiling).toBe('unsupported')
    expect(verdict.reason).toMatch(/lineage does not support.*incrementality design/i)
  })

  it('rejects attributed-only profit evidence because association is not the north star', () => {
    const verdict = evaluateDirection('budget_scale', evidence({
      recentContribution: contribution({
        incrementality: 'attributed_only',
        measurementLineage: 'exact_paid_touch',
        estimand: 'attributed_association',
      }),
    }))

    expect(verdict.ceiling).toBe('unsupported')
    expect(verdict.reason).toMatch(/attributed association, not incremental proof/i)
  })

  it('supports cutting a matured loss but keeps a full pause as an owner decision', () => {
    const loss = contribution({
      estimand: 'total_contribution_vs_no_ads',
      collectedRevenue: 100,
      refundsAndChargebacks: 0,
      paymentProcessingFees: 3,
      variableFulfillmentCosts: 47,
      adSpend: 400,
      contributionAfterAds: -350,
      contributionInterval: { lower: -520, upper: -180, confidence: 0.9 },
    })
    const input = evidence({ recentContribution: loss, laggedContribution: loss })

    expect(evaluateDirection('budget_cut', input).ceiling).toBe('execution')
    expect(evaluateDirection('pause', input).ceiling).toBe('owner_review')
  })

  it('refuses to cut a unit whose mature collected contribution is positive', () => {
    const positiveUnitContribution = contribution({ estimand: 'total_contribution_vs_no_ads' })
    const verdict = evaluateDirection('budget_cut', evidence({
      recentContribution: positiveUnitContribution,
      laggedContribution: positiveUnitContribution,
    }))
    expect(verdict.ceiling).toBe('unsupported')
    expect(verdict.reason).toMatch(/positive contribution/i)
  })
})
