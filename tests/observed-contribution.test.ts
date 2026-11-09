import { describe, expect, it } from 'vitest'
import { buildObservedContributionView } from '@/lib/economics/observed-contribution'
import type { SettlementWindowSummary } from '@/lib/economics/settlement-ledger'
import type { VariableCostWindowSummary } from '@/lib/economics/variable-cost-ledger'

const settlement: SettlementWindowSummary = {
  businessMoney: {
    status: 'available', collectedRevenueExTaxMinor: 20_000,
    refundsAndChargebacksMinor: 1_000, paymentProcessingFeesMinor: 600,
    netCollectedBeforeVariableCostsAndAdsMinor: 18_400,
    excludedTaxMinor: 1_400, eventCount: 3,
  },
  outcomeLinkage: { status: 'available', totals: {
    collectedRevenueExTaxMinor: 20_000, refundsAndChargebacksMinor: 1_000,
    paymentProcessingFeesMinor: 600, netCollectedBeforeVariableCostsAndAdsMinor: 18_400,
    excludedTaxMinor: 1_400, eventCount: 3,
  }, outcomeCount: 1 },
  blockerCodes: [],
  diagnostics: { sourceEventCount: 3, inWindowEventCount: 3, ignoredOutsideWindow: 0, unlinkedEventCount: 0 },
}
const costs: VariableCostWindowSummary = {
  status: 'available', incurredVariableCostsMinor: 2_500,
  reversedVariableCostsMinor: 0, totalVariableCostsMinor: 2_500,
  byCategoryMinor: { consumables: 2_500 }, outcomeCount: 1, eventCount: 1,
  blockerCodes: [],
  diagnostics: { sourceEventCount: 1, inWindowEventCount: 1, ignoredOutsideWindow: 0, requiredSourceCount: 1, coveredSourceCount: 1 },
}
const availableSettlement = settlement.businessMoney as Extract<
  SettlementWindowSummary['businessMoney'], { status: 'available' }
>

describe('observed contribution composition', () => {
  it('reconciles exact facts but refuses to relabel total business money as attributed or incremental', () => {
    const result = buildObservedContributionView({
      settlement,
      variableCosts: costs,
      adSpend: { status: 'available', totalSpend: '65.1234', dayCount: 2, blockerCodes: [] },
      policyVersion: `sha256:${'a'.repeat(64)}`,
    })
    expect(result.observedBusinessContribution).toMatchObject({
      status: 'available',
      basis: 'account_total_observed_noncausal',
      components: {
        collectedRevenueExTax: '200.0000', refundsAndChargebacks: '10.0000',
        paymentProcessingFees: '6.0000', variableFulfillmentCosts: '25.0000',
        adSpendAmount: '65.1234', contributionAfterAds: '93.8766',
      },
    })
    expect(result.adAttributedContribution).toMatchObject({ status: 'unavailable' })
    expect(result.incrementalContribution).toMatchObject({ status: 'unavailable' })
    expect(result.actionAuthority).toBe('none')
    expect(JSON.stringify(result)).not.toMatch(/booked.value|platform.roas|gross.scheduled/i)
  })

  it('propagates missing source coverage instead of manufacturing zero contribution', () => {
    const result = buildObservedContributionView({
      settlement: {
        ...settlement,
        businessMoney: { status: 'unavailable', totals: null },
        blockerCodes: ['processor_source_missing'],
      },
      variableCosts: { ...costs, status: 'unavailable', incurredVariableCostsMinor: null,
        reversedVariableCostsMinor: null, totalVariableCostsMinor: null,
        byCategoryMinor: null, outcomeCount: null, eventCount: null,
        blockerCodes: ['variable_cost_source_missing:owner_actual_cost_export'] },
      adSpend: { status: 'unavailable', totalSpend: null, dayCount: null,
        blockerCodes: ['meta_spend_day_missing:2026-08-01'] },
      policyVersion: `sha256:${'a'.repeat(64)}`,
    })
    expect(result.observedBusinessContribution.status).toBe('unavailable')
    expect(result.observedBusinessContribution.blockerCodes).toEqual(expect.arrayContaining([
      'processor_source_missing',
      'variable_cost_source_missing:owner_actual_cost_export',
      'meta_spend_day_missing:2026-08-01',
    ]))
  })

  it('rejects pre-netted or contradictory source totals at the composition boundary', () => {
    expect(() => buildObservedContributionView({
      settlement: {
        ...settlement,
        businessMoney: {
          ...availableSettlement,
          status: 'available',
          netCollectedBeforeVariableCostsAndAdsMinor: 99,
        },
      },
      variableCosts: costs,
      adSpend: { status: 'available', totalSpend: '65.1234', dayCount: 2, blockerCodes: [] },
      policyVersion: `sha256:${'a'.repeat(64)}`,
    })).toThrow(/settlement components do not reconcile/i)
  })
})
