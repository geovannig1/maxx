import type { DailyDigest, DailyDigestV2, DailyDigestV3 } from '@/lib/report/daily-digest'

// ============================================================
// Enum types
// ============================================================
export type EntityLevel = 'account' | 'campaign' | 'adset' | 'ad'
export type SyncStatus = 'pending' | 'running' | 'success' | 'partial' | 'failed'
export type AlertSeverity = 'info' | 'warning' | 'critical'
// MUST stay in sync with the Postgres `alert_type` enum (supabase/migrations/0001_baseline.sql). If code emits
// a value not in the DB enum the whole batched insert silently fails (this happened twice pre-squash). Typing every alert
// insert as AlertType makes tsc catch the next drift; tests/audit/alert-enum.test.ts pins the contract.
export type AlertType =
  | 'spend_spike'
  | 'spend_drop'
  | 'cpa_spike'
  | 'ctr_drop'
  | 'cpm_spike'
  | 'frequency_high'
  | 'zero_leads'
  | 'budget_exhausted'
  | 'campaign_paused'
  | 'creative_fatigue'
  | 'wrong_optimization_event'
  | 'pixel_health'
  | 'champion_candidate'
  | 'data_drift'

/** Runtime mirror of the AlertType union / Postgres `alert_type` enum. `satisfies` rejects any typo or
 *  value not in the union; the exhaustiveness check below rejects any union member missing here. So this
 *  list == the union exactly, and tests/audit/alert-enum.test.ts pins it to the baseline schema SQL. */
export const ALL_ALERT_TYPES = [
  'spend_spike', 'spend_drop', 'cpa_spike', 'ctr_drop', 'cpm_spike', 'frequency_high',
  'zero_leads', 'budget_exhausted', 'campaign_paused', 'creative_fatigue',
  'wrong_optimization_event', 'pixel_health', 'champion_candidate', 'data_drift',
] as const satisfies readonly AlertType[]
// Compile error if a union member is missing from ALL_ALERT_TYPES above.
type _AlertTypesExhaustive = Exclude<AlertType, (typeof ALL_ALERT_TYPES)[number]> extends never ? true : never
const _alertTypesExhaustive: _AlertTypesExhaustive = true
void _alertTypesExhaustive

export type TaskStatus = 'open' | 'in_progress' | 'done' | 'dismissed'
export type TaskPriority = 'low' | 'medium' | 'high' | 'urgent'
export type AudienceType = 'professional' | 'consumer' | 'mixed' | 'unknown'
export type FlagType = 'winner' | 'loser' | 'watchlist' | 'too_early' | 'scale_candidate' | 'creative_refresh'
export type FlagConfidence = 'low' | 'medium' | 'high'
export type TestStatus = 'planned' | 'running' | 'paused' | 'completed' | 'killed'
export type BriefStatus = 'draft' | 'approved' | 'in_production' | 'live' | 'archived'
export type SettingType = 'text' | 'number' | 'boolean' | 'json'
export type PaidCohortKind = 'recent_scale' | 'matured_cut'

// ============================================================
// Shared action type (used in insights JSONB columns)
// ============================================================
export interface MetaAction {
  action_type: string
  value: string
}

// ============================================================
// Table: ad_accounts
// ============================================================
export interface AdAccount {
  id: string
  account_id: string
  account_name: string | null
  business_name: string | null
  currency: string
  timezone_name: string
  spend_cap: number | null
  amount_spent: number | null
  account_status: number | null
  disable_reason: number | null
  business_id: string | null
  /** Reference key name (e.g. "META_ACCESS_TOKEN") — not the raw token */
  access_token_ref: string | null
  pixel_id: string | null
  instagram_account_id: string | null
  facebook_page_id: string | null
  is_active: boolean
  created_at: string
  updated_at: string
  last_synced_at: string | null
}

// ============================================================
// Table: campaigns
// ============================================================
export interface Campaign {
  id: string
  ad_account_id: string
  campaign_id: string
  campaign_name: string | null
  objective: string | null
  status: string
  effective_status: string | null
  buying_type: string | null
  special_ad_category: string | null
  audience_type: AudienceType
  /** Stored in dollars */
  daily_budget: number | null
  /** Stored in dollars */
  lifetime_budget: number | null
  start_time: string | null
  stop_time: string | null
  created_at: string
  updated_at: string
  meta_created_time: string | null
  meta_updated_time: string | null
  last_synced_at: string | null
}

