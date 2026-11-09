import { getAdminClient } from '@/lib/supabase/admin'
import type { MetaInsightRow } from '@/types/meta-api'
import { computeVideoMetrics } from '@/lib/creative/video-metrics'
import {
  findActionValue,
  findActionValueOrNull,
  findAppointmentConfirmedResults,
  findAppointmentConfirmedViewThrough,
  readBookingValue,
  readBookingValueViewThrough,
  requiredDeliveryNumber,
  validateMetaInsightDeliveryRows,
  type InsightLevel,
} from './insight-outcomes'

// The pure validation/normalization surface lives in ./insight-outcomes (client-safe); re-exported here
// so existing server callers keep importing it from this module unchanged.
export {
  validateMetaInsightDeliveryRows,
  normalizeOutcome,
  META_OUTCOME_PLANE_POLICY,
  isCoverageBlockerCode,
  reconcileMetaOutcomeHierarchy,
  findActionValueOrNull,
  readAppointmentConfirmedResult,
  findAppointmentConfirmedResults,
  findAppointmentConfirmedViewThrough,
  readBookingValueViewThrough,
  readBookingValue,
} from './insight-outcomes'
export type { InsightLevel, MetaOutcomePlaneReadiness, AppointmentConfirmedResultRead } from './insight-outcomes'

const CHUNK_SIZE = 500

/**
 * Extracts a count from a Meta video action array (e.g. video_thruplay_watched_actions).
 * Meta video arrays contain a single entry with action_type 'video_view'.
 * Returns 0 if the array is absent or the entry is missing.
 */
function findVideoMetricCount(
  actions: MetaInsightRow['video_p25_watched_actions'] | undefined,
  actionType: string,
): number {
  if (!Array.isArray(actions) || actions.length === 0) return 0
  for (const entry of actions) {
    if ((entry.action_type ?? '') === actionType) {
      return Math.round(parseFloat(entry.value ?? '0') || 0)
    }
  }
  // Fallback: if no action_type match, take the first entry (Meta sometimes omits action_type)
  return Math.round(parseFloat(actions[0]?.value ?? '0') || 0)
}

/**
 * Like findVideoMetricCount but distinguishes ABSENT from ZERO. An absent field means Meta did not
 * measure it (returns null -> the derived rate is UNAVAILABLE); a present 0 is a real measurement of
 * no activity (returns 0 -> a genuine 0% rate). Collapsing the two is how "unavailable" silently
 * becomes "zero".
 */
function findVideoMetricCountOrNull(
  actions: MetaInsightRow['video_p25_watched_actions'] | undefined,
  actionType: string,
): number | null {
  if (!Array.isArray(actions)) return null
  if (actions.length === 0) return 0
  return findVideoMetricCount(actions, actionType)
}

function safeFloat(val: string | number | null | undefined): number | null {
  if (val === null || val === undefined || val === '') return null
  const n = parseFloat(String(val))
  return isFinite(n) ? n : null
}

function safeDivide(numerator: number, denominator: number): number | null {
  if (denominator === 0 || !isFinite(denominator)) return null
  const result = numerator / denominator
  return isFinite(result) ? result : null
}

async function buildFkMaps(
  supabase: ReturnType<typeof getAdminClient>,
  level: InsightLevel,
  rows: MetaInsightRow[]
): Promise<{
  campaignMap: Map<string, string>
  adsetMap: Map<string, string>
  adMap: Map<string, string>
}> {
  const campaignMap = new Map<string, string>()
  const adsetMap = new Map<string, string>()
  const adMap = new Map<string, string>()

  if (level === 'account') {
    return { campaignMap, adsetMap, adMap }
  }

  const metaCampaignIds = [...new Set(rows.map((r) => r.campaign_id).filter(Boolean))] as string[]
  if (metaCampaignIds.length > 0) {
    const { data, error } = await supabase
      .from('campaigns')
      .select('id, campaign_id')
      .in('campaign_id', metaCampaignIds)
    if (error) throw new Error(`upsertInsights: campaign lookup failed: ${error.message}`)
    for (const c of data ?? []) campaignMap.set(c.campaign_id as string, c.id as string)
  }

  if (level === 'campaign') {
    return { campaignMap, adsetMap, adMap }
  }

  const metaAdsetIds = [...new Set(rows.map((r) => r.adset_id).filter(Boolean))] as string[]
  if (metaAdsetIds.length > 0) {
    const { data, error } = await supabase
      .from('adsets')
      .select('id, adset_id')
      .in('adset_id', metaAdsetIds)
    if (error) throw new Error(`upsertInsights: adset lookup failed: ${error.message}`)
    for (const a of data ?? []) adsetMap.set(a.adset_id as string, a.id as string)
  }

  if (level === 'adset') {
    return { campaignMap, adsetMap, adMap }
  }

  const metaAdIds = [...new Set(rows.map((r) => r.ad_id).filter(Boolean))] as string[]
  if (metaAdIds.length > 0) {
    const { data, error } = await supabase
      .from('ads')
      .select('id, ad_id')
      .in('ad_id', metaAdIds)
    if (error) throw new Error(`upsertInsights: ads lookup failed: ${error.message}`)
    for (const a of data ?? []) adMap.set(a.ad_id as string, a.id as string)
  }

  return { campaignMap, adsetMap, adMap }
}

