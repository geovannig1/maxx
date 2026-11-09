import type { SupabaseClient } from '@supabase/supabase-js'

/** Conversion labels that close an outcome out of the delivery backlog for good. */
export const TERMINAL_CONVERSION_LABELS: ReadonlySet<string> = new Set([
  'staff_created', 'origin_unknown', 'expired', 'no_id', 'missed-48h-window',
])

export interface ConversionBacklog {
  /** Unsent outcomes still eligible for delivery (no terminal label). */
  unsent: number
  oldestUnsentHours: number | null
  /** Outcomes closed out because the resend window passed. */
  missedWindow: number
}

const LOOKBACK_MS = 14 * 86_400_000

/**
 * Server-side conversion delivery backlog for ONE account and its ENABLED outcome sources
 * (src/lib/outcomes/aggregation.ts): active, non-staff outcomes of the last 14 days with no recorded
 * delivery. Another account's or a disabled source's outcomes are never part of this account's alarm.
 */
export async function readConversionBacklog(
  db: SupabaseClient, adAccountId: string, nowMs: number = Date.now(),
): Promise<ConversionBacklog> {
  const { data, error } = await db
    .from('v_business_outcomes')
    .select('occurred_at, conversion_send_error')
    .eq('ad_account_id', adAccountId)
    .eq('source_enabled', true)
    .is('conversion_sent_at', null)
    .neq('web_origin_state', 'staff_or_manual')
    .neq('status', 'cancelled')
    .gte('occurred_at', new Date(nowMs - LOOKBACK_MS).toISOString())
    .order('occurred_at', { ascending: true })
    .limit(500)
  if (error || !Array.isArray(data)) throw new Error('conversion_backlog_read_failed')
  const rows = data as Array<{ occurred_at: string; conversion_send_error: string | null }>
  const eligible = rows.filter((r) => !r.conversion_send_error || !TERMINAL_CONVERSION_LABELS.has(r.conversion_send_error))
  const oldest = eligible[0]?.occurred_at
  return {
    unsent: eligible.length,
    oldestUnsentHours: oldest ? (nowMs - new Date(oldest).getTime()) / 3_600_000 : null,
    missedWindow: rows.filter((r) => r.conversion_send_error === 'missed-48h-window').length,
  }
}