// ============================================================
// Table: adsets
// ============================================================
export interface AdSet {
  id: string
  ad_account_id: string
  campaign_id: string
  adset_id: string
  adset_name: string | null
  status: string | null
  effective_status: string | null
  optimization_goal: string | null
  /** Meta learning_stage_info.status: LEARNING | LEARNING_LIMITED | SUCCESS (exited). Null when unknown. */
  learning_stage: string | null
  /** Meta learning_stage_info.conversions — events counted toward the ~50-event learning exit.
   *  Attribution-scoped; RESETS on significant edits. Never lifetime performance. Null when unknown. */
  learning_conversions: number | null
  /** Meta learning_stage_info.last_sig_edit_ts (ISO) — the learning counter resets from this moment. */
  last_sig_edit_ts: string | null
  billing_event: string | null
  destination_type: string | null
  promoted_object: Record<string, unknown> | null
  attribution_spec: unknown[] | null
  targeting: Record<string, unknown> | null
  audience_type: AudienceType
  /** Stored in dollars */
  daily_budget: number | null
  /** Stored in dollars */
  lifetime_budget: number | null
  bid_amount: number | null
  bid_strategy: string | null
  start_time: string | null
  end_time: string | null
  created_at: string
  updated_at: string
  meta_created_time: string | null
  meta_updated_time: string | null
  last_synced_at: string | null
}

// ============================================================
// Table: ads
// ============================================================
export interface Ad {
  id: string
  ad_account_id: string
  campaign_id: string
  adset_id: string
  creative_id: string | null
  ad_id: string
  ad_name: string | null
  status: string | null
  effective_status: string | null
  destination_url: string | null
  destination_url_read_available: boolean | null
  destination_url_synced_at: string | null
  cta_type: string | null
  creative_angle: string | null
  meta_creative_id: string | null
  url_tags: string | null
  review_feedback: Record<string, unknown> | null
  tracking_specs: Record<string, unknown> | null
  conversion_specs: Record<string, unknown> | null
  created_at: string
  updated_at: string
  meta_created_time: string | null
  meta_updated_time: string | null
  last_synced_at: string | null
}

// ============================================================
// Table: creatives
// ============================================================
export interface Creative {
  id: string
  ad_account_id: string
  creative_id: string
  creative_name: string | null
  body: string | null
  title: string | null
  description: string | null
  call_to_action_type: string | null
  link_url: string | null
  url_tags: string | null
  display_url: string | null
  instagram_permalink_url: string | null
  asset_type: string | null
  image_url: string | null
  image_hash: string | null
  video_id: string | null
  thumbnail_url: string | null
  child_attachments: unknown[] | null
  object_story_spec: Record<string, unknown> | null
  asset_feed_spec: Record<string, unknown> | null
  created_at: string
  updated_at: string
  meta_created_time: string | null
  last_synced_at: string | null
}

// ============================================================
// Table: daily_insights
// ============================================================
export interface DailyInsight {
  id: string
  date_start: string
  date_stop: string
  entity_level: EntityLevel

  ad_account_id: string
  campaign_id: string | null
  adset_id: string | null
  ad_id: string | null

  meta_account_id: string | null
  meta_campaign_id: string | null
  meta_adset_id: string | null
  meta_ad_id: string | null

  impressions: number
  reach: number
  frequency: number | null
  spend: number
  clicks: number
  unique_clicks: number
  link_clicks: number | null
  landing_page_views: number | null

  ctr: number | null
  cpc: number | null
  cpm: number | null

  leads: number
  bookings: number
  /** Of `bookings`, how many were 1d_view view-through (saw the ad, didn't click). Null = the
   *  per-window breakdown was unavailable for the row — unknown, not zero. */
  bookings_view_through: number | null
  cost_per_lead: number | null
  cost_per_booking: number | null
  /** Total monetary value of AppointmentConfirmed conversions (null if no conversion value set in Meta) */
  appointment_value: number | null
  /** ROAS = appointment_value / spend (null if no conversion value set) */
  roas: number | null

