import { describe, expect, it } from 'vitest'
import {
  summarizeSettlementWindow,
  type ProcessorSettlementEvent,
} from '@/lib/economics/settlement-ledger'

/** Outcome uuid fixture for a numeric case id (economics identity is the outcome uuid). */
const oid = (n: number): string => `00000000-0000-4000-a000-${String(n).padStart(12, '0')}`

const base = (over: Partial<ProcessorSettlementEvent> = {}): ProcessorSettlementEvent => ({
  id: '00000000-0000-4000-8000-000000000001',
  processorEventId: 'evt_1',
  processorTransactionId: 'txn_1',
  eventKind: 'payment_settled',
  occurredAt: '2026-08-01T12:00:00Z',
  availableAt: '2026-08-01T13:00:00Z',
  currency: 'USD',
  outcomeId: oid(101),
  collectedExTaxMinor: 20_000,
  refundsExTaxMinor: 0,
  chargebacksExTaxMinor: 0,
  recoveredChargebacksExTaxMinor: 0,
  paymentFeesMinor: 600,
  taxAmountMinor: 1_400,
  ...over,
})

const coverage = {
  complete: true,
  windowStart: '2026-08-01T00:00:00Z',
  windowEnd: '2026-08-03T00:00:00Z',
  blockerCodes: [] as string[],
}

describe('processor settlement window summarization', () => {
  it('reconciles atomic collected-money components without using booked value', () => {
    const result = summarizeSettlementWindow({
      coverage,
      requestedWindow: { start: '2026-08-01T00:00:00Z', end: '2026-08-03T00:00:00Z' },
      asOf: '2026-08-04T00:00:00Z',
      events: [
        base(),
        base({
          id: '00000000-0000-4000-8000-000000000002', processorEventId: 'evt_2',
          eventKind: 'refund_settled', collectedExTaxMinor: 0,
          refundsExTaxMinor: 5_000, paymentFeesMinor: 100,
        }),
        base({
          id: '00000000-0000-4000-8000-000000000003', processorEventId: 'evt_3',
          eventKind: 'chargeback_settled', collectedExTaxMinor: 0,
          chargebacksExTaxMinor: 2_500, paymentFeesMinor: 1_500,
        }),
        base({
          id: '00000000-0000-4000-8000-000000000004', processorEventId: 'evt_4',
          eventKind: 'chargeback_reversed', collectedExTaxMinor: 0,
          recoveredChargebacksExTaxMinor: 1_000, paymentFeesMinor: -500,
        }),
      ],
    })

    expect(result.businessMoney).toMatchObject({
      status: 'available',
      collectedRevenueExTaxMinor: 20_000,
      refundsAndChargebacksMinor: 6_500,
      paymentProcessingFeesMinor: 1_700,
      netCollectedBeforeVariableCostsAndAdsMinor: 11_800,
      excludedTaxMinor: 5_600,
      eventCount: 4,
    })
    expect(result.outcomeLinkage).toMatchObject({ status: 'available', outcomeCount: 1 })
    expect(JSON.stringify(result)).not.toMatch(/booked.value|amount_paid|roas/i)
  })

  it('fails appointment linkage closed when any money component lacks appointment identity', () => {
    const result = summarizeSettlementWindow({
      coverage,
      requestedWindow: { start: coverage.windowStart, end: coverage.windowEnd },
      asOf: '2026-08-04T00:00:00Z',
      events: [base({ outcomeId: null })],
    })
    expect(result.businessMoney.status).toBe('available')
    expect(result.outcomeLinkage).toMatchObject({ status: 'unavailable', totals: null })
    expect(result.blockerCodes).toContain('outcome_linkage_incomplete')
  })

  it('fails all money views closed when source coverage is incomplete or does not cover the request', () => {
    const incomplete = summarizeSettlementWindow({
      coverage: { ...coverage, complete: false, blockerCodes: ['source_page_failed'] },
      requestedWindow: { start: coverage.windowStart, end: coverage.windowEnd },
      asOf: '2026-08-04T00:00:00Z', events: [],
    })
    expect(incomplete.businessMoney.status).toBe('unavailable')
    expect(incomplete.blockerCodes).toContain('source_page_failed')

    const gap = summarizeSettlementWindow({
      coverage,
      requestedWindow: { start: '2026-07-31T00:00:00Z', end: coverage.windowEnd },
      asOf: '2026-08-04T00:00:00Z', events: [],
    })
    expect(gap.businessMoney.status).toBe('unavailable')
    expect(gap.blockerCodes).toContain('source_window_not_covered')
  })

  it('rejects duplicate events and contradictory normalized components', () => {
    expect(() => summarizeSettlementWindow({
      coverage,
      requestedWindow: { start: coverage.windowStart, end: coverage.windowEnd },
      asOf: '2026-08-04T00:00:00Z', events: [base(), base()],
    })).toThrow(/duplicate processor event/i)
    expect(() => summarizeSettlementWindow({
      coverage,
      requestedWindow: { start: coverage.windowStart, end: coverage.windowEnd },
      asOf: '2026-08-04T00:00:00Z', events: [base({ refundsExTaxMinor: 1_000 })],
    })).toThrow(/component shape/i)
  })

  it('rejects fractional or unsafe minor-unit values instead of rounding money', () => {
    expect(() => summarizeSettlementWindow({
      coverage,
      requestedWindow: { start: coverage.windowStart, end: coverage.windowEnd },
      asOf: '2026-08-04T00:00:00Z', events: [base({ collectedExTaxMinor: 20_000.5 })],
    })).toThrow(/integer minor units/i)
    expect(() => summarizeSettlementWindow({
      coverage,
      requestedWindow: { start: coverage.windowStart, end: coverage.windowEnd },
      asOf: '2026-08-04T00:00:00Z',
      events: [base({ collectedExTaxMinor: Number.MAX_SAFE_INTEGER })],
    })).toThrow(/settlement collected_ex_tax_minor/i)
  })

  it('does not count events outside the exact half-open request or available after the as-of time', () => {
    const result = summarizeSettlementWindow({
      coverage,
      requestedWindow: { start: coverage.windowStart, end: coverage.windowEnd },
      asOf: '2026-08-04T00:00:00Z',
      events: [
        base(),
        base({
          id: '00000000-0000-4000-8000-000000000002', processorEventId: 'evt_2',
          occurredAt: coverage.windowEnd,
          availableAt: coverage.windowEnd,
        }),
        base({
          id: '00000000-0000-4000-8000-000000000003', processorEventId: 'evt_3',
          availableAt: '2026-08-05T00:00:00Z',
        }),
      ],
    })
    expect(result.businessMoney.status).toBe('unavailable')
    expect(result.blockerCodes).toContain('event_not_available_as_of')
    expect(result.diagnostics.ignoredOutsideWindow).toBe(1)

    expect(() => summarizeSettlementWindow({
      coverage,
      requestedWindow: { start: coverage.windowStart, end: coverage.windowEnd },
      asOf: '2026-08-02T00:00:00Z',
      events: [],
    })).toThrow(/as-of.*window end/i)
  })
})
