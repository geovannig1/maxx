import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { getBusinessFactsForWindow } from '@/lib/outcomes/business-facts-reader'

// Regression guard for the silent-truncation bug (a ledger just over 1,000 rows read short): supabase caps
// unpaged selects at 1000 rows, so the ledger accessors MUST page via .range() until a short page.
// A fake client serves 1000 + 500 rows across two range windows; an unpaged read would see only 1000.

function fakeSupabase(totalRows: number) {
  const rows = Array.from({ length: totalRows }, (_, i) => ({
    id: `00000000-0000-4000-8000-${(i + 1).toString().padStart(12, '0')}`, external_id: String(i + 1),
    gross_value: 10, collected_value: 10, status: 'confirmed', business_state: 'active_value_bearing' as const,
    business_date: '2026-07-01', outcome_label: 't', currency: 'USD', source_id: 's1', source_kind: 'acuity',
  }))
  const calls: Array<{ from: number; to: number }> = []
  const builder = {
    _range: { from: 0, to: 999 },
    select() { return this },
    eq() { return this },
    gte() { return this },
    lte() { return this },
    order() { return this },
    range(from: number, to: number) { this._range = { from, to }; calls.push({ from, to }); return this },
    then(resolve: (v: { data: unknown[]; error: null }) => void) {
      const { from, to } = this._range
      resolve({ data: rows.slice(from, to + 1), error: null })
    },
  }
  const healthBuilder = {
    select() { return this },
    eq() { return this },
    maybeSingle() {
      return Promise.resolve({
        data: {
          value: JSON.stringify({
            last_reconciled_at: new Date().toISOString(),
            window_start_date: '2025-01-01',
            window_end_date: '2027-12-31',
            window_basis: 'booking_date_et',
            truncated: false,
          }),
        },
        error: null,
      })
    },
  }
  // the read gates each enabled outcome source first; this account has one Acuity source.
  const sourcesBuilder = {
    select() { return this },
    eq() { return this },
    order() { return Promise.resolve({ data: [{ id: 's1', kind: 'acuity' }], error: null }) },
  }
  const client = {
    from: (table: string) => table === 'app_settings' ? { ...healthBuilder }
      : table === 'outcome_sources' ? { ...sourcesBuilder } : { ...builder },
  } as unknown as SupabaseClient
  return { client, calls }
}

describe('acuity metrics paging', () => {
  it('pages past the 1000-row cap and counts every row exactly', async () => {
    const { client, calls } = fakeSupabase(1500)
    const m = await getBusinessFactsForWindow('acct-1', '2026-01-01', '2026-12-31', client)
    expect(m.valueBearingBookings).toBe(1500)          // an unpaged read would report 1000
    expect(m.bookedValue).toBe(15000)
    expect(calls.length).toBe(2)           // 1000 + 500 (short page ends the loop)
  })

  it('a single short page makes exactly one request', async () => {
    const { client, calls } = fakeSupabase(42)
    const m = await getBusinessFactsForWindow('acct-1', '2026-01-01', '2026-12-31', client)
    expect(m.valueBearingBookings).toBe(42)
    expect(calls.length).toBe(1)
  })
})