  video_views: number | null
  /** video_play_actions — video STARTS, not three-second views. Null when Meta omitted the field. */
  video_plays: number | null
  /** video_continuous_2_sec_watched_actions. Null when absent. */
  video_continuous_2s_views: number | null
  /** 'video_play_actions' | 'video_continuous_2_sec' | 'unavailable'. p25 is never a valid source. */
  early_view_source: string | null
  /** Raw inputs preserved for any derived rate whose raw relationship was impossible. */
  derived_metric_warnings: Record<string, unknown>[] | null
  video_thru_plays: number | null
  video_avg_play_time: number | null
  video_p25_watched: number | null
  video_p50_watched: number | null
  video_p75_watched: number | null
  video_p100_watched: number | null

  actions: MetaAction[] | null
  action_values: MetaAction[] | null
  /** NULL = not captured (row predates 2026-08-31 or Meta omitted it), NOT an empty result. */
  conversion_values: MetaAction[] | null
  /** Portion of appointment_value from 1d_view. 0 = a measured zero (Meta omits zero-valued windows). NULL = no window breakdown at all. */
  appointment_value_view_through: number | null
  cost_per_action_type: MetaAction[] | null

  synced_at: string
}

// ============================================================
// Nested type for daily_reports.report_json
// ============================================================
export interface KeyMetrics {
  spend: number
  leads: number
  bookings: number
  cpl: number | null
  cpb: number | null
  ctr: number | null
  cpm: number | null
  impressions: number
  clicks: number
}

export interface MetricDelta {
  value: number
  delta_pct: number | null
  direction: 'up' | 'down' | 'flat'
}

export interface CampaignSummary {
  campaign_id: string
  campaign_name: string | null
  spend: number
  leads: number
  cpl: number | null
  status: string | null
}

export interface AdSummary {
  ad_id: string
  ad_name: string | null
  spend: number
  leads: number
  cpl: number | null
  ctr: number | null
}

export interface AlertSummary {
  alert_type: AlertType
  severity: AlertSeverity
  title: string
  message: string
}

export interface ReportJson {
  account_id: string
  report_date: string
  period: { start: string; end: string }
  key_metrics: KeyMetrics
  deltas: Record<string, MetricDelta>
  top_campaigns: CampaignSummary[]
  top_ads: AdSummary[]
  alerts: AlertSummary[]
  recommendations: string[]
  /** Persisted deterministic digest. Historical rows may carry v1/v2; current reports write v3,
   *  so readers keep the explicit union without reinterpreting older evidence. */
  dailyDigest?: DailyDigest | DailyDigestV2 | DailyDigestV3
}

// ============================================================
// Table: daily_reports
// ============================================================
export interface DailyReport {
  id: string
  ad_account_id: string
  report_date: string
  summary_text: string | null
  full_report_md: string | null
  report_json: ReportJson | null
  total_spend: number | null
  total_leads: number | null
  total_bookings: number | null
  avg_cpl: number | null
  avg_cpb: number | null
  model_used: string | null
  prompt_tokens: number | null
  completion_tokens: number | null
  generation_ms: number | null
  generated_at: string
}

// ============================================================
// Table: alerts
// ============================================================
export interface Alert {
  id: string
  ad_account_id: string
  alert_date: string
  entity_level: EntityLevel | null
  campaign_id: string | null
  adset_id: string | null
  ad_id: string | null
  meta_campaign_id: string | null
  meta_adset_id: string | null
  meta_ad_id: string | null
  alert_type: AlertType
  severity: AlertSeverity
  title: string
  message: string
  metric_name: string | null
  metric_value: number | null
  threshold_value: number | null
  baseline_value: number | null
  is_resolved: boolean
  resolved_at: string | null
  resolved_by: string | null
  resolution_note: string | null
  detected_at: string
  created_at: string
}

