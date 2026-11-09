import { metaGetPaginated } from './client'
import { ACTION_ATTRIBUTION_WINDOWS } from './attribution'
import { getAdminClient } from '@/lib/supabase/admin'
import { weekdayOf } from '@/lib/utils/date-utils'
import { metaOutcomeConversionId } from '@/config/business-config'

export interface DaypartInsightRow {
  hour_of_day: number    // 0-23
  day_of_week: number    // 0=Sun, 6=Sat
  spend: number
  impressions: number
  clicks: number
  bookings: number
  cpa: number | null
}

interface MetaHourlyRecord {
  date_start?: string
  hourly_stats_aggregated_by_audience_time_zone?: string
  spend?: string
  impressions?: string
  clicks?: string
  actions?: Array<{ action_type: string; value: string }>
}

// Optional numeric id of the custom conversion that represents an outcome (configuration).
const OUTCOME_CONVERSION_ID = metaOutcomeConversionId()

function isAppointment(type: string): boolean {
  const t = (type ?? '').toLowerCase()
  return t.includes('appointmentconfirmed') || (OUTCOME_CONVERSION_ID !== '' && t.includes(OUTCOME_CONVERSION_ID))
}

function parseFloat0(val: string | undefined | null): number {
  if (!val) return 0
  const n = parseFloat(val)
  return isFinite(n) ? n : 0
}

function findBookings(actions: Array<{ action_type: string; value: string }> | undefined): number {
  if (!Array.isArray(actions)) return 0
  let total = 0
  for (const a of actions) {
    if (isAppointment(a.action_type ?? '')) total += parseFloat0(a.value)
  }
  return Math.round(total)
}

/**
 * Fetch hour × day-of-week daypart insights from Meta. Uses time_increment=1 so each row
 * carries a date_start, from which we derive the real day_of_week (the old version hardcoded 0).
 * Aggregates by (hour, day_of_week) across the range. Never throws — returns [] on failure.
 */
export async function fetchDaypartInsights(params: {
  accountId: string
  since: string
  until: string
}): Promise<DaypartInsightRow[]> {
  const { accountId, since, until } = params

  let records: MetaHourlyRecord[]
  try {
    records = await metaGetPaginated<MetaHourlyRecord>(
      `/act_${accountId}/insights`,
      {
        fields: 'impressions,spend,clicks,actions',
        level: 'account',
        breakdowns: 'hourly_stats_aggregated_by_audience_time_zone',
        time_range: JSON.stringify({ since, until }),
        time_increment: '1', // daily rows → derive day_of_week from date_start
        action_attribution_windows: ACTION_ATTRIBUTION_WINDOWS,
        limit: '500',
      },
    )
  } catch (err) {
    console.warn('[fetchDaypartInsights] Meta hourly breakdown failed, returning empty result:', err instanceof Error ? err.message : err)
    return []
  }

  const agg = new Map<string, DaypartInsightRow>()
  for (const rec of records) {
    const hourStr = rec.hourly_stats_aggregated_by_audience_time_zone
    const dateStr = rec.date_start
    if (!hourStr || !dateStr) continue

    const hourMatch = hourStr.match(/^(\d+)/)
    if (!hourMatch) continue
    const hour = parseInt(hourMatch[1], 10)
    if (hour < 0 || hour > 23) continue

    const dow = weekdayOf(dateStr)
    if (dow < 0 || dow > 6) continue

    const key = `${hour}-${dow}`
    if (!agg.has(key)) {
      agg.set(key, { hour_of_day: hour, day_of_week: dow, spend: 0, impressions: 0, clicks: 0, bookings: 0, cpa: null })
    }
    const a = agg.get(key)!
    a.spend += parseFloat0(rec.spend)
    a.impressions += Math.round(parseFloat0(rec.impressions))
    a.clicks += Math.round(parseFloat0(rec.clicks))
    a.bookings += findBookings(rec.actions)
  }

  const rows = [...agg.values()]
  for (const r of rows) r.cpa = r.bookings > 0 ? r.spend / r.bookings : null
  return rows
}

/**
 * Refresh the account's daypart snapshot non-destructively. Daypart is a rolling summary, so a run
 * replaces the prior window — but it must NEVER leave the account with no snapshot:
 *   1. An empty fetch (Meta failed or returned nothing) returns before touching the table.
 *   2. The fresh window is written FIRST — upsert on the row's unique key, so a same-day re-run
 *      updates in place instead of colliding with the constraint.
 *   3. Only after that write succeeds do we delete the PRIOR-range rows. If the write fails we delete
 *      nothing and return 0, so the last good snapshot survives.
 * The brief gap between steps 2 and 3 leaves both windows present, which can transiently double raw
 * spend/bookings for a reader hitting the daypart card mid-run; CPA (spend/bookings) is invariant to
 * it, and the learning read (patterns.ts) runs later in the same cron, after the delete completes.
 */
export async function upsertDaypartInsights(
  adAccountDbId: string,
  since: string,
  until: string,
  rows: DaypartInsightRow[]
): Promise<number> {
  // (1) Never let an empty/failed fetch wipe the existing snapshot.
  if (rows.length === 0) return 0

  const db = getAdminClient()

  const insertRows = rows.map((r) => ({
    ad_account_id: adAccountDbId,
    date_range_start: since,
    date_range_end: until,
    hour_of_day: r.hour_of_day,
    day_of_week: r.day_of_week,
    spend: r.spend,
    impressions: r.impressions,
    clicks: r.clicks,
    bookings: r.bookings,
    cpa: r.cpa,
    ctr: r.impressions > 0 ? (r.clicks / r.impressions) * 100 : null,
  }))

  // (2) Write the new window first. Upsert keyed on the `daypart_insights` unique constraint so a re-run
  // on the same day updates in place rather than failing on a duplicate key.
  const { data, error } = await db
    .from('daypart_insights')
    .upsert(insertRows, {
      onConflict: 'ad_account_id,date_range_start,date_range_end,hour_of_day,day_of_week',
      ignoreDuplicates: false,
    })
    .select('id')
  if (error) {
    // Insert failed — leave the prior snapshot untouched.
    console.warn('[upsertDaypartInsights] insert failed, keeping prior snapshot:', error.message)
    return 0
  }

  // (3) New window is safely stored — now drop the prior rolling-window rows for this account.
  const { error: delError } = await db
    .from('daypart_insights')
    .delete()
    .eq('ad_account_id', adAccountDbId)
    .neq('date_range_start', since)
  if (delError) {
    console.warn('[upsertDaypartInsights] prior-snapshot cleanup failed (new snapshot is live):', delError.message)
  }

  return data?.length ?? 0
}
