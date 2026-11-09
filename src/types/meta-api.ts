// ============================================================
// Raw Meta Graph API response types
// ============================================================

export interface MetaApiError {
  message: string
  type: string
  code: number
  error_subcode?: number
  fbtrace_id?: string
}

export interface MetaApiResponse<T> {
  data: T
  error?: MetaApiError
  paging?: {
    cursors: { before: string; after: string }
    next?: string
    previous?: string
  }
}

export interface MetaDeliverySubStatus {
  status: string | null
  substatuses: string[]
}

export interface MetaInsightAction {
  action_type: string
  value: string
  /**
   * Per-window amounts, present only when the request sends `action_attribution_windows` — which the
   * sync always does (`ACTION_ATTRIBUTION_WINDOWS = ['7d_click','1d_view']`). `value` is the total and
   * is window-request-INVARIANT: it follows the entity's own `attribution_spec`, not the request.
   * For example, at account level:
   *   value 3800.00  =  1d_view 2356.00  +  7d_click 1444.00
   * i.e. 62.0% of that account's booking value is VIEW-THROUGH. A ROAS that does not say so reads as
   * click-earned revenue.
   */
  '1d_view'?: string
  '7d_click'?: string
  /**
   * Any OTHER window Meta returns. The key set follows the request
   * (`ACTION_ATTRIBUTION_WINDOWS_ARR`) and the entity's `attribution_spec`, so naming only the two
   * windows the sync currently requests would hardcode today's config into the type — the same
   * coupling that made a `best['7d_click']` sentinel silently wrong. An ad set can already carry a
   * third window (ENGAGED_VIDEO_VIEW).
   */
  [attributionWindow: string]: string | undefined
}

export interface MetaInsightRow {
  date_start: string
  date_stop: string
  account_id?: string
  campaign_id?: string
  adset_id?: string
  ad_id?: string
  impressions?: string
  reach?: string
  frequency?: string
  spend?: string
  clicks?: string
  unique_clicks?: string
  inline_link_clicks?: string
  ctr?: string
  inline_link_click_ctr?: string
  cpc?: string
  cost_per_inline_link_click?: string
  cpm?: string
  cpp?: string
  actions?: MetaInsightAction[]
  action_values?: MetaInsightAction[]
  /**
   * The VALUE counterpart of `results`, and the only field that still breaks a custom pixel event's
   * money out BY NAME.
   *
   * `action_values` stopped naming custom events (it carries only the
   * `offsite_conversion.fb_pixel_custom` aggregate, which sums every custom event and is therefore
   * refused as booking value). `results` was added on 2026-07-12 to recover the COUNT; the VALUE was
   * left reading the field that no longer answers, so booking-value coverage decayed month over
   * month to 0% while Meta had the number the whole time: `conversion_values` carried
   * `offsite_conversion.fb_pixel_custom.AppointmentConfirmed = <value>` at account level and per ad,
   * against $0.00 stored in the warehouse.
   */
  conversions?: MetaInsightAction[]
  conversion_values?: MetaInsightAction[]
  cost_per_action_type?: MetaInsightAction[]
  /** Ads Manager "Results" column — indicator-named per optimization goal, e.g.
   *  indicator "conversions:offsite_conversion.fb_pixel_custom.AppointmentConfirmed". */
  results?: { indicator?: string; values?: { value?: string; attribution_windows?: string[] }[] }[]
  /** video STARTS. Meta documents this field as "in development" — may be absent. */
  video_play_actions?: MetaInsightAction[]
  /** Continuous 2-second views. NOT a three-second view. */
  video_continuous_2_sec_watched_actions?: MetaInsightAction[]
  video_thruplay_watched_actions?: MetaInsightAction[]
  video_p25_watched_actions?: MetaInsightAction[]
  video_p50_watched_actions?: MetaInsightAction[]
  video_p75_watched_actions?: MetaInsightAction[]
  video_p100_watched_actions?: MetaInsightAction[]
  video_avg_time_watched_actions?: MetaInsightAction[]
  // Auction quality diagnostics — ad-level only; Meta returns these once an ad has enough delivery.
  quality_ranking?: string
  engagement_rate_ranking?: string
  conversion_rate_ranking?: string
}