// ============================================================
// Table: audit_tasks
// ============================================================
export interface AuditTask {
  id: string
  ad_account_id: string
  report_id: string | null
  alert_id: string | null
  entity_level: EntityLevel | null
  campaign_id: string | null
  adset_id: string | null
  ad_id: string | null
  title: string
  description: string | null
  recommendation: string | null
  priority: TaskPriority
  status: TaskStatus
  due_date: string | null
  completed_at: string | null
  completed_by: string | null
  completion_note: string | null
  created_at: string
  updated_at: string
}

// ============================================================
// Table: api_sync_logs
// ============================================================
export interface ApiSyncLog {
  id: string
  ad_account_id: string | null
  sync_type: string
  entity_level: EntityLevel | null
  date_range_start: string | null
  date_range_end: string | null
  status: SyncStatus
  triggered_by: string
  started_at: string | null
  completed_at: string | null
  duration_ms: number | null
  accounts_fetched: number
  campaigns_fetched: number
  adsets_fetched: number
  ads_fetched: number
  creatives_fetched: number
  insights_fetched: number
  error_message: string | null
  error_code: string | null
  error_details: Record<string, unknown> | null
  api_calls_made: number
  rate_limit_hit: boolean
  retry_count: number
  created_at: string
}

// ============================================================
// Table: paid_cohort_completeness_manifests
// ============================================================
export interface PaidCohortCompletenessManifest {
  id: string
  ad_account_id: string
  evaluation_run_id: string
  cohort_kind: PaidCohortKind
  window_start: string
  window_end: string
  source_not_before: string
  capture_completed_at: string
  linker_completed_at: string
  contract_version: 1
  policy_version: 1
  capture_complete: boolean
  linker_complete: boolean
  capture_eligible_inputs: number
  captured_touches: number
  eligible_outcomes: number
  evaluated_outcomes: number
  linked_outcomes: number
  blocker_codes: string[]
  created_at: string
}

// ============================================================
// Table: flags
// ============================================================
export interface Flag {
  id: string
  ad_account_id: string
  flag_date: string
  window_days: number
  entity_level: EntityLevel
  campaign_id: string | null
  adset_id: string | null
  ad_id: string | null
  meta_campaign_id: string | null
  meta_adset_id: string | null
  meta_ad_id: string | null
  flag_type: FlagType
  confidence: FlagConfidence
  audience_type: AudienceType
  reason: string
  evidence: Record<string, unknown> | null
  recommended_action: string | null
  watch_next: string | null
  spend_in_window: number | null
  cpa_in_window: number | null
  ctr_in_window: number | null
  frequency_in_window: number | null
  is_active: boolean
  superseded_at: string | null
  created_at: string
}

// ============================================================
// Table: tests
// ============================================================
export interface Test {
  id: string
  ad_account_id: string
  test_name: string
  hypothesis: string
  audience_type: AudienceType
  funnel_stage: string | null
  test_type: string
  status: TestStatus
  creative_angle: string | null
  assets_needed: string | null
  budget_daily: number | null
  kpi_target: string | null
  min_spend_threshold: number | null
  runtime_days: number | null
  kill_rule: string | null
  keep_rule: string | null
  scale_rule: string | null
  meta_campaign_id: string | null
  meta_adset_id: string | null
  result_summary: string | null
  next_recommendation: string | null
  started_at: string | null
  ended_at: string | null
  created_at: string
  updated_at: string
}

// ============================================================
// Table: creative_briefs
// ============================================================
export interface CreativeBrief {
  id: string
  ad_account_id: string
  test_id: string | null
  title: string
  audience_type: AudienceType
  funnel_stage: string | null
  format: string | null
  angle: string | null
  hook: string | null
  concept: string | null
  script: string | null
  shot_list: string | null
  on_screen_text: string | null
  caption: string | null
  headline: string | null
  cta_text: string | null
  visual_direction: string | null
  why_it_works: string | null
  kpi_to_judge: string | null
  runtime_days: number | null
  winner_criteria: string | null
  loser_criteria: string | null
  status: BriefStatus
  generated_by: string | null
  model_used: string | null
  created_at: string
  updated_at: string
}

