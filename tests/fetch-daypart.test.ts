import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { DaypartInsightRow } from '@/lib/platforms/meta/fetch-daypart'

// N3 — upsertDaypartInsights must refresh the rolling daypart snapshot WITHOUT ever wiping it:
//   1. an empty fetch (Meta failed / returned nothing) leaves the table untouched
//   2. the new window is written BEFORE the prior window is deleted
//   3. a failed write deletes nothing, so the last good snapshot survives
// We stub the Supabase admin client with a chainable builder that records every operation, so we can
// assert both which calls were made and their ORDER. Import is dynamic after doMock (writeguard pattern).

type Call = [string, ...unknown[]]

function makeAdmin(opts: { upsertResult: unknown; deleteResult: unknown }) {
  const calls: Call[] = []
  const builder = {
    from(table: string) { calls.push(['from', table]); return builder },
    upsert(rows: unknown, options: unknown) { calls.push(['upsert', rows, options]); return builder },
    delete() { calls.push(['delete']); return builder },
    eq(col: string, val: unknown) { calls.push(['eq', col, val]); return builder },
    neq(col: string, val: unknown) { calls.push(['neq', col, val]); return Promise.resolve(opts.deleteResult) },
    select(cols: string) { calls.push(['select', cols]); return Promise.resolve(opts.upsertResult) },
  }
  return { client: { from: builder.from }, calls }
}

async function loadUpsert(opts: { upsertResult: unknown; deleteResult: unknown }) {
  const { client, calls } = makeAdmin(opts)
  const getAdminClient = vi.fn(() => client)
  vi.doMock('@/lib/supabase/admin', () => ({ getAdminClient }))
  const mod = await import('@/lib/platforms/meta/fetch-daypart')
  return { upsertDaypartInsights: mod.upsertDaypartInsights, calls, getAdminClient }
}

const SINCE = '2026-06-03'
const UNTIL = '2026-07-02'
const sampleRow: DaypartInsightRow = {
  hour_of_day: 9, day_of_week: 2, spend: 100, impressions: 1000, clicks: 20, bookings: 4, cpa: 25,
}

describe('upsertDaypartInsights — non-destructive refresh', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.restoreAllMocks()
    vi.doUnmock('@/lib/supabase/admin')
  })

  it('empty fetch preserves the snapshot: no client acquired, nothing written or deleted, returns 0', async () => {
    const { upsertDaypartInsights, calls, getAdminClient } = await loadUpsert({
      upsertResult: { data: [], error: null }, deleteResult: { error: null },
    })
    const n = await upsertDaypartInsights('acct-1', SINCE, UNTIL, [])
    expect(n).toBe(0)
    expect(getAdminClient).not.toHaveBeenCalled()
    expect(calls).toHaveLength(0)
  })

  it('successful write inserts the new window BEFORE deleting prior ranges', async () => {
    const { upsertDaypartInsights, calls } = await loadUpsert({
      upsertResult: { data: [{ id: 'x' }], error: null }, deleteResult: { error: null },
    })
    const n = await upsertDaypartInsights('acct-1', SINCE, UNTIL, [sampleRow])
    expect(n).toBe(1)

    const upsertIdx = calls.findIndex((c) => c[0] === 'upsert')
    const deleteIdx = calls.findIndex((c) => c[0] === 'delete')
    expect(upsertIdx).toBeGreaterThanOrEqual(0)
    expect(deleteIdx).toBeGreaterThan(upsertIdx) // new snapshot written first, old removed after

    // New rows carry the fresh range (tagged for the read side) and the metric columns.
    const upsertCall = calls.find((c) => c[0] === 'upsert') as Call
    const payload = upsertCall[1] as Array<Record<string, unknown>>
    expect(payload[0]).toMatchObject({ date_range_start: SINCE, date_range_end: UNTIL, hour_of_day: 9 })

    // Cleanup targets only PRIOR ranges for this account (date_range_start <> since).
    expect(calls).toContainEqual(['eq', 'ad_account_id', 'acct-1'])
    expect(calls).toContainEqual(['neq', 'date_range_start', SINCE])
  })

  it('write error leaves prior data intact: no delete issued, returns 0', async () => {
    const { upsertDaypartInsights, calls } = await loadUpsert({
      upsertResult: { data: null, error: { message: 'insert boom' } }, deleteResult: { error: null },
    })
    const n = await upsertDaypartInsights('acct-1', SINCE, UNTIL, [sampleRow])
    expect(n).toBe(0)
    expect(calls.some((c) => c[0] === 'upsert')).toBe(true)  // write was attempted
    expect(calls.some((c) => c[0] === 'delete')).toBe(false) // but nothing was deleted
  })
})
