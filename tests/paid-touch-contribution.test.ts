import { describe, expect, it } from 'vitest'
import {
  buildObservedContributionView,
  type PaidTouchAdAssignment,
} from '@/lib/economics/observed-contribution'
import type { AccountSpendWindowSummary } from '@/lib/economics/ad-spend-reader'
import type {
  ProcessorSettlementEvent,
  SettlementWindowSummary,
} from '@/lib/economics/settlement-ledger'
import type {
  VariableCostEvent,
  VariableCostWindowSummary,
} from '@/lib/economics/variable-cost-ledger'

/** Outcome uuid fixture for a numeric case id (economics identity is the outcome uuid). */
const oid = (n: number): string => `00000000-0000-4000-a000-${String(n).padStart(12, '0')}`

const POLICY = `sha256:${'a'.repeat(64)}`
const spend: AccountSpendWindowSummary = {
  status: 'available', totalSpend: '65.0000', dayCount: 2, blockerCodes: [],
}
const settlementEvent = (
  id: number,
  overrides: Partial<ProcessorSettlementEvent> = {},
): ProcessorSettlementEvent => ({
  id: `settlement-${id}`,
  processorEventId: `event-${id}`,
  processorTransactionId: `transaction-${id}`,
  eventKind: 'payment_settled',
  occurredAt: '2026-08-01T12:00:00Z',
  availableAt: '2026-08-01T13:00:00Z',
  currency: 'USD',
  outcomeId: oid(101),
  collectedExTaxMinor: 100_000,
  refundsExTaxMinor: 0,
  chargebacksExTaxMinor: 0,
  recoveredChargebacksExTaxMinor: 0,
  paymentFeesMinor: 0,
  taxAmountMinor: 0,
  ...overrides,
})
const costEvent = (
  id: number,
  outcome: number,
  amountMinor: number,
): VariableCostEvent => ({
  id: `cost-${id}`,
  costSource: 'owner_actual_cost_export',
  sourceEventId: `cost-event-${id}`,
  eventKind: 'cost_incurred',
  reversesSourceEventId: null,
  occurredAt: '2026-08-01T14:00:00Z',
  availableAt: '2026-08-01T15:00:00Z',
  currency: 'USD',
  outcomeId: oid(outcome),
  category: 'consumables',
  amountMinor,
})
const assignment = (outcome: number): PaidTouchAdAssignment => ({
  outcomeId: oid(outcome),
  linkId: `00000000-0000-4000-8000-${String(outcome).padStart(12, '0')}`,
  touchId: `00000000-0000-4000-9000-${String(outcome).padStart(12, '0')}`,
  metaCampaignId: '1001',
  metaAdsetId: '2001',
  metaAdId: '3001',
  observedAt: '2026-07-31T12:00:00Z',
  linkedAt: '2026-08-01T11:00:00Z',
  policyVersion: 1,
})

function summaries(
  events: ProcessorSettlementEvent[],
  costs: VariableCostEvent[],
): { settlement: SettlementWindowSummary; variableCosts: VariableCostWindowSummary } {
  const collected = events.reduce((sum, row) => sum + row.collectedExTaxMinor, 0)
  const refunds = events.reduce((sum, row) => (
    sum + row.refundsExTaxMinor + row.chargebacksExTaxMinor - row.recoveredChargebacksExTaxMinor
  ), 0)
  const fees = events.reduce((sum, row) => sum + row.paymentFeesMinor, 0)
  const variable = costs.reduce((sum, row) => (
    sum + (row.eventKind === 'cost_incurred' ? row.amountMinor : -row.amountMinor)
  ), 0)
  return {
    settlement: {
      businessMoney: {
        status: 'available', collectedRevenueExTaxMinor: collected,
        refundsAndChargebacksMinor: refunds, paymentProcessingFeesMinor: fees,
        netCollectedBeforeVariableCostsAndAdsMinor: collected - refunds - fees,
        excludedTaxMinor: 0, eventCount: events.length,
      },
      outcomeLinkage: { status: 'unavailable', totals: null, outcomeCount: null },
      blockerCodes: events.some((row) => row.outcomeId === null)
        ? ['outcome_linkage_incomplete'] : [],
      diagnostics: {
        sourceEventCount: events.length, inWindowEventCount: events.length,
        ignoredOutsideWindow: 0,
        unlinkedEventCount: events.filter((row) => row.outcomeId === null).length,
      },
    },
    variableCosts: {
      status: 'available', incurredVariableCostsMinor: variable,
      reversedVariableCostsMinor: 0, totalVariableCostsMinor: variable,
      byCategoryMinor: { consumables: variable },
      outcomeCount: new Set(costs.map((row) => row.outcomeId)).size,
      eventCount: costs.length, blockerCodes: [],
      diagnostics: {
        sourceEventCount: costs.length, inWindowEventCount: costs.length,
        ignoredOutsideWindow: 0, requiredSourceCount: 1, coveredSourceCount: 1,
      },
    },
  }
}

