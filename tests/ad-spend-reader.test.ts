import { describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  readAccountSpendWindow,
  summarizeAccountSpendWindow,
} from '@/lib/economics/ad-spend-reader'

const ACCOUNT = '00000000-0000-4000-8000-000000000079'
const row = (date: string, spend: string, syncedAt: string) => ({
  ad_account_id: ACCOUNT,
  entity_level: 'account',
  campaign_id: null,
  adset_id: null,
  ad_id: null,
  date_start: date,
  date_stop: date,
  spend,
  synced_at: syncedAt,
})

describe('exact account ad-spend windows', () => {
  it('sums four-decimal Meta spend without floating-point rounding', () => {
    expect(summarizeAccountSpendWindow({
      adAccountId: ACCOUNT,
      window: { start: '2026-08-01', end: '2026-08-02' },
      asOf: '2026-08-04T00:00:00Z',
      rows: [
        row('2026-08-01', '32.5617', '2026-08-02T05:00:00Z'),
        row('2026-08-02', '32.5618', '2026-08-03T05:00:00Z'),
      ],
    })).toMatchObject({ status: 'available', totalSpend: '65.1235', dayCount: 2 })
  })

  it('never turns a missing, duplicate, or prematurely synced day into zero spend', () => {
    const missing = summarizeAccountSpendWindow({
      adAccountId: ACCOUNT,
      window: { start: '2026-08-01', end: '2026-08-02' },
      asOf: '2026-08-04T00:00:00Z',
      rows: [row('2026-08-01', '0', '2026-08-02T05:00:00Z')],
    })
    expect(missing).toMatchObject({ status: 'unavailable' })
    expect(missing.blockerCodes).toContain('meta_spend_day_missing:2026-08-02')

    expect(() => summarizeAccountSpendWindow({
      adAccountId: ACCOUNT,
      window: { start: '2026-08-01', end: '2026-08-01' },
      asOf: '2026-08-04T00:00:00Z',
      rows: [
        row('2026-08-01', '1', '2026-08-02T05:00:00Z'),
        row('2026-08-01', '1', '2026-08-02T05:00:00Z'),
      ],
    })).toThrow(/duplicate.*spend day/i)

    const premature = summarizeAccountSpendWindow({
      adAccountId: ACCOUNT,
      window: { start: '2026-08-01', end: '2026-08-01' },
      asOf: '2026-08-04T00:00:00Z',
      rows: [row('2026-08-01', '12.0000', '2026-08-01T12:00:00Z')],
    })
    expect(premature.blockerCodes).toContain('meta_spend_day_not_closed:2026-08-01')
  })

  it('rejects future-known, cross-account, fractional-overprecision, and wrong-level rows', () => {
    const summarize = (over: Record<string, unknown>) => summarizeAccountSpendWindow({
      adAccountId: ACCOUNT,
      window: { start: '2026-08-01', end: '2026-08-01' },
      asOf: '2026-08-04T00:00:00Z',
      rows: [{ ...row('2026-08-01', '12.0000', '2026-08-02T05:00:00Z'), ...over }],
    })
    expect(() => summarize({ synced_at: '2026-08-05T00:00:00Z' })).toThrow(/after the as-of cut/i)
    expect(() => summarize({ ad_account_id: '00000000-0000-4000-8000-000000000080' }))
      .toThrow(/unexpected account/i)
    expect(() => summarize({ spend: '1.00001' })).toThrow(/malformed.*spend row/i)
    expect(() => summarize({ entity_level: 'ad' })).toThrow(/malformed.*spend row/i)
  })

  it('uses an account-scoped, as-of-bounded read and enforces the expected row cap', async () => {
    const calls: Array<[string, string, unknown]> = []
    const rows = [row('2026-08-01', '0.0000', '2026-08-02T05:00:00Z')]
    const client = {
      from(table: string) {
        expect(table).toBe('daily_insights')
        return {
          select() { return this },
          eq(field: string, value: unknown) { calls.push(['eq', field, value]); return this },
          gte(field: string, value: unknown) { calls.push(['gte', field, value]); return this },
          lte(field: string, value: unknown) { calls.push(['lte', field, value]); return this },
          order() { return this }, limit(value: number) { calls.push(['limit', 'rows', value]); return this },
          then(resolve: (value: { data: unknown[]; error: null }) => void) {
            resolve({ data: rows, error: null })
          },
        }
      },
    } as unknown as SupabaseClient
    const result = await readAccountSpendWindow(
      client, ACCOUNT, { start: '2026-08-01', end: '2026-08-01' }, '2026-08-04T00:00:00Z',
    )
    expect(result).toMatchObject({ status: 'available', totalSpend: '0.0000' })
    expect(calls).toContainEqual(['eq', 'ad_account_id', ACCOUNT])
    expect(calls).toContainEqual(['eq', 'entity_level', 'account'])
    expect(calls).toContainEqual(['lte', 'synced_at', '2026-08-04T00:00:00Z'])
    expect(calls).toContainEqual(['limit', 'rows', 2])
  })
})
