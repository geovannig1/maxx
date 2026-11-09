import { describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  normalizeVariableCostRows,
  readVariableCostWindow,
  selectVariableCostCoverage,
} from '@/lib/economics/variable-cost-reader'


const POLICY = '00000000-0000-4000-8000-000000000075'
const batch = (over: Record<string, unknown> = {}) => ({
  id: '00000000-0000-4000-8000-000000000176',
  economics_policy_id: POLICY,
  cost_source: 'owner_actual_cost_export',
  window_start: '2026-08-01T00:00:00Z',
  window_end: '2026-08-03T00:00:00Z',
  complete: true,
  blocker_codes: [],
  import_sequence: '1',
  imported_at: '2026-08-03T01:00:00Z',
  ...over,
})

// Events carry the outcome uuid; the reader resolves it to the Acuity appointment id (101).
const OUTCOME_101 = '00000000-0000-4000-8000-000000000101'

describe('variable-cost source reader', () => {
  it('selects the newest covering cut only for the exact policy and source', () => {
    expect(selectVariableCostCoverage([
      batch(), batch({
        id: '00000000-0000-4000-8000-000000000276', import_sequence: '2',
      }),
    ], POLICY, 'owner_actual_cost_export', '2026-08-04T00:00:00Z')).toMatchObject({
      status: 'selected', batchId: '00000000-0000-4000-8000-000000000276',
      importSequence: 2, complete: true,
    })
    expect(selectVariableCostCoverage([], POLICY, 'owner_actual_cost_export', '2026-08-04T00:00:00Z'))
      .toEqual({ status: 'missing' })
    expect(() => selectVariableCostCoverage([
      batch({ cost_source: 'other_source' }),
    ], POLICY, 'owner_actual_cost_export', '2026-08-04T00:00:00Z'))
      .toThrow(/unexpected policy or source/i)
    expect(() => selectVariableCostCoverage([
      batch({ imported_at: '2026-08-05T00:00:00Z' }),
    ], POLICY, 'owner_actual_cost_export', '2026-08-04T00:00:00Z'))
      .toThrow(/after the as-of cut/i)
  })

  it('normalizes exact integer cost rows and rejects malformed authority', () => {
    const rows = normalizeVariableCostRows([{
      id: '00000000-0000-4000-8000-000000000001',
      cost_source: 'owner_actual_cost_export', source_event_id: 'cost_evt_1',
      event_kind: 'cost_incurred', reverses_source_event_id: null,
      occurred_at: '2026-08-01T12:00:00Z', available_at: '2026-08-01T13:00:00Z',
      currency: 'USD', outcome_id: OUTCOME_101, category: 'consumables', amount_minor: '2500',
    }])
    expect(rows[0]).toMatchObject({ amountMinor: 2_500, category: 'consumables' })
    // the identity is the outcome uuid itself, for an outcome of any source.
    expect(rows[0].outcomeId).toBe(OUTCOME_101)
    expect(() => normalizeVariableCostRows([{
      id: '00000000-0000-4000-8000-000000000001',
      cost_source: 'owner_actual_cost_export', source_event_id: 'cost_evt_1',
      event_kind: 'cost_incurred', reverses_source_event_id: null,
      occurred_at: '2026-08-01T12:00:00Z', available_at: '2026-08-01T13:00:00Z',
      currency: 'USD', outcome_id: 'not-an-outcome-uuid', category: 'consumables', amount_minor: '2500',
    }])).toThrow(/malformed variable-cost row/i)
    expect(() => normalizeVariableCostRows([{ ...rows[0], amount_minor: '1.5' }]))
      .toThrow(/malformed variable-cost row/i)
  })

  it('uses exact-count paging so source caps cannot turn missing costs into zero', async () => {
    const rows = Array.from({ length: 1_500 }, (_, index) => ({
      id: `00000000-0000-4000-8000-${(index + 1).toString().padStart(12, '0')}`,
      cost_source: 'owner_actual_cost_export', source_event_id: `cost_evt_${index + 1}`,
      event_kind: 'cost_incurred', reverses_source_event_id: null,
      occurred_at: '2026-08-01T12:00:00Z', available_at: '2026-08-01T13:00:00Z',
      currency: 'USD', outcome_id: OUTCOME_101, category: 'consumables', amount_minor: '1',
    }))
    const ranges: Array<[number, number]> = []
    const client = {
      from(table: string) {
        const state = { head: false, range: [0, 999] as [number, number] }
        return {
          select(_columns: string, options?: { head?: boolean }) {
            state.head = options?.head === true; return this
          },
          eq() { return this }, lte() { return this }, gte() { return this }, lt() { return this },
          in() { return this }, order() { return this }, limit() { return this },
          range(from: number, to: number) { state.range = [from, to]; ranges.push(state.range); return this },
          then(resolve: (result: { data: unknown; error: null; count?: number }) => void) {
            if (table === 'variable_cost_batches') resolve({ data: [batch()], error: null })
            else if (table === 'outcomes') resolve({ data: [{ id: OUTCOME_101, external_id: '101' }], error: null })
            else if (state.head) resolve({ data: null, error: null, count: rows.length })
            else resolve({ data: rows.slice(state.range[0], state.range[1] + 1), error: null })
          },
        }
      },
    } as unknown as SupabaseClient

    const result = await readVariableCostWindow(client, '00000000-0000-4000-8000-000000000076', {
      policyId: POLICY,
      requiredCostSources: ['owner_actual_cost_export'],
      allowedVariableCostCategories: ['consumables'],
      variableCostCategorySources: { consumables: 'owner_actual_cost_export' },
    }, {
      start: '2026-08-01T00:00:00Z', end: '2026-08-03T00:00:00Z',
    }, '2026-08-04T00:00:00Z')
    expect(ranges).toEqual([[0, 999], [1000, 1499]])
    expect(result.summary).toMatchObject({
      status: 'available', totalVariableCostsMinor: 1_500, eventCount: 1_500,
    })
    expect(result.events).toHaveLength(1_500)
  })
})