function build(
  events: ProcessorSettlementEvent[],
  costs: VariableCostEvent[],
  assignments: PaidTouchAdAssignment[],
) {
  const source = summaries(events, costs)
  return buildObservedContributionView({
    ...source, settlementEvents: events, variableCostEvents: costs,
    paidTouchAssignments: assignments, adSpend: spend, policyVersion: POLICY,
  })
}

describe('exact paid-touch contribution association', () => {
  it('joins settled money and actual cost to the immutable paid ad identity', () => {
    const events = [
      settlementEvent(1, { processorTransactionId: 'paid-transaction' }),
      settlementEvent(2, {
        processorTransactionId: 'paid-transaction', outcomeId: null,
        eventKind: 'refund_settled', collectedExTaxMinor: 0, refundsExTaxMinor: 10_000,
      }),
      settlementEvent(3, {
        processorTransactionId: 'paid-transaction', eventKind: 'fee_adjustment',
        collectedExTaxMinor: 0, paymentFeesMinor: 3_000,
      }),
    ]
    const result = build(events, [costEvent(1, 101, 20_000)], [assignment(101)])
    expect(result.adAttributedContribution).toMatchObject({
      status: 'available', basis: 'exact_positive_paid_touch_association_noncausal',
      components: {
        collectedRevenueExTax: '1000.0000', refundsAndChargebacks: '100.0000',
        paymentProcessingFees: '30.0000', variableFulfillmentCosts: '200.0000',
        adSpendAmount: '65.0000', contributionAfterAds: '605.0000',
      },
      paidTouchOutcomeCount: 1,
      metaAdIds: ['3001'],
      blockerCodes: [],
    })
    expect(result.incrementalContribution.status).toBe('unavailable')
    expect(result.actionAuthority).toBe('none')
  })

  it('reports a partial positive-link subset instead of treating missing links as organic', () => {
    const events = [
      settlementEvent(1),
      settlementEvent(2, { outcomeId: oid(202), collectedExTaxMinor: 50_000 }),
    ]
    const result = build(
      events,
      [costEvent(1, 101, 20_000), costEvent(2, 202, 5_000)],
      [assignment(101)],
    )
    expect(result.adAttributedContribution).toMatchObject({
      status: 'partial',
      basis: 'exact_positive_paid_touch_association_noncausal',
      paidTouchOutcomeCount: 1,
      candidateOutcomeCount: 2,
      unclassifiedOutcomeCount: 1,
      blockerCodes: ['paid_touch_classification_incomplete'],
    })
    expect(JSON.stringify(result.adAttributedContribution)).not.toMatch(/organic/i)
  })

  it('fails closed when a settlement transaction has no appointment identity', () => {
    const result = build([
      settlementEvent(1, { outcomeId: null }),
    ], [costEvent(1, 101, 20_000)], [assignment(101)])
    expect(result.adAttributedContribution).toEqual({
      status: 'unavailable', components: null,
      blockerCodes: ['settlement_transaction_outcome_unresolved'],
    })
  })

  it('rejects a processor transaction mapped to contradictory appointments', () => {
    expect(() => build([
      settlementEvent(1, { processorTransactionId: 'conflict', outcomeId: oid(101) }),
      settlementEvent(2, { processorTransactionId: 'conflict', outcomeId: oid(202) }),
    ], [], [assignment(101), assignment(202)])).toThrow(/contradictory outcome identities/i)
  })

  it('treats a completely covered empty settlement window as a real zero, not missing data', () => {
    const result = build([], [], [])
    expect(result.adAttributedContribution).toMatchObject({
      status: 'available',
      components: {
        collectedRevenueExTax: '0.0000',
        variableFulfillmentCosts: '0.0000',
        adSpendAmount: '65.0000',
        contributionAfterAds: '-65.0000',
      },
      paidTouchOutcomeCount: 0,
      candidateOutcomeCount: 0,
      blockerCodes: [],
    })
  })

  it('keeps observed contribution available when only the paid-touch source fails', () => {
    const source = summaries([settlementEvent(1)], [costEvent(1, 101, 20_000)])
    const result = buildObservedContributionView({
      ...source,
      settlementEvents: [settlementEvent(1)],
      variableCostEvents: [costEvent(1, 101, 20_000)],
      paidTouchAssignmentBlockerCodes: ['paid_touch_assignment_source_read_failed'],
      adSpend: spend,
      policyVersion: POLICY,
    })
    expect(result.observedBusinessContribution.status).toBe('available')
    expect(result.adAttributedContribution).toEqual({
      status: 'unavailable', components: null,
      blockerCodes: ['paid_touch_assignment_source_read_failed'],
    })
  })

  it('rejects malformed assignment lineage at the composition boundary', () => {
    expect(() => build([settlementEvent(1)], [], [{
      ...assignment(101), policyVersion: 2,
    } as unknown as PaidTouchAdAssignment])).toThrow(/policy version/i)
    expect(() => build([settlementEvent(1)], [], [{
      ...assignment(101), observedAt: '2026-08-02T00:00:00Z', linkedAt: '2026-08-01T00:00:00Z',
    }])).toThrow(/chronology/i)
  })
})
