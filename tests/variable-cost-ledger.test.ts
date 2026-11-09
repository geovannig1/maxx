import { describe, expect, it } from 'vitest'
import {
  summarizeVariableCostWindow,
  type VariableCostEvent,
} from '@/lib/economics/variable-cost-ledger'

/** Outcome uuid fixture for a numeric case id (economics identity is the outcome uuid). */
const oid = (n: number): string => `00000000-0000-4000-a000-${String(n).padStart(12, '0')}`

const requiredSources = ['owner_actual_cost_export', 'payroll_actual_export']
const allowedCategories = ['consumables', 'provider_commission']
const categorySources = {
  consumables: 'owner_actual_cost_export',
  provider_commission: 'payroll_actual_export',
}
const coverage = requiredSources.map((costSource) => ({
  costSource,
  complete: true,
  windowStart: '2026-08-01T00:00:00Z',
  windowEnd: '2026-08-03T00:00:00Z',
  blockerCodes: [] as string[],
}))
const event = (over: Partial<VariableCostEvent> = {}): VariableCostEvent => ({
  id: '00000000-0000-4000-8000-000000000001',
  costSource: 'owner_actual_cost_export',
  sourceEventId: 'cost_evt_1',
  eventKind: 'cost_incurred',
  reversesSourceEventId: null,
  occurredAt: '2026-08-01T12:00:00Z',
  availableAt: '2026-08-01T13:00:00Z',
  currency: 'USD', outcomeId: oid(101), category: 'consumables', amountMinor: 2_500,
  ...over,
})

const summarize = (over: Record<string, unknown> = {}) => summarizeVariableCostWindow({
  requiredSources,
  allowedCategories,
  categorySources,
  coverage,
  requestedWindow: { start: '2026-08-01T00:00:00Z', end: '2026-08-03T00:00:00Z' },
  asOf: '2026-08-04T00:00:00Z',
  events: [
    event(),
    event({
      id: '00000000-0000-4000-8000-000000000002',
      costSource: 'payroll_actual_export', sourceEventId: 'cost_evt_2',
      category: 'provider_commission', amountMinor: 10_000,
    }),
  ],
  ...over,
})

describe('actual variable-cost window summarization', () => {
  it('reconciles actual incurred costs and reversals in exact minor units', () => {
    const result = summarize({ events: [
      event(),
      event({
        id: '00000000-0000-4000-8000-000000000002',
        costSource: 'payroll_actual_export', sourceEventId: 'cost_evt_2',
        category: 'provider_commission', amountMinor: 10_000,
      }),
      event({
        id: '00000000-0000-4000-8000-000000000003', sourceEventId: 'cost_evt_3',
        eventKind: 'cost_reversed', reversesSourceEventId: 'cost_evt_1', amountMinor: 500,
      }),
    ] })
    expect(result).toMatchObject({
      status: 'available', incurredVariableCostsMinor: 12_500,
      reversedVariableCostsMinor: 500, totalVariableCostsMinor: 12_000,
      outcomeCount: 1, eventCount: 3,
      byCategoryMinor: { consumables: 2_000, provider_commission: 10_000 },
    })
  })

  it('treats an empty window as zero only when every required source is complete', () => {
    expect(summarize({ events: [] })).toMatchObject({
      status: 'available', totalVariableCostsMinor: 0, eventCount: 0,
    })
    const incomplete = summarize({
      events: [],
      coverage: coverage.filter((row) => row.costSource !== 'payroll_actual_export'),
    })
    expect(incomplete).toEqual(expect.objectContaining({ status: 'unavailable' }))
    expect(incomplete.blockerCodes).toContain('variable_cost_source_missing:payroll_actual_export')
  })

  it('fails closed on a blocked source, a coverage gap, or future-available event', () => {
    const blocked = summarize({
      coverage: coverage.map((row) => row.costSource === 'payroll_actual_export'
        ? { ...row, complete: false, blockerCodes: ['source_export_failed'] }
        : row),
    })
    expect(blocked.status).toBe('unavailable')
    expect(blocked.blockerCodes).toContain('source_export_failed')

    const gap = summarize({
      coverage: coverage.map((row) => row.costSource === 'payroll_actual_export'
        ? { ...row, windowStart: '2026-08-02T00:00:00Z' }
        : row),
    })
    expect(gap.blockerCodes).toContain('variable_cost_window_not_covered:payroll_actual_export')

    const future = summarize({ events: [event({ availableAt: '2026-08-05T00:00:00Z' })] })
    expect(future.blockerCodes).toContain('variable_cost_event_not_available_as_of')

    expect(() => summarize({ asOf: '2026-08-02T00:00:00Z' }))
      .toThrow(/as-of.*window end/i)
  })

  it('rejects unapproved sources/categories, duplicates, and non-integer money', () => {
    expect(() => summarize({ events: [event({ costSource: 'unknown_source' })] }))
      .toThrow(/not required/i)
    expect(() => summarize({ events: [event({ category: 'rent' })] }))
      .toThrow(/not allowed/i)
    expect(() => summarize({ events: [event({
      costSource: 'payroll_actual_export', category: 'consumables',
    })] })).toThrow(/authoritative source/i)
    expect(() => summarize({ events: [event(), event()] }))
      .toThrow(/duplicate variable-cost event/i)
    expect(() => summarize({ events: [event({ amountMinor: 2_500.5 })] }))
      .toThrow(/integer minor units/i)
  })

  it('ignores events outside the exact half-open requested window', () => {
    const result = summarize({ events: [
      event(),
      event({
        id: '00000000-0000-4000-8000-000000000002', sourceEventId: 'cost_evt_2',
        occurredAt: '2026-08-03T00:00:00Z', availableAt: '2026-08-03T00:00:00Z',
      }),
    ] })
    expect(result).toMatchObject({ status: 'available', totalVariableCostsMinor: 2_500 })
    expect(result.diagnostics.ignoredOutsideWindow).toBe(1)
  })
})