export async function upsertInsights(
  adAccountDbId: string,
  metaAccountId: string,
  level: InsightLevel,
  rows: MetaInsightRow[]
): Promise<number> {
  if (rows.length === 0) return 0

  const rowDates = rows.map((row) => row.date_start).sort()
  validateMetaInsightDeliveryRows(level, rows, rowDates[0], rowDates[rowDates.length - 1])

  const supabase = getAdminClient()
  const { campaignMap, adsetMap, adMap } = await buildFkMaps(supabase, level, rows)

  const dbRows = rows
    .map((r) => {
      const campaignDbId = r.campaign_id ? (campaignMap.get(r.campaign_id) ?? null) : null
      const adsetDbId = r.adset_id ? (adsetMap.get(r.adset_id) ?? null) : null
      const adDbId = r.ad_id ? (adMap.get(r.ad_id) ?? null) : null

      // Skip row if required FK is missing for the level
      if (level === 'campaign' && !campaignDbId) {
        console.warn(`[Sync] upsertInsights: skipping campaign-level row, no DB id for meta campaign ${r.campaign_id}`)
        return null
      }
      if (level === 'adset' && (!campaignDbId || !adsetDbId)) {
        console.warn(`[Sync] upsertInsights: skipping adset-level row, missing FK for adset ${r.adset_id}`)
        return null
      }
      if (level === 'ad' && (!campaignDbId || !adsetDbId || !adDbId)) {
        console.warn(`[Sync] upsertInsights: skipping ad-level row, missing FK for ad ${r.ad_id}`)
        return null
      }

      const leads = findActionValue(
        r.actions,
        'lead',
        'offsite_conversion.fb_pixel_lead'
      )
      // AppointmentConfirmed bookings are ONLY the indicator-named Results default total. Named action
      // aliases remain diagnostic; the generic custom aggregate is never a booking fallback.
      const bookings = findAppointmentConfirmedResults(r.results)
      // View-through share of those bookings (1d_view per-window entries; null = breakdown unavailable).
      const bookingsViewThrough = findAppointmentConfirmedViewThrough(r.results)
      const appointmentValueViewThroughRead = readBookingValueViewThrough(r.action_values, undefined, r.conversion_values)
      const appointmentValueViewThrough = appointmentValueViewThroughRead.value
      // Booking value, read through the SAME function the readiness gate reads through, so the stored
      // column and the gate's verdict can never disagree again. null = Meta supplied no booking-value
      // measure for this row; 0 = Meta reported a booking worth zero.
      const bookingValue = readBookingValue(r.action_values, undefined, r.conversion_values)
      const appointmentValue = bookingValue.matched ? bookingValue.value : null

      const linkClicks = findActionValueOrNull(r.actions, 'link_click')
      const landingPageViews = findActionValueOrNull(r.actions, 'landing_page_view')
      // `video_views` was findVideoActionValue(video_p25_watched_actions) — p25, the 25%
      // RETENTION MILESTONE, stored under a name every consumer reads as "views". An earlier change renamed the
      // derived rates but left this raw column lying. It is now the honest video-START count when
      // Meta returns one, and NULL otherwise — never p25.

      const spend = requiredDeliveryNumber(r, 'spend', false)
      const impressions = requiredDeliveryNumber(r, 'impressions', true)
      const reach = requiredDeliveryNumber(r, 'reach', true)
      const clicks = requiredDeliveryNumber(r, 'clicks', true)
      const uniqueClicks = Math.round(safeFloat(r.unique_clicks) ?? 0)

      // Video engagement metrics — only meaningful at ad level
      const isAdLevel = level === 'ad'
      const thruplayCount = isAdLevel
        ? findVideoMetricCount(r.video_thruplay_watched_actions, 'video_view')
        : null
      const videoP25 = isAdLevel
        ? findVideoMetricCount(r.video_p25_watched_actions, 'video_view')
        : null
      const videoP50 = isAdLevel
        ? findVideoMetricCount(r.video_p50_watched_actions, 'video_view')
        : null
      const videoP75 = isAdLevel
        ? findVideoMetricCount(r.video_p75_watched_actions, 'video_view')
        : null
      const videoP100 = isAdLevel
        ? findVideoMetricCount(r.video_p100_watched_actions, 'video_view')
        : null
      // EARLY VIEW — from a REAL Meta field only. video_p25 is 25% OF THE VIDEO LENGTH (~15-30s on
      // 60-120s creatives), so it was never a three-second hook and is never
      // substituted for one. When Meta returns no early-view field the rate stays UNAVAILABLE.
      const videoPlays = isAdLevel ? findVideoMetricCountOrNull(r.video_play_actions, 'video_view') : null
      const continuous2s = isAdLevel
        ? findVideoMetricCountOrNull(r.video_continuous_2_sec_watched_actions, 'video_view')
        : null

      const videoMetrics = isAdLevel
        ? computeVideoMetrics({
            impressions,
            videoPlays,
            continuous2sViews: continuous2s,
            p25: videoP25, p50: videoP50, p75: videoP75, p100: videoP100,
            thruplays: thruplayCount,
            avgWatchSeconds: safeFloat(r.video_avg_time_watched_actions?.[0]?.value),
            // Duration is joined from the creative at read time; unknown here lowers confidence
            // downstream rather than being assumed.
            durationSeconds: null,
          })
        : null

      // hook_rate now carries the EARLY-VIEW rate from a real field, or null. hold_rate is retired as
      // a stored derivation: thruplays ÷ p25 could exceed 100% on a long video. ThruPlay rate is
      // measured against impressions and kept separate from the retention milestones.
      const hookRate = videoMetrics?.earlyView.value ?? null
      const holdRate = null

      return {
        date_start: r.date_start,
        date_stop: r.date_stop,
        entity_level: level,
        ad_account_id: adAccountDbId,
        campaign_id: campaignDbId,
        adset_id: adsetDbId,
        ad_id: adDbId,
        meta_account_id: metaAccountId,
        meta_campaign_id: r.campaign_id ?? null,
        meta_adset_id: r.adset_id ?? null,
        meta_ad_id: r.ad_id ?? null,
        impressions,
        reach,
        frequency: safeFloat(r.frequency),
        spend,
        clicks,
        unique_clicks: uniqueClicks,
        link_clicks: linkClicks,
        landing_page_views: landingPageViews,
        ctr: safeFloat(r.ctr),
        cpc: safeFloat(r.cpc),
        cpm: safeFloat(r.cpm),
        leads,
        bookings,
        bookings_view_through: bookingsViewThrough,
        cost_per_lead: safeDivide(spend, leads),
        cost_per_booking: safeDivide(spend, bookings),
        appointment_value: appointmentValue,
        // ROAS = booking value returned / amount spent. Null when Meta supplied no value measure —
        // never when it supplied one that happens to be zero.
        roas: appointmentValue === null ? null : safeDivide(appointmentValue, spend),
        video_views: videoPlays,
        // Declares which video-metric contract produced this row. Trends read ONLY contract-bearing
        // rows, so a legacy row without a contract can never be silently mixed into a series.
        video_metrics_contract: 'rev_i',
        video_thru_plays: r.video_thruplay_watched_actions
          ? Math.round(safeFloat(r.video_thruplay_watched_actions?.[0]?.value) ?? 0)
          : null,
        video_avg_play_time: safeFloat(r.video_avg_time_watched_actions?.[0]?.value),
        video_p25_watched: r.video_p25_watched_actions
          ? Math.round(safeFloat(r.video_p25_watched_actions?.[0]?.value) ?? 0)
          : null,
        video_p50_watched: r.video_p50_watched_actions
          ? Math.round(safeFloat(r.video_p50_watched_actions?.[0]?.value) ?? 0)
          : null,
        video_p75_watched: r.video_p75_watched_actions
          ? Math.round(safeFloat(r.video_p75_watched_actions?.[0]?.value) ?? 0)
          : null,
        video_p100_watched: r.video_p100_watched_actions
          ? Math.round(safeFloat(r.video_p100_watched_actions?.[0]?.value) ?? 0)
          : null,
        // Legacy video milestone columns
        thruplay_count: thruplayCount,
        video_p25: videoP25,
        video_p50: videoP50,
        video_p75: videoP75,
        video_p100: videoP100,
        // video_3s_views stays NULL forever: this edge exposes no three-second field, and filling it
        // with p25 is the exact defect being removed.
        video_3s_views: null,
        hook_rate: hookRate,
        hold_rate: holdRate,
        // Honest early-view provenance + preserved raw inputs for any impossible rate.
        video_plays: videoPlays,
        video_continuous_2s_views: continuous2s,
        early_view_source: isAdLevel ? (videoMetrics?.earlyViewSource ?? 'unavailable') : null,
        derived_metric_warnings:
          videoMetrics && videoMetrics.warnings.length > 0 ? videoMetrics.warnings : null,
        actions: r.actions ?? null,
        action_values: r.action_values ?? null,
        // Persisted so a restatement script can replay the source `readBookingValue`
        // actually prefers. Without it, replay recomputes every conversion_values-sourced row to
        // NULL and files the loss as a withdrawal.
        conversion_values: r.conversion_values ?? null,
        appointment_value_view_through: appointmentValueViewThrough,
        cost_per_action_type: r.cost_per_action_type ?? null,
        // Auction quality diagnostics — ad-level only; Meta returns these once an ad
        // has enough delivery, so they stay null at higher levels and on thin ads.
        quality_ranking: isAdLevel ? (r.quality_ranking ?? null) : null,
        engagement_rate_ranking: isAdLevel ? (r.engagement_rate_ranking ?? null) : null,
        conversion_rate_ranking: isAdLevel ? (r.conversion_rate_ranking ?? null) : null,
        synced_at: new Date().toISOString(),
      }
    })
    .filter((r): r is NonNullable<typeof r> => r !== null)

  if (dbRows.length === 0) return 0

  let totalUpserted = 0

  for (let i = 0; i < dbRows.length; i += CHUNK_SIZE) {
    const chunk = dbRows.slice(i, i + CHUNK_SIZE)

    const { data, error } = await supabase
      .from('daily_insights')
      .upsert(chunk, {
        onConflict: 'entity_level,ad_account_id,campaign_id,adset_id,ad_id,date_start',
        ignoreDuplicates: false,
      })
      .select('id')

    if (error) {
      throw new Error(`upsertInsights chunk ${i}-${i + chunk.length} failed: ${error.message}`)
    }

    totalUpserted += data?.length ?? 0
  }

  return totalUpserted
}

