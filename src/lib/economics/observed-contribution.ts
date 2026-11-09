import type { AccountSpendWindowSummary } from './ad-spend-reader'
import { accountCurrency } from '@/config/business-config'
import type { ProcessorSettlementEvent, SettlementWindowSummary } from './settlement-ledger'
import type { VariableCostEvent, VariableCostWindowSummary } from './variable-cost-ledger'
import {
  MAXX_CONTRIBUTION_DEFINITION_VERSION,
  MAXX_OWNER_PROFIT_POLICY,
} from './profit-policy'

interface ContributionComponents {
  collectedRevenueExTax: string
  refundsAndChargebacks: string
  paymentProcessingFees: string
  variableFulfillmentCosts: string
  adSpendAmount: string
  contributionAfterAds: string
}

export interface PaidTouchAdAssignment {
  /** The outcome uuid the paid touch is linked to. */
  outcomeId: string
  linkId: string
  touchId: string
  metaCampaignId: string
  metaAdsetId: string
  metaAdId: string
  observedAt: string
  outcomeCreatedAt?: string
  linkedAt: string
  policyVersion: 1
}

type PaidTouchContribution =
  | { status: 'unavailable'; components: null; blockerCodes: string[] }
  | {
      status: 'available' | 'partial'
      basis: 'exact_positive_paid_touch_association_noncausal'
      components: ContributionComponents
      paidTouchOutcomeCount: number
      candidateOutcomeCount: number
      unclassifiedOutcomeCount: number
      settledEventCount: number
      variableCostEventCount: number
      metaCampaignIds: string[]
      metaAdsetIds: string[]
      metaAdIds: string[]
      blockerCodes: string[]
    }

export interface ObservedContributionView {
  policyVersion: string
  currency: string
  northStar: typeof MAXX_OWNER_PROFIT_POLICY.objective
  metricDefinitionVersion: typeof MAXX_CONTRIBUTION_DEFINITION_VERSION
  observedBusinessContribution:
    | {
        status: 'available'
        basis: 'account_total_observed_noncausal'
        components: ContributionComponents
        settledEventCount: number
        variableCostEventCount: number
        spendDayCount: number
        blockerCodes: []
      }
    | { status: 'unavailable'; components: null; blockerCodes: string[] }
  adAttributedContribution: PaidTouchContribution
  incrementalContribution: {
    status: 'unavailable'
    blockerCodes: ['payment_to_experiment_assignment_missing', 'causal_comparison_missing']
  }
  actionAuthority: 'none'
}

const SPEND = /^(?:0|[1-9]\d{0,13})\.\d{4}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/

function instant(value: string, label: string): number {
  const parsed = new Date(value).getTime()
  if (!ISO_INSTANT.test(value) || !Number.isFinite(parsed)) {
    throw new Error(`Paid-touch assignment ${label} is invalid.`)
  }
  return parsed
}

function exactInteger(value: number, label: string): bigint {
  if (!Number.isSafeInteger(value)) throw new Error(`${label} must use exact safe integer minor units.`)
  return BigInt(value)
}

function centsToUnits(value: number, label: string): bigint {
  return exactInteger(value, label) * BigInt(100)
}

function spendToUnits(value: string): bigint {
  if (!SPEND.test(value)) throw new Error('Ad spend must be a canonical four-decimal amount in the account currency.')
  const [whole, fraction] = value.split('.')
  return BigInt(whole) * BigInt(10_000) + BigInt(fraction)
}

function usd(units: bigint): string {
  const negative = units < BigInt(0)
  const absolute = negative ? -units : units
  return `${negative ? '-' : ''}${absolute / BigInt(10_000)}.${(absolute % BigInt(10_000)).toString().padStart(4, '0')}`
}

