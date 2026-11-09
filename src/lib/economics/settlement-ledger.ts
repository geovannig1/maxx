import { accountCurrency, isIsoCurrency } from '@/config/business-config'
export type ProcessorSettlementEventKind =
  | 'payment_settled'
  | 'refund_settled'
  | 'chargeback_settled'
  | 'chargeback_reversed'
  | 'fee_adjustment'

export interface ProcessorSettlementEvent {
  id: string
  processorEventId: string
  processorTransactionId: string
  eventKind: ProcessorSettlementEventKind
  occurredAt: string
  availableAt: string
  /** ISO 4217; must be the ad account's currency. */
  currency: string
  /** The outcome uuid this event settles, or null when the processor row names none. */
  outcomeId: string | null
  collectedExTaxMinor: number
  refundsExTaxMinor: number
  chargebacksExTaxMinor: number
  recoveredChargebacksExTaxMinor: number
  paymentFeesMinor: number
  taxAmountMinor: number
}

export interface SettlementSourceCoverage {
  complete: boolean
  windowStart: string
  windowEnd: string
  blockerCodes: string[]
}

export interface SettlementMoneyTotals {
  collectedRevenueExTaxMinor: number
  refundsAndChargebacksMinor: number
  paymentProcessingFeesMinor: number
  netCollectedBeforeVariableCostsAndAdsMinor: number
  excludedTaxMinor: number
  eventCount: number
}

export interface SettlementWindowSummary {
  businessMoney:
    | ({ status: 'available' } & SettlementMoneyTotals)
    | { status: 'unavailable'; totals: null }
  outcomeLinkage:
    | { status: 'available'; totals: SettlementMoneyTotals; outcomeCount: number }
    | { status: 'unavailable'; totals: null; outcomeCount: null }
  blockerCodes: string[]
  diagnostics: {
    sourceEventCount: number
    inWindowEventCount: number
    ignoredOutsideWindow: number
    unlinkedEventCount: number
  }
}

const MAX_AMOUNT_MINOR = 100_000_000_000
const MAX_EVENTS = 10_000
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/

function time(value: string, label: string): number {
  const parsed = new Date(value).getTime()
  if (!ISO_INSTANT.test(value) || !Number.isFinite(parsed)) {
    throw new Error(`Invalid ${label} timestamp.`)
  }
  return parsed
}

function amountMinor(value: number, label: string, signed = false): number {
  if (!Number.isSafeInteger(value)) {
    throw new Error(`Settlement ${label} must use exact integer minor units.`)
  }
  const valid = signed
    ? Math.abs(value) <= MAX_AMOUNT_MINOR
    : value >= 0 && value <= MAX_AMOUNT_MINOR
  if (!valid) throw new Error(`Invalid settlement ${label}.`)
  return value
}

function validateEvent(event: ProcessorSettlementEvent): void {
  if (!event.id?.trim() || !event.processorEventId?.trim() || !event.processorTransactionId?.trim()) {
    throw new Error('Settlement event identity is incomplete.')
  }
  if (!isIsoCurrency(event.currency) || event.currency !== accountCurrency()) {
    throw new Error(`Settlement event currency must be the account currency (${accountCurrency()}); currencies are never converted.`)
  }
  const occurred = time(event.occurredAt, 'settlement occurred_at')
  const available = time(event.availableAt, 'settlement available_at')
  if (available < occurred) throw new Error('Settlement available_at precedes occurred_at.')
  if (event.outcomeId !== null && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(event.outcomeId)) {
    throw new Error('Settlement outcome identity is invalid.')
  }
  const collected = amountMinor(event.collectedExTaxMinor, 'collected_ex_tax_minor')
  const refunds = amountMinor(event.refundsExTaxMinor, 'refunds_ex_tax_minor')
  const chargebacks = amountMinor(event.chargebacksExTaxMinor, 'chargebacks_ex_tax_minor')
  const recovered = amountMinor(
    event.recoveredChargebacksExTaxMinor,
    'recovered_chargebacks_ex_tax_minor',
  )
  const fees = amountMinor(event.paymentFeesMinor, 'payment_fees_minor', true)
  amountMinor(event.taxAmountMinor, 'tax_amount_minor')

  const validShape =
    (event.eventKind === 'payment_settled'
      && collected > 0 && refunds === 0 && chargebacks === 0 && recovered === 0)
    || (event.eventKind === 'refund_settled'
      && collected === 0 && refunds > 0 && chargebacks === 0 && recovered === 0)
    || (event.eventKind === 'chargeback_settled'
      && collected === 0 && refunds === 0 && chargebacks > 0 && recovered === 0)
    || (event.eventKind === 'chargeback_reversed'
      && collected === 0 && refunds === 0 && chargebacks === 0 && recovered > 0)
    || (event.eventKind === 'fee_adjustment'
      && collected === 0 && refunds === 0 && chargebacks === 0 && recovered === 0 && fees !== 0)
  if (!validShape) throw new Error(`Settlement event component shape contradicts ${event.eventKind}.`)
}

