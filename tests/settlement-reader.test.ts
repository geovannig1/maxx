import { describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  normalizeSettlementRows,
  readProcessorSettlementWindow,
  selectSettlementCoverageForSource,
} from '@/lib/economics/settlement-reader'


const batch = (over: Record<string, unknown> = {}) => ({
  id: '00000000-0000-4000-8000-000000000001',
  processor: 'unknown_processor',
  processor_account_ref: 'merchant_1',
  window_start: '2026-08-01T00:00:00Z',
  window_end: '2026-08-03T00:00:00Z',
  complete: true,
  blocker_codes: [],
  imported_at: '2026-08-03T01:00:00Z',
  import_sequence: '1',
  ...over,
})

// Events carry the outcome uuid; the reader resolves it to the Acuity appointment id (101).
const OUTCOME_101 = '00000000-0000-4000-8000-000000000101'

describe('settlement source selection', () => {
  const source = { processor: 'unknown_processor', processorAccountRef: 'merchant_1' }

  it('selects the newest complete manifest for the explicitly governed processor account', () => {
    const selected = selectSettlementCoverageForSource([
      batch({ id: '00000000-0000-4000-8000-000000000002', imported_at: '2026-08-03T02:00:00Z' }),
      batch(),
    ], source, '2026-08-04T00:00:00Z')
    expect(selected).toMatchObject({
      status: 'selected',
      processor: 'unknown_processor',
      processorAccountRef: 'merchant_1',
      batchId: '00000000-0000-4000-8000-000000000002',
      importSequence: 1,
    })
  })

  it('uses exact-count paging so a server row cap cannot understate money', async () => {
    const rows = Array.from({ length: 1_500 }, (_, index) => ({
      id: `00000000-0000-4000-8000-${(index + 1).toString().padStart(12, '0')}`,
      processor_event_id: `evt_${index + 1}`,
      processor_transaction_id: `txn_${index + 1}`,
      event_kind: 'payment_settled',
      occurred_at: '2026-08-01T12:00:00Z',
      available_at: '2026-08-01T13:00:00Z',
      currency: 'USD', outcome_id: OUTCOME_101,
      collected_ex_tax_minor: '1', refunds_ex_tax_minor: '0',
      chargebacks_ex_tax_minor: '0', recovered_chargebacks_ex_tax_minor: '0',
      payment_fees_minor: '0', tax_amount_minor: '0',
    }))
    const ranges: Array<[number, number]> = []
    const client = {
      from(table: string) {
        const state = { head: false, range: [0, 999] as [number, number] }
        const builder = {
          select(_columns: string, options?: { head?: boolean }) {
            state.head = options?.head === true
            return this
          },
          eq() { return this }, gte() { return this }, lte() { return this }, lt() { return this },
          in() { return this }, order() { return this }, limit() { return this },
          range(from: number, to: number) {
            state.range = [from, to]
            ranges.push(state.range)
            return this
          },
          then(resolve: (result: { data: unknown; error: null; count?: number }) => void) {
            if (table === 'processor_settlement_batches') {
              resolve({ data: [batch()], error: null })
            } else if (table === 'outcomes') {
              resolve({ data: [{ id: OUTCOME_101, external_id: '101' }], error: null })
            } else if (state.head) {
              resolve({ data: null, error: null, count: rows.length })
            } else {
              resolve({ data: rows.slice(state.range[0], state.range[1] + 1), error: null })
            }
          },
        }
        return builder
      },
    } as unknown as SupabaseClient

    const result = await readProcessorSettlementWindow(
      client,
      '00000000-0000-4000-8000-000000000074',
      { start: '2026-08-01T00:00:00Z', end: '2026-08-03T00:00:00Z' },
      '2026-08-04T00:00:00Z',
      source,
    )
    expect(ranges).toEqual([[0, 999], [1000, 1499]])
    expect(result.summary.businessMoney).toMatchObject({
      status: 'available', collectedRevenueExTaxMinor: 1_500, eventCount: 1_500,
    })
    expect(result.events).toHaveLength(1_500)
  })

  it('fails closed with no coverage and rejects rows from an unrequested merchant source', () => {
    expect(selectSettlementCoverageForSource([], source, '2026-08-04T00:00:00Z')).toEqual({
      status: 'unavailable', blockerCode: 'processor_source_missing',
    })
    expect(() => selectSettlementCoverageForSource([
      batch({ processor_account_ref: 'merchant_2' }),
    ], source, '2026-08-04T00:00:00Z')).toThrow(/unexpected processor source/i)
    expect(() => selectSettlementCoverageForSource([
      batch({ imported_at: '2026-08-05T00:00:00Z' }),
    ], source, '2026-08-04T00:00:00Z')).toThrow(/after the as-of cut/i)
  })

  it('selects a newer blocked cut instead of falling back to stale complete money', () => {
    expect(selectSettlementCoverageForSource([
      batch(),
      batch({
        id: '00000000-0000-4000-8000-000000000002',
        import_sequence: '2',
        imported_at: '2026-08-03T02:00:00Z',
        complete: false,
        blocker_codes: ['source_page_failed'],
      }),
    ], source, '2026-08-04T00:00:00Z')).toMatchObject({
      status: 'selected', complete: false, blockerCodes: ['source_page_failed'],
      batchId: '00000000-0000-4000-8000-000000000002',
    })
  })

  it('returns the newest blocked cut as unavailable without reading stale events', async () => {
    const equalityFields: string[] = []
    const client = {
      from(table: string) {
        if (table !== 'processor_settlement_batches') {
          throw new Error(`unexpected stale event read from ${table}`)
        }
        return {
          select() { return this },
          eq(field: string) { equalityFields.push(field); return this },
          gte() { return this }, lte() { return this }, order() { return this }, limit() { return this },
          then(resolve: (result: { data: unknown; error: null }) => void) {
            resolve({ data: [batch({
              complete: false, blocker_codes: ['source_page_failed'], import_sequence: '2',
            })], error: null })
          },
        }
      },
    } as unknown as SupabaseClient

    const result = await readProcessorSettlementWindow(
      client,
      '00000000-0000-4000-8000-000000000074',
      { start: '2026-08-01T00:00:00Z', end: '2026-08-03T00:00:00Z' },
      '2026-08-04T00:00:00Z',
      source,
    )
    expect(equalityFields).not.toContain('complete')
    expect(result.summary.businessMoney.status).toBe('unavailable')
    expect(result.summary.blockerCodes).toContain('source_page_failed')
    expect(result.events).toEqual([])
  })

  it('normalizes database numerics without accepting null, NaN, or wrong currency', () => {
    const rows = normalizeSettlementRows([{
      id: '00000000-0000-4000-8000-000000000010',
      processor_event_id: 'evt_10', processor_transaction_id: 'txn_10',
      event_kind: 'payment_settled', occurred_at: '2026-08-01T12:00:00Z',
      available_at: '2026-08-01T13:00:00Z', currency: 'USD', outcome_id: OUTCOME_101,
      collected_ex_tax_minor: '20050', refunds_ex_tax_minor: '0', chargebacks_ex_tax_minor: '0',
      recovered_chargebacks_ex_tax_minor: '0', payment_fees_minor: '625', tax_amount_minor: '1400',
    }])
    expect(rows[0]).toMatchObject({ collectedExTaxMinor: 20_050, paymentFeesMinor: 625 })
    // the identity is the outcome uuid itself, for an outcome of any source.
    expect(rows[0].outcomeId).toBe(OUTCOME_101)
    expect(() => normalizeSettlementRows([{
      id: '00000000-0000-4000-8000-000000000010',
      processor_event_id: 'evt_10', processor_transaction_id: 'txn_10',
      event_kind: 'payment_settled', occurred_at: '2026-08-01T12:00:00Z',
      available_at: '2026-08-01T13:00:00Z', currency: 'USD', outcome_id: OUTCOME_101,
      collected_ex_tax_minor: '1', refunds_ex_tax_minor: '0', chargebacks_ex_tax_minor: '0',
      recovered_chargebacks_ex_tax_minor: '0', payment_fees_minor: '0', tax_amount_minor: '0',
    }].map((row) => ({ ...row, outcome_id: 'not-an-outcome-uuid' })))).toThrow(/malformed processor settlement row/i)
    expect(() => normalizeSettlementRows([{ ...rows[0], collected_ex_tax_minor: null }]))
      .toThrow(/malformed processor settlement row/i)
    expect(() => normalizeSettlementRows([{ ...rows[0], currency: 'EUR' }]))
      .toThrow(/malformed processor settlement row/i)
    expect(() => normalizeSettlementRows([{ ...rows[0], collected_ex_tax_minor: '1.5' }]))
      .toThrow(/malformed processor settlement row/i)
  })
})
