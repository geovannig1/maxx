import type { SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import {
  accountDateRangeToHalfOpenInstants,
  accountDateStartInstant,
  inclusiveAccountDates,
} from './account-date-window'

const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const iso = z.string().datetime({ offset: true })
const rawRowSchema = z.object({
  ad_account_id: z.string().uuid(),
  entity_level: z.literal('account'),
  campaign_id: z.null(),
  adset_id: z.null(),
  ad_id: z.null(),
  date_start: dateOnly,
  date_stop: dateOnly,
  spend: z.union([z.string(), z.number()]),
  synced_at: iso,
}).strict()

export type AccountSpendWindowSummary =
  | {
      status: 'available'
      totalSpend: string
      dayCount: number
      blockerCodes: []
    }
  | {
      status: 'unavailable'
      totalSpend: null
      dayCount: null
      blockerCodes: string[]
    }

function spendUnits(value: string | number): bigint {
  let raw: string
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0 || value > 9_999_999_999.9999) {
      throw new Error('invalid numeric range')
    }
    raw = value.toFixed(4)
    if (Math.abs(Number(raw) - value) > 1e-9) throw new Error('more than four decimals')
  } else {
    raw = value
  }
  if (!/^\d{1,10}(?:\.\d{1,4})?$/.test(raw)) throw new Error('invalid decimal shape')
  const [whole, fraction = ''] = raw.split('.')
  return BigInt(whole) * BigInt(10_000) + BigInt(fraction.padEnd(4, '0'))
}

function formatSpend(units: bigint): string {
  const whole = units / BigInt(10_000)
  const fraction = (units % BigInt(10_000)).toString().padStart(4, '0')
  return `${whole}.${fraction}`
}

function parseRow(value: unknown): z.infer<typeof rawRowSchema> & { units: bigint } {
  try {
    const row = rawRowSchema.parse(value)
    return { ...row, units: spendUnits(row.spend) }
  } catch (error) {
    throw new Error(`Malformed account spend row: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export function summarizeAccountSpendWindow(input: {
  adAccountId: string
  window: { start: string; end: string }
  asOf: string
  rows: unknown[]
}): AccountSpendWindowSummary {
  if (!z.string().uuid().safeParse(input.adAccountId).success) {
    throw new Error('Account spend account ID must be a UUID.')
  }
  const asOf = new Date(iso.parse(input.asOf)).getTime()
  const expectedDates = inclusiveAccountDates(input.window.start, input.window.end)
  const windowInstants = accountDateRangeToHalfOpenInstants(input.window)
  if (asOf < new Date(windowInstants.end).getTime()) {
    throw new Error('Account spend as-of cut cannot precede the requested window end.')
  }
  const expected = new Set(expectedDates)
  const byDate = new Map<string, ReturnType<typeof parseRow>>()
  const blockers: string[] = []
  for (const raw of input.rows) {
    const row = parseRow(raw)
    if (row.ad_account_id !== input.adAccountId) {
      throw new Error('Account spend returned an unexpected account.')
    }
    if (!expected.has(row.date_start) || row.date_stop !== row.date_start) {
      throw new Error('Account spend returned an unexpected or multi-day row.')
    }
    if (byDate.has(row.date_start)) throw new Error(`Duplicate account spend day: ${row.date_start}.`)
    const syncedAt = new Date(row.synced_at).getTime()
    if (syncedAt > asOf) throw new Error('Account spend row was synchronized after the as-of cut.')
    const nextDate = new Date(new Date(`${row.date_start}T00:00:00.000Z`).getTime() + 86_400_000)
      .toISOString().slice(0, 10)
    if (syncedAt < new Date(accountDateStartInstant(nextDate)).getTime()) {
      blockers.push(`meta_spend_day_not_closed:${row.date_start}`)
    }
    byDate.set(row.date_start, row)
  }
  for (const date of expectedDates) {
    if (!byDate.has(date)) blockers.push(`meta_spend_day_missing:${date}`)
  }
  if (blockers.length > 0) {
    return {
      status: 'unavailable', totalSpend: null, dayCount: null,
      blockerCodes: [...new Set(blockers)].sort(),
    }
  }
  const total = expectedDates.reduce((sum, date) => sum + byDate.get(date)!.units, BigInt(0))
  return { status: 'available', totalSpend: formatSpend(total), dayCount: expectedDates.length, blockerCodes: [] }
}

export async function readAccountSpendWindow(
  db: SupabaseClient,
  adAccountId: string,
  window: { start: string; end: string },
  asOf: string,
): Promise<AccountSpendWindowSummary> {
  if (!z.string().uuid().safeParse(adAccountId).success) {
    throw new Error('Account spend account ID must be a UUID.')
  }
  const expectedDays = inclusiveAccountDates(window.start, window.end)
  iso.parse(asOf)
  const result = await db.from('daily_insights')
    .select('ad_account_id,entity_level,campaign_id,adset_id,ad_id,date_start,date_stop,spend,synced_at')
    .eq('ad_account_id', adAccountId)
    .eq('entity_level', 'account')
    .gte('date_start', window.start)
    .lte('date_start', window.end)
    .lte('synced_at', asOf)
    .order('date_start', { ascending: true })
    .limit(expectedDays.length + 1)
  if (result.error) throw new Error(`Account spend read failed: ${result.error.message}`)
  if (!Array.isArray(result.data)) throw new Error('Account spend read returned a non-array result.')
  return summarizeAccountSpendWindow({ adAccountId, window, asOf, rows: result.data })
}