function validateSources(
  settlement: Extract<SettlementWindowSummary['businessMoney'], { status: 'available' }>,
  costs: Extract<VariableCostWindowSummary, { status: 'available' }>,
): void {
  const collected = exactInteger(settlement.collectedRevenueExTaxMinor, 'Collected revenue')
  const refunds = exactInteger(settlement.refundsAndChargebacksMinor, 'Refunds and chargebacks')
  const fees = exactInteger(settlement.paymentProcessingFeesMinor, 'Payment fees')
  const net = exactInteger(settlement.netCollectedBeforeVariableCostsAndAdsMinor, 'Settlement net')
  if (collected - refunds - fees !== net) {
    throw new Error('Settlement components do not reconcile at the contribution boundary.')
  }
  const incurred = exactInteger(costs.incurredVariableCostsMinor, 'Incurred variable costs')
  const reversed = exactInteger(costs.reversedVariableCostsMinor, 'Reversed variable costs')
  const total = exactInteger(costs.totalVariableCostsMinor, 'Variable cost total')
  if (incurred - reversed !== total) {
    throw new Error('Variable-cost components do not reconcile at the contribution boundary.')
  }
  const categoryTotal = Object.values(costs.byCategoryMinor)
    .reduce((sum, value) => sum + exactInteger(value, 'Variable cost category'), BigInt(0))
  if (categoryTotal !== total) {
    throw new Error('Variable-cost categories do not reconcile at the contribution boundary.')
  }
  if (!Number.isSafeInteger(settlement.eventCount) || settlement.eventCount < 0
      || !Number.isSafeInteger(costs.eventCount) || costs.eventCount < 0) {
    throw new Error('Contribution source event counts are invalid.')
  }
}

function settlementEventTotals(events: ProcessorSettlementEvent[]) {
  return events.reduce((totals, event) => {
    if (!event.processorTransactionId.trim()) {
      throw new Error('Settlement transaction identity is incomplete at the attribution boundary.')
    }
    const amounts = [
      event.collectedExTaxMinor, event.refundsExTaxMinor, event.chargebacksExTaxMinor,
      event.recoveredChargebacksExTaxMinor, event.paymentFeesMinor,
    ]
    if (!amounts.every(Number.isSafeInteger)) {
      throw new Error('Settlement attribution inputs must use exact safe integer minor units.')
    }
    return {
      collected: totals.collected + event.collectedExTaxMinor,
      refundsAndChargebacks: totals.refundsAndChargebacks + event.refundsExTaxMinor
        + event.chargebacksExTaxMinor - event.recoveredChargebacksExTaxMinor,
      fees: totals.fees + event.paymentFeesMinor,
    }
  }, { collected: 0, refundsAndChargebacks: 0, fees: 0 })
}

function validateEventReconciliation(
  settlement: Extract<SettlementWindowSummary['businessMoney'], { status: 'available' }>,
  settlementEvents: ProcessorSettlementEvent[],
  costs: Extract<VariableCostWindowSummary, { status: 'available' }>,
  variableCostEvents: VariableCostEvent[],
): void {
  const money = settlementEventTotals(settlementEvents)
  if (money.collected !== settlement.collectedRevenueExTaxMinor
      || money.refundsAndChargebacks !== settlement.refundsAndChargebacksMinor
      || money.fees !== settlement.paymentProcessingFeesMinor
      || settlementEvents.length !== settlement.eventCount) {
    throw new Error('Settlement event rows do not reconcile to the governed window summary.')
  }
  const costTotal = variableCostEvents.reduce((sum, event) => {
    if (!UUID.test(event.outcomeId) || !Number.isSafeInteger(event.amountMinor)) {
      throw new Error('Variable-cost attribution inputs are malformed.')
    }
    return sum + (event.eventKind === 'cost_incurred' ? event.amountMinor : -event.amountMinor)
  }, 0)
  if (!Number.isSafeInteger(costTotal)
      || costTotal !== costs.totalVariableCostsMinor
      || variableCostEvents.length !== costs.eventCount) {
    throw new Error('Variable-cost event rows do not reconcile to the governed window summary.')
  }
}