/** PURE: per-date account outcomes that need raising to the campaign-level authority. Meta can omit
 *  account-level action/result detail while campaign/ad-set/ad responses carry the reconciled values.
 *  Campaign is the outcome authority; account remains the delivery authority. */
export function computeAccountBookingsRollup(
  accountRows: Array<{ id: string; date_start: string; spend: number | null; leads: number | null; bookings: number | null; appointment_value: number | null }>,
  campaignRows: Array<{ date_start: string; leads: number | null; bookings: number | null; appointment_value: number | null; bookings_view_through?: number | null; appointment_value_view_through?: number | null }>,
): Array<{ id: string; leads: number; bookings: number; appointment_value: number | null; cost_per_lead: number | null; cost_per_booking: number | null; bookings_view_through: number | null; appointment_value_view_through: number | null }> {
  const byDate = new Map<string, {
    leads: number
    bookings: number
    value: number
    valueComplete: boolean
    viewThrough: number
    viewThroughComplete: boolean
    valueViewThrough: number
    valueViewThroughComplete: boolean
  }>()
  for (const r of campaignRows) {
    const a = byDate.get(r.date_start) ?? {
      leads: 0, bookings: 0, value: 0, valueComplete: true,
      viewThrough: 0, viewThroughComplete: true,
      valueViewThrough: 0, valueViewThroughComplete: true,
    }
    a.leads += r.leads ?? 0
    const bookings = r.bookings ?? 0
    a.bookings += bookings
    if (r.appointment_value === null) {
      if (bookings > 0) a.valueComplete = false
    } else {
      a.value += r.appointment_value
    }
    // Ledger G twin of the rule below. `appointment_value` is overwritten with the reconciled child
    // sum, so leaving its view-through share un-reconciled would put a child-summed total and an
    // account-read share on the SAME row — a ratio across two populations.
    if (r.appointment_value_view_through === null || r.appointment_value_view_through === undefined) {
      if (bookings > 0) a.valueViewThroughComplete = false
    } else {
      a.valueViewThrough += r.appointment_value_view_through
    }
    if (r.bookings_view_through === null || r.bookings_view_through === undefined) {
      if (bookings > 0) a.viewThroughComplete = false
    } else {
      a.viewThrough += r.bookings_view_through
    }
    byDate.set(r.date_start, a)
  }
  const updates: Array<{ id: string; leads: number; bookings: number; appointment_value: number | null; cost_per_lead: number | null; cost_per_booking: number | null; bookings_view_through: number | null; appointment_value_view_through: number | null }> = []
  for (const acct of accountRows) {
    const sum = byDate.get(acct.date_start)
    if (!sum) continue
    const spend = acct.spend ?? 0
    const leads = sum.leads
    const bookings = sum.bookings
    updates.push({
      id: acct.id,
      leads,
      bookings,
      appointment_value: sum.valueComplete ? sum.value : null,
      cost_per_lead: leads > 0 && spend > 0 ? spend / leads : null,
      cost_per_booking: bookings > 0 && spend > 0 ? spend / bookings : null,
      bookings_view_through: sum.viewThroughComplete ? sum.viewThrough : null,
      appointment_value_view_through: sum.valueViewThroughComplete ? sum.valueViewThrough : null,
    })
  }
  return updates
}

