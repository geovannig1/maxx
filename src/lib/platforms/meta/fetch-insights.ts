import { metaGetPaginated } from './client'
import { ACTION_ATTRIBUTION_WINDOWS } from './attribution'
import type { MetaInsightRow } from '@/types/meta-api'

// Metric fields fetched for all levels
const METRIC_FIELDS = [
  'impressions',
  'reach',
  'frequency',
  'spend',
  'clicks',
  'unique_clicks',
  'inline_link_clicks',
  'ctr',
  'inline_link_click_ctr',
  'cpc',
  'cost_per_inline_link_click',
  'cpm',
  'cpp',
  'actions',
  'action_values',
  'cost_per_action_type',
  // Ads Manager's "Results" column (indicator-based). Needed because the actions array no longer
  // reliably breaks custom pixel events out by name (only the generic offsite_conversion.fb_pixel_custom
  // aggregate) — `results` can name the custom event while `actions` has no such row.
  'results',
  // The VALUE counterpart of `results`, added 2026-08-31 for the same reason `results` was added:
  // `action_values` no longer names custom pixel events, so booking VALUE fell to 0% coverage in
  // August while Meta still had it. `conversion_values` names it. Requested at every level — the
  // per-ad breakout is what makes a per-entity ROAS possible at all.
  'conversions',
  'conversion_values',
  // EARLY-VIEW fields (verified on the Ads Insights reference, v25.0, 2026-07-26). There is NO
  // three-second-view field on this edge, so these are the only honest early-view signals.
  // video_play_actions is documented by Meta as "in development" — if it is absent from a response
  // the early-view rate stays UNAVAILABLE; p25 is never substituted for it.
  'video_play_actions',
  'video_continuous_2_sec_watched_actions',
  'video_thruplay_watched_actions',
  // RETENTION MILESTONES — % of video length reached, NOT early-view signals.
  'video_p25_watched_actions',
  'video_p50_watched_actions',
  'video_p75_watched_actions',
  'video_p100_watched_actions',
  'video_avg_time_watched_actions',
]

// Auction quality diagnostics — Meta only returns these at the AD level (and rejects them at higher
// levels), so they're requested per-level below, never for account/campaign/adset.
const AD_RANKING_FIELDS = ['quality_ranking', 'engagement_rate_ranking', 'conversion_rate_ranking']

// Meta v22 does not auto-include entity IDs in insight responses when using
// time_range — they must be explicitly requested per level.
const LEVEL_ID_FIELDS: Record<string, string[]> = {
  account:  [],
  campaign: ['campaign_id'],
  adset:    ['campaign_id', 'adset_id'],
  ad:       ['campaign_id', 'adset_id', 'ad_id'],
}

export interface FetchInsightsParams {
  accountId: string
  level: 'account' | 'campaign' | 'adset' | 'ad'
  datePreset?: string
  since?: string
  until?: string
}

/**
 * Fetch Meta's native aggregate for one exact reporting window.
 *
 * Reach and frequency are non-additive across days. This deliberately omits
 * `time_increment`, so Meta evaluates the selected window as `all_days`
 * instead of returning daily rows that a caller could accidentally aggregate.
 */
export interface FetchNativePeriodDeliveryParams {
  accountId: string
  since: string
  until: string
}

export async function fetchInsights(params: FetchInsightsParams): Promise<MetaInsightRow[]> {
  const { accountId, level, datePreset, since, until } = params

  const idFields = LEVEL_ID_FIELDS[level] ?? []
  const fields = [...idFields, ...METRIC_FIELDS, ...(level === 'ad' ? AD_RANKING_FIELDS : [])].join(',')

  const queryParams: Record<string, string> = {
    fields,
    level,
    action_attribution_windows: ACTION_ATTRIBUTION_WINDOWS,
    time_increment: '1',
    limit: '500',
  }

  if (datePreset) {
    queryParams.date_preset = datePreset
  } else if (since && until) {
    queryParams.time_range = JSON.stringify({ since, until })
  }

  return metaGetPaginated<MetaInsightRow>(
    `/act_${accountId}/insights`,
    queryParams
  )
}

export async function fetchNativePeriodDelivery(
  params: FetchNativePeriodDeliveryParams,
): Promise<MetaInsightRow[]> {
  const accountId = params.accountId.replace(/^act_/, '')
  const queryParams: Record<string, string> = {
    fields: 'reach,frequency',
    level: 'account',
    action_attribution_windows: ACTION_ATTRIBUTION_WINDOWS,
    time_range: JSON.stringify({ since: params.since, until: params.until }),
    limit: '2',
  }

  return metaGetPaginated<MetaInsightRow>(
    `/act_${accountId}/insights`,
    queryParams,
  )
}