function buildPaidTouchContribution(input: {
  settlement: Extract<SettlementWindowSummary['businessMoney'], { status: 'available' }>
  settlementEvents: ProcessorSettlementEvent[]
  variableCosts: Extract<VariableCostWindowSummary, { status: 'available' }>
  variableCostEvents: VariableCostEvent[]
  adSpend: Extract<AccountSpendWindowSummary, { status: 'available' }>
  assignments: PaidTouchAdAssignment[]
}): PaidTouchContribution {
  validateEventReconciliation(
    input.settlement, input.settlementEvents, input.variableCosts, input.variableCostEvents,
  )
  const transactionOutcomes = new Map<string, Set<string>>()
  for (const event of input.settlementEvents) {
    const outcomes = transactionOutcomes.get(event.processorTransactionId) ?? new Set<string>()
    if (event.outcomeId !== null) outcomes.add(event.outcomeId)
    transactionOutcomes.set(event.processorTransactionId, outcomes)
  }
  for (const [transactionId, outcomeIds] of transactionOutcomes) {
    if (outcomeIds.size > 1) {
      throw new Error(`Processor transaction ${transactionId} has contradictory outcome identities.`)
    }
  }
  const resolvedSettlement = input.settlementEvents.map((event) => {
    const inferred = [...(transactionOutcomes.get(event.processorTransactionId) ?? [])][0] ?? null
    return { ...event, outcomeId: event.outcomeId ?? inferred }
  })
  if (resolvedSettlement.some((event) => event.outcomeId === null)) {
    return {
      status: 'unavailable', components: null,
      blockerCodes: ['settlement_transaction_outcome_unresolved'],
    }
  }

  const candidateIds = new Set<string>([
    ...resolvedSettlement.map((event) => event.outcomeId!),
    ...input.variableCostEvents.map((event) => event.outcomeId),
  ])
  const assignmentByOutcome = new Map<string, PaidTouchAdAssignment>()
  for (const assignment of input.assignments) {
    if (!UUID.test(assignment.outcomeId) || !candidateIds.has(assignment.outcomeId)) {
      throw new Error('Paid-touch assignment references an invalid or unexpected outcome.')
    }
    if (assignmentByOutcome.has(assignment.outcomeId)) {
      throw new Error(`Duplicate paid-touch assignment for outcome ${assignment.outcomeId}.`)
    }
    if (assignment.policyVersion !== 1) {
      throw new Error('Paid-touch assignment policy version is unsupported.')
    }
    if (!UUID.test(assignment.linkId) || !UUID.test(assignment.touchId)) {
      throw new Error('Paid-touch assignment lineage identity is invalid.')
    }
    if (![assignment.metaCampaignId, assignment.metaAdsetId, assignment.metaAdId]
      .every((value) => /^\d{1,32}$/.test(value))) {
      throw new Error('Paid-touch assignment lacks a complete immutable Meta ID trio.')
    }
    if (instant(assignment.observedAt, 'observed_at') > instant(assignment.linkedAt, 'linked_at')) {
      throw new Error('Paid-touch assignment chronology is invalid.')
    }
    assignmentByOutcome.set(assignment.outcomeId, assignment)
  }
  if (assignmentByOutcome.size === 0 && candidateIds.size > 0) {
    return {
      status: 'unavailable', components: null,
      blockerCodes: ['payment_to_ad_assignment_missing'],
    }
  }

  const paidSettlementEvents = resolvedSettlement.filter((event) => (
    assignmentByOutcome.has(event.outcomeId!)
  ))
  const paidCostEvents = input.variableCostEvents.filter((event) => (
    assignmentByOutcome.has(event.outcomeId)
  ))
  const paidMoney = settlementEventTotals(paidSettlementEvents)
  const paidCosts = paidCostEvents.reduce((sum, event) => (
    sum + (event.eventKind === 'cost_incurred' ? event.amountMinor : -event.amountMinor)
  ), 0)
  const collected = centsToUnits(paidMoney.collected, 'Paid-touch collected revenue')
  const refunds = centsToUnits(paidMoney.refundsAndChargebacks, 'Paid-touch refunds and chargebacks')
  const fees = centsToUnits(paidMoney.fees, 'Paid-touch payment fees')
  const variable = centsToUnits(paidCosts, 'Paid-touch variable costs')
  const adSpend = spendToUnits(input.adSpend.totalSpend)
  const contribution = collected - refunds - fees - variable - adSpend
  const unclassifiedCount = [...candidateIds]
    .filter((outcomeId) => !assignmentByOutcome.has(outcomeId)).length
  const assigned = [...assignmentByOutcome.values()]
  return {
    status: unclassifiedCount === 0 ? 'available' : 'partial',
    basis: 'exact_positive_paid_touch_association_noncausal',
    components: {
      collectedRevenueExTax: usd(collected),
      refundsAndChargebacks: usd(refunds),
      paymentProcessingFees: usd(fees),
      variableFulfillmentCosts: usd(variable),
      adSpendAmount: usd(adSpend),
      contributionAfterAds: usd(contribution),
    },
    paidTouchOutcomeCount: assignmentByOutcome.size,
    candidateOutcomeCount: candidateIds.size,
    unclassifiedOutcomeCount: unclassifiedCount,
    settledEventCount: paidSettlementEvents.length,
    variableCostEventCount: paidCostEvents.length,
    metaCampaignIds: [...new Set(assigned.map((row) => row.metaCampaignId))].sort(),
    metaAdsetIds: [...new Set(assigned.map((row) => row.metaAdsetId))].sort(),
    metaAdIds: [...new Set(assigned.map((row) => row.metaAdId))].sort(),
    blockerCodes: unclassifiedCount === 0 ? [] : ['paid_touch_classification_incomplete'],
  }
}