/** Raise account-level daily outcomes to the campaign-level sum for the synced window (see
 *  computeAccountBookingsRollup). Non-fatal by design — callers treat failures as partial errors. */
export async function reconcileAccountBookings(
  adAccountDbId: string,
  since: string,
  until: string,
): Promise<number> {
  const supabase = getAdminClient()
  const { data, error } = await supabase
    .from('daily_insights')
    .select('id, date_start, spend, leads, bookings, appointment_value, bookings_view_through, appointment_value_view_through, entity_level')
    .eq('ad_account_id', adAccountDbId)
    .in('entity_level', ['account', 'campaign'])
    .gte('date_start', since)
    .lte('date_start', until)
  if (error) throw new Error(`reconcileAccountBookings read failed: ${error.message}`)
  const rows = data ?? []
  const accountRows = rows
    .filter((r) => r.entity_level === 'account')
    .map((r) => ({ id: r.id as string, date_start: r.date_start as string, spend: Number(r.spend ?? 0), leads: r.leads as number | null, bookings: r.bookings as number | null, appointment_value: r.appointment_value as number | null }))
  const campaignRows = rows
    .filter((r) => r.entity_level === 'campaign')
    .map((r) => ({ date_start: r.date_start as string, leads: r.leads as number | null, bookings: r.bookings as number | null, appointment_value: r.appointment_value as number | null, bookings_view_through: r.bookings_view_through as number | null, appointment_value_view_through: r.appointment_value_view_through as number | null }))

  const updates = computeAccountBookingsRollup(accountRows, campaignRows)
  for (const u of updates) {
    const { error: upErr } = await supabase
      .from('daily_insights')
      .update({ leads: u.leads, bookings: u.bookings, appointment_value: u.appointment_value, cost_per_lead: u.cost_per_lead, cost_per_booking: u.cost_per_booking, bookings_view_through: u.bookings_view_through, appointment_value_view_through: u.appointment_value_view_through })
      .eq('id', u.id)
    if (upErr) throw new Error(`reconcileAccountBookings update failed: ${upErr.message}`)
  }
  return updates.length
}