export interface MetaAdAccount {
  id: string
  name: string
  currency: string
  account_status: number
  timezone_name: string
  business?: { id: string; name: string }
  spend_cap?: string
  amount_spent?: string
  disable_reason?: number
  /** Resolved after supplemental API calls — may be null if token lacks pixel permissions */
  pixel_id?: string | null
  /** Resolved after supplemental API calls */
  instagram_account_id?: string | null
  /** Resolved after supplemental API calls */
  facebook_page_id?: string | null
}

export interface MetaCampaign {
  id: string
  name: string
  status: string
  effective_status: string
  objective?: string
  daily_budget?: string
  lifetime_budget?: string
  spend_cap?: string
  buying_type?: string
  special_ad_categories?: string[]
  start_time?: string
  stop_time?: string
  created_time?: string
  updated_time?: string
}

export interface MetaAdSet {
  id: string
  name: string
  status: string
  effective_status: string
  campaign_id: string
  daily_budget?: string
  lifetime_budget?: string
  budget_remaining?: string
  bid_amount?: string
  bid_strategy?: string
  optimization_goal?: string
  billing_event?: string
  destination_type?: string
  targeting?: Record<string, unknown>
  /** Sibling ad-set field: what Meta ACTUALLY relaxed at delivery, e.g. [{key:'lookalike',value:1}].
   *  Distinct from the CONFIGURED expansion state inside `targeting`, which Meta returns in one of two
   *  shapes depending on ad-set vintage: targeting_automation.advantage_audience (modern) or
   *  targeting_optimization: "expansion_all" (legacy). This field reports observed behaviour. */
  targeting_optimization_types?: Array<{ key: string; value: number }>
  promoted_object?: Record<string, unknown>
  attribution_spec?: unknown[]
  pacing_type?: string[]
  /** Meta learning-phase info: status LEARNING | LEARNING_LIMITED | SUCCESS (exited); `conversions` =
   *  optimization events counted toward the ~50-event learning exit (attribution-scoped, RESETS on
   *  significant edits); `last_sig_edit_ts` = epoch seconds of the last significant edit. */
  learning_stage_info?: { status?: string; conversions?: number; last_sig_edit_ts?: number }
  delivery_sub_status?: MetaDeliverySubStatus | null
  delivery_sub_status_read_available?: boolean
  start_time?: string
  end_time?: string
  created_time?: string
  updated_time?: string
}

export interface MetaCustomAudience {
  id: string
  name?: string
  subtype?: string
  account_id?: string
  approximate_count?: number | string
  approximate_count_lower_bound?: number | string
  approximate_count_upper_bound?: number | string
  retention_days?: number | string
  lookalike_spec?: Record<string, unknown>
  operation_status?: unknown
  delivery_status?: unknown
  time_updated?: string
}

export interface MetaAdIssue {
  error_code?: number
  error_summary?: string
  error_message?: string
  level?: 'AD' | 'AD_SET' | 'CAMPAIGN'
}

export interface MetaAd {
  id: string
  name: string
  status: string
  effective_status: string
  adset_id: string
  campaign_id: string
  creative?: { id: string }
  review_feedback?: Record<string, unknown>
  issues_info?: MetaAdIssue[]
  tracking_specs?: unknown[]
  conversion_specs?: unknown[]
  url_tags?: string
  /** Ad-level destination when Graph exposes it. Omitted is unknown, never inherited here. */
  destination_url?: string
  destination_url_read_available?: boolean
  delivery_sub_status?: MetaDeliverySubStatus | null
  delivery_sub_status_read_available?: boolean
  created_time?: string
  updated_time?: string
}

export interface MetaCreative {
  id: string
  name?: string
  status?: string
  object_type?: string
  body?: string
  title?: string
  description?: string
  link_url?: string
  url_tags?: string
  display_url?: string
  instagram_permalink_url?: string
  image_url?: string
  image_hash?: string
  video_id?: string
  thumbnail_url?: string
  call_to_action_type?: string
  child_attachments?: unknown[]
  object_story_spec?: Record<string, unknown>
  asset_feed_spec?: Record<string, unknown>
  created_time?: string
}