function unavailable(blockerCodes: string[], diagnostics: SettlementWindowSummary['diagnostics']): SettlementWindowSummary {
  return {
    businessMoney: { status: 'unavailable', totals: null },
    outcomeLinkage: { status: 'unavailable', totals: null, outcomeCount: null },
    blockerCodes: [...new Set(blockerCodes)].sort(),
    diagnostics,
  }
}

/**
 * Reconcile one exact, half-open processor window. This produces settled-money inputs and checks
 * appointment linkage only. Paid attribution is a separate immutable touch join, and neither view
 * claims incrementality or grants action authority.
 */
export function summarizeSettlementWindow(input: {
  coverage: SettlementSourceCoverage
  requestedWindow: { start: string; end: string }
  asOf: string
  events: ProcessorSettlementEvent[]
}): SettlementWindowSummary {
  if (input.events.length > MAX_EVENTS) {
    throw new Error(`Settlement window exceeds ${MAX_EVENTS} events.`)
  }
  const requestedStart = time(input.requestedWindow.start, 'requested start')
  const requestedEnd = time(input.requestedWindow.end, 'requested end')
  const coverageStart = time(input.coverage.windowStart, 'coverage start')
  const coverageEnd = time(input.coverage.windowEnd, 'coverage end')
  const asOf = time(input.asOf, 'as-of')
  if (requestedEnd <= requestedStart || coverageEnd <= coverageStart) {
    throw new Error('Settlement windows must be non-empty and ordered.')
  }
  if (asOf < requestedEnd) {
    throw new Error('Settlement as-of cut cannot precede the requested window end.')
  }
  if (input.coverage.complete && input.coverage.blockerCodes.length > 0) {
    throw new Error('Complete settlement coverage cannot carry blocker codes.')
  }

  const ids = new Set<string>()
  const providerIds = new Set<string>()
  for (const event of input.events) {
    validateEvent(event)
    if (ids.has(event.id) || providerIds.has(event.processorEventId)) {
      throw new Error(`Duplicate processor event identity: ${event.processorEventId}.`)
    }
    ids.add(event.id)
    providerIds.add(event.processorEventId)
  }

  const inWindow = input.events.filter((event) => {
    const occurred = time(event.occurredAt, 'settlement occurred_at')
    return occurred >= requestedStart && occurred < requestedEnd
  })
  const unavailableAsOf = inWindow.filter((event) => time(event.availableAt, 'settlement available_at') > asOf)
  const unlinked = inWindow.filter((event) => event.outcomeId === null)
  const diagnostics = {
    sourceEventCount: input.events.length,
    inWindowEventCount: inWindow.length,
    ignoredOutsideWindow: input.events.length - inWindow.length,
    unlinkedEventCount: unlinked.length,
  }
  const sourceBlockers = [
    ...input.coverage.blockerCodes,
    ...(!input.coverage.complete ? ['processor_source_incomplete'] : []),
    ...(coverageStart > requestedStart || coverageEnd < requestedEnd ? ['source_window_not_covered'] : []),
    ...(unavailableAsOf.length > 0 ? ['event_not_available_as_of'] : []),
  ]
  if (sourceBlockers.length > 0) return unavailable(sourceBlockers, diagnostics)

  const raw = inWindow.reduce((totals, event) => ({
    collected: totals.collected + event.collectedExTaxMinor,
    refunds: totals.refunds + event.refundsExTaxMinor,
    chargebacks: totals.chargebacks + event.chargebacksExTaxMinor,
    recovered: totals.recovered + event.recoveredChargebacksExTaxMinor,
    fees: totals.fees + event.paymentFeesMinor,
    tax: totals.tax + event.taxAmountMinor,
  }), { collected: 0, refunds: 0, chargebacks: 0, recovered: 0, fees: 0, tax: 0 })
  const refundsAndChargebacks = raw.refunds + raw.chargebacks - raw.recovered
  const totals: SettlementMoneyTotals = {
    collectedRevenueExTaxMinor: raw.collected,
    refundsAndChargebacksMinor: refundsAndChargebacks,
    paymentProcessingFeesMinor: raw.fees,
    netCollectedBeforeVariableCostsAndAdsMinor: raw.collected - refundsAndChargebacks - raw.fees,
    excludedTaxMinor: raw.tax,
    eventCount: inWindow.length,
  }
  const outcomeCount = new Set(inWindow.flatMap((event) => (
    event.outcomeId === null ? [] : [event.outcomeId]
  ))).size
  const blockerCodes = unlinked.length > 0 ? ['outcome_linkage_incomplete'] : []
  return {
    businessMoney: { status: 'available', ...totals },
    outcomeLinkage: unlinked.length > 0
      ? { status: 'unavailable', totals: null, outcomeCount: null }
      : { status: 'available', totals, outcomeCount },
    blockerCodes,
    diagnostics,
  }
}