export function buildObservedContributionView(input: {
  settlement: SettlementWindowSummary
  settlementEvents?: ProcessorSettlementEvent[]
  variableCosts: VariableCostWindowSummary
  variableCostEvents?: VariableCostEvent[]
  adSpend: AccountSpendWindowSummary
  paidTouchAssignments?: PaidTouchAdAssignment[]
  paidTouchAssignmentBlockerCodes?: string[]
  policyVersion: string
}): ObservedContributionView {
  if (!/^sha256:[0-9a-f]{64}$/.test(input.policyVersion)) {
    throw new Error('Observed contribution requires an exact governed policy hash.')
  }
  const sourceBlockers = [
    ...(input.settlement.businessMoney.status === 'unavailable' ? input.settlement.blockerCodes : []),
    ...(input.variableCosts.status === 'unavailable' ? input.variableCosts.blockerCodes : []),
    ...(input.adSpend.status === 'unavailable' ? input.adSpend.blockerCodes : []),
  ]
  const unavailableAssociation: PaidTouchContribution = {
    status: 'unavailable', components: null,
    blockerCodes: sourceBlockers.length > 0
      ? [...new Set(sourceBlockers)].sort()
      : input.paidTouchAssignmentBlockerCodes?.length
        ? [...new Set(input.paidTouchAssignmentBlockerCodes)].sort()
        : ['payment_to_ad_assignment_missing'],
  }
  const common = {
    policyVersion: input.policyVersion,
    currency: accountCurrency(),
    northStar: MAXX_OWNER_PROFIT_POLICY.objective,
    metricDefinitionVersion: MAXX_CONTRIBUTION_DEFINITION_VERSION,
    adAttributedContribution: unavailableAssociation,
    incrementalContribution: {
      status: 'unavailable' as const,
      blockerCodes: [
        'payment_to_experiment_assignment_missing', 'causal_comparison_missing',
      ] as ['payment_to_experiment_assignment_missing', 'causal_comparison_missing'],
    },
    actionAuthority: 'none' as const,
  }
  if (sourceBlockers.length > 0
      || input.settlement.businessMoney.status === 'unavailable'
      || input.variableCosts.status === 'unavailable'
      || input.adSpend.status === 'unavailable') {
    return {
      ...common,
      observedBusinessContribution: {
        status: 'unavailable', components: null,
        blockerCodes: [...new Set(sourceBlockers)].sort(),
      },
    }
  }

  const settlement = input.settlement.businessMoney
  const costs = input.variableCosts
  const spend = input.adSpend
  validateSources(settlement, costs)
  if (!Number.isSafeInteger(spend.dayCount) || spend.dayCount < 1) {
    throw new Error('Contribution spend day count is invalid.')
  }
  const collected = centsToUnits(settlement.collectedRevenueExTaxMinor, 'Collected revenue')
  const refunds = centsToUnits(settlement.refundsAndChargebacksMinor, 'Refunds and chargebacks')
  const fees = centsToUnits(settlement.paymentProcessingFeesMinor, 'Payment fees')
  const variable = centsToUnits(costs.totalVariableCostsMinor, 'Variable costs')
  const adSpend = spendToUnits(spend.totalSpend)
  const contribution = collected - refunds - fees - variable - adSpend
  const adAttributedContribution = input.settlementEvents
      && input.variableCostEvents
      && input.paidTouchAssignments
    ? buildPaidTouchContribution({
        settlement,
        settlementEvents: input.settlementEvents,
        variableCosts: costs,
        variableCostEvents: input.variableCostEvents,
        adSpend: spend,
        assignments: input.paidTouchAssignments,
      })
    : unavailableAssociation
  return {
    ...common,
    adAttributedContribution,
    observedBusinessContribution: {
      status: 'available',
      basis: 'account_total_observed_noncausal',
      components: {
        collectedRevenueExTax: usd(collected),
        refundsAndChargebacks: usd(refunds),
        paymentProcessingFees: usd(fees),
        variableFulfillmentCosts: usd(variable),
        adSpendAmount: usd(adSpend),
        contributionAfterAds: usd(contribution),
      },
      settledEventCount: settlement.eventCount,
      variableCostEventCount: costs.eventCount,
      spendDayCount: spend.dayCount,
      blockerCodes: [],
    },
  }
}
