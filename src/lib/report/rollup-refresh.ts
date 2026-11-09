import { getAdminClient } from '@/lib/supabase/admin'

export interface RollupNumbers {
  total_spend: number
  total_leads: number
  total_bookings: number
  avg_cpl: number | null
  avg_cpb: number | null
}

/** PURE: the daily_reports numeric rollup for ONE day, from that day's account-level daily_insights row.
 *  Mirrors the fields generateDailyReport writes (generator.ts §9), so a restate and a fresh generation
 *  produce identical numbers. */
export function computeReportRollup(
  row: { spend: number | null; leads: number | null; bookings: number | null } | null,
): RollupNumbers {
  if (!row || row.spend === null || row.leads === null || row.bookings === null) {
    throw new Error('report rollup source contains an unknown metric; unavailable is not zero')
  }
  const spend = Number(row.spend)
  const leads = Number(row.leads)
  const bookings = Number(row.bookings)
  if (![spend, leads, bookings].every(Number.isFinite)) {
    throw new Error('report rollup source contains a non-finite metric')
  }
  return {
    total_spend: spend,
    total_leads: leads,
    total_bookings: bookings,
    avg_cpl: leads > 0 ? spend / leads : null,
    avg_cpb: bookings > 0 ? spend / bookings : null,
  }
}

/** Restate the STORED daily_reports numeric rollup across [since, until] from the (now-restated)
 *  account-level daily_insights — WITHOUT re-running the per-day LLM narrative.
 *
 *  Why this exists: Meta restates recent spend (~48–72h) and attributed conversions (up to the 7d click
 *  window), and the sync now re-pulls a rolling window into daily_insights — but generateDailyReport runs
 *  only for the latest date, so every back-day's daily_reports row keeps its stale morning-after numbers.
 *  The dashboard KPIs / spend trend / pacing AND the reconcile "rolled-up report" all read daily_reports,
 *  so those surfaces froze while daily_insights (and Ads Manager) moved. This restates the numbers only.
 *
 *  LEGACY UPDATE ONLY: an evidence-bound V3 report is one immutable snapshot and must never have its
 *  headline columns restated independently of its digest/evidence. Only pre-evidence legacy rows may
 *  receive this compatibility refresh. Missing/current report days remain untouched. */
export async function refreshReportRollups(
  adAccountDbId: string,
  since: string,
  until: string,
): Promise<number> {
  const db = getAdminClient()
  const { data: insightRows, error } = await db
    .from('daily_insights')
    .select('date_start, spend, leads, bookings')
    .eq('ad_account_id', adAccountDbId)
    .eq('entity_level', 'account')
    .gte('date_start', since)
    .lte('date_start', until)
  if (error) throw new Error(`refreshReportRollups read failed: ${error.message}`)

  let updated = 0
  for (const row of insightRows ?? []) {
    const roll = computeReportRollup(
      row as { spend: number | null; leads: number | null; bookings: number | null },
    )
    const { data: changed, error: upErr } = await db
      .from('daily_reports')
      .update(roll)
      .eq('ad_account_id', adAccountDbId)
      .eq('report_date', row.date_start as string)
      .is('executive_evidence_generation_id', null)
      .select('id')
    if (upErr) throw new Error(`refreshReportRollups update failed: ${upErr.message}`)
    updated += (changed ?? []).length
  }
  return updated
}