// ============================================================
// Table: copy_variations
// ============================================================
export interface CopyVariation {
  id: string
  ad_account_id: string
  brief_id: string | null
  copy_type: string
  audience_type: AudienceType
  angle: string | null
  copy_text: string
  char_count: number | null
  is_approved: boolean
  is_used: boolean
  performance_notes: string | null
  model_used: string | null
  created_at: string
}

// ============================================================
// Table: competitor_sources
// ============================================================
export interface CompetitorSource {
  id: string
  ad_account_id: string
  name: string
  location: string | null
  website_url: string | null
  instagram_url: string | null
  tiktok_url: string | null
  facebook_url: string | null
  google_business_url: string | null
  meta_ads_library_url: string | null
  hourly_rate_low: number | null
  hourly_rate_high: number | null
  size_sqft: number | null
  notes: string | null
  is_active: boolean
  last_researched_at: string | null
  created_at: string
  updated_at: string
}

// ============================================================
// Table: competitor_observations
// ============================================================
export interface CompetitorObservation {
  id: string
  competitor_id: string
  ad_account_id: string
  observed_at: string
  source: string | null
  observation_type: string | null
  summary: string
  raw_content: string | null
  hook_text: string | null
  offer_text: string | null
  creative_format: string | null
  suggested_test: string | null
  what_to_learn: string | null
  what_not_to_copy: string | null
  created_at: string
}

// ============================================================
// Table: expert_sources
// ============================================================
export interface ExpertSource {
  id: string
  ad_account_id: string
  name: string
  platform: string | null
  url: string | null
  description: string | null
  relevance_notes: string | null
  is_active: boolean
  last_checked_at: string | null
  created_at: string
}

// ============================================================
// Table: expert_insights (with owner review gate)
// ============================================================
export interface ExpertInsight {
  id: string
  source_id: string | null
  ad_account_id: string
  published_at: string | null
  title: string
  summary: string
  raw_content: string | null
  applies_to_account: boolean
  why_it_applies: string | null
  suggested_action: string | null
  /** Relevance routing: creative | budget | null (area-agnostic). Written by the signals fetcher. */
  applicable_area: string | null
  /** Fetcher's relevance confidence: high | medium | low. */
  confidence: string | null
  /** Hard TTL — insight is not citable past this date (fetcher sets ingest+90d). */
  expires_at: string | null
  /** Owner review gate: pending | approved | rejected. Only approved is citable. */
  review_status: string | null
  reviewed_at: string | null
  reviewed_note: string | null
  created_at: string
}

// ============================================================
// Table: memory_entries
// ============================================================
export interface MemoryEntry {
  id: string
  ad_account_id: string
  category: string
  key: string
  value: string
  source: string | null
  confidence: FlagConfidence
  is_active: boolean
  expires_at: string | null
  created_at: string
  updated_at: string
}

// ============================================================
// Table: app_settings
// ============================================================
export interface AppSetting {
  id: string
  ad_account_id: string
  key: string
  value: string
  setting_type: SettingType
  label: string | null
  description: string | null
  updated_at: string
}

// ============================================================
// Well-known app_settings keys (type-safe reference)
// ============================================================
export const SETTINGS_KEYS = {
  TARGET_CPA: 'target_cpa',
  AVG_ORDER_VALUE: 'avg_order_value',
  MAIN_CONVERSION_EVENT: 'main_conversion_event',
  READ_ONLY_MODE: 'read_only_mode',
  WEEKLY_AUTO_SYNC: 'weekly_auto_sync',
  BRAND_TONE: 'brand_tone',
  PIXEL_ID: 'pixel_id',
  INSTAGRAM_HANDLE: 'instagram_handle',
  FACEBOOK_PAGE_ID: 'facebook_page_id',
  BUSINESS_ID: 'business_id',
  COMPETITOR_TRACKING: 'competitor_tracking_enabled',
  EXPERT_TRACKER: 'expert_tracker_enabled',
  APPROVED_WRITE_MODE: 'approved_write_mode',
  MEDIA_BUYER_RECOMMENDATIONS: 'media_buyer_recommendations_enabled',
} as const

export type SettingKey = typeof SETTINGS_KEYS[keyof typeof SETTINGS_KEYS]
