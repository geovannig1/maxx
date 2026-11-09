import type { AudienceRef, AudienceResolution, Tri } from '@/lib/audience/resolver'
import type { AudienceInventoryReadHealth } from '@/lib/diagnostics/launch-performance'
import type { LatestSetupMaterialChangeV1 } from '@/lib/setup-history'

export type SetupComparisonRole = 'cold' | 'warm' | 'other'
export type SetupComparisonRoleSource = 'campaign_plan' | 'owner_declared' | 'display_name_hint'

export interface SetupCampaignRow {
  id: string
  campaign_id: string
  campaign_name: string | null
  objective: string | null
  status: string | null
  effective_status: string | null
  buying_type: string | null
  special_ad_category: string | null
  daily_budget: number | null
  lifetime_budget: number | null
  advantage_plus_campaign?: boolean | null
  last_synced_at: string | null
}

export interface SetupAdsetRow {
  id: string
  campaign_id: string
  adset_id: string
  adset_name: string | null
  comparison_role?: SetupComparisonRole | null
  comparison_role_source?: SetupComparisonRoleSource | null
  status: string | null
  effective_status: string | null
  optimization_goal: string | null
  promoted_object: Record<string, unknown> | null
  attribution_spec: unknown
  daily_budget: number | null
  lifetime_budget: number | null
  bid_amount: number | null
  bid_strategy: string | null
  targeting: Record<string, unknown> | null
  targeting_last_synced_at: string | null
  targeting_optimization_types: Array<{ key: string; value: number }> | null
  learning_stage: string | null
  last_sig_edit_ts: string | null
  meta_created_time: string | null
  meta_updated_time: string | null
  last_synced_at: string | null
}

export interface SetupAdRow {
  id: string
  campaign_id: string
  adset_id: string
  creative_id: string | null
  ad_id: string
  ad_name: string | null
  status: string | null
  effective_status: string | null
  destination_url: string | null
  destination_url_read_available?: boolean | null
  destination_url_synced_at?: string | null
  url_tags: string | null
  creative_angle: string | null
  meta_creative_id: string | null
  meta_created_time: string | null
  meta_updated_time: string | null
  last_synced_at: string | null
}

export interface SetupCreativeRow {
  id: string
  creative_id: string
  asset_type: string | null
  video_id: string | null
  image_hash: string | null
  link_url: string | null
  url_tags: string | null
  object_story_spec: Record<string, unknown> | null
  asset_feed_spec: Record<string, unknown> | null
  meta_created_time: string | null
  last_synced_at: string | null
}

export interface MetaSetupEvidenceInput {
  as_of: string
  ad_account_db_id: string
  meta_account_id: string
  audience_inventory: AudienceInventoryReadHealth
  audiences_by_id: Record<string, AudienceRef>
  campaigns: SetupCampaignRow[]
  adsets: SetupAdsetRow[]
  /** Account-scoped active and historical wrappers. Historical rows prove media reuse. */
  ads: SetupAdRow[]
  creatives: SetupCreativeRow[]
  latest_material_change: LatestSetupMaterialChangeV1
}

export type SetupEvidenceBlockerCode =
  | 'active_campaign_missing'
  | 'active_adset_missing'
  | 'active_ad_missing'
  | 'objective_unknown'
  | 'campaign_advantage_plus_unknown'
  | 'optimization_event_unknown'
  | 'attribution_unknown'
  | 'budget_unknown'
  | 'bid_strategy_unknown'
  | 'placements_unknown'
  | 'setup_snapshot_stale'
  | 'audience_inventory_read_failed'
  | 'audience_targeting_unavailable_or_stale'
  | 'audience_reference_unhealthy'
  | 'comparison_role_cardinality'
  | 'comparison_roles_unverified'
  | 'audience_expansion_enabled'
  | 'audience_expansion_unknown'
  | 'targeting_relaxations_unknown'
  | 'comparison_objective_mismatch'
  | 'comparison_optimization_goal_mismatch'
  | 'comparison_optimization_event_mismatch'
  | 'comparison_attribution_mismatch'
  | 'comparison_bid_mismatch'
  | 'comparison_placements_mismatch'
  | 'comparison_targeting_relaxations_mismatch'
  | 'warm_inventory_not_pure'
  | 'cold_inventory_not_prospecting'
  | 'cold_warm_overlap_not_excluded'
  | 'latest_material_change_reason_unknown'
  | 'landing_destination_unknown'
  | 'ad_destination_read_unavailable'
  | 'creative_identity_unknown'
  | 'wrapper_change_relationship_unknown'
  | 'setup_generation_unavailable'
  | 'setup_generation_stale'
  | 'setup_generation_current_run_mismatch'
  | 'custom_audience_sync_failed'
  | 'creative_sync_failed'
  | 'creative_inventory_incomplete'

export interface AudienceHealthEvidence {
  id: string
  name: string | null
  subtype: string | null
  source_audience_id: string | null
  source_audience_name: string | null
  approximate_count_lower_bound: number | null
  approximate_count_upper_bound: number | null
  retention_days: number | null
  operation_status_code: number | null
  delivery_status_code: number | null
  last_synced_at: string | null
  status: 'ready' | 'failed' | 'stale' | 'cross_account' | 'unknown'
  reason: string | null
}

export interface SetupAudienceEvidence extends AudienceResolution {
  health: AudienceHealthEvidence[]
  inventory_read: AudienceInventoryReadHealth
}

export interface SetupCampaignEvidence {
  meta_campaign_id: string
  name: string | null
  objective: string | null
  buying_type: string | null
  special_ad_category: string | null
  budget_control: 'cbo' | 'abo' | 'unknown'
  budget: { daily_amount: number | null; lifetime_amount: number | null }
  advantage_plus_campaign: Tri
  last_synced_at: string | null
}

export interface SetupAdsetEvidence {
  meta_adset_id: string
  meta_campaign_id: string
  name: string | null
  comparison_role: SetupComparisonRole | null
  comparison_role_source: SetupComparisonRoleSource | null
  objective: string | null
  optimization_goal: string | null
  optimization_event: string | null
  attribution_spec: unknown[] | null
  budget: { daily_amount: number | null; lifetime_amount: number | null }
  bid: { strategy: string | null; amount: number | null }
  placements: {
    mode: 'advantage_plus' | 'manual' | 'unknown'
    selected: Record<string, string[]>
  }
  advantage_plus: {
    audience: Tri
    placements: Tri
    observed_targeting_relaxations: Array<{ key: string; value: number }> | null
  }
  audience: SetupAudienceEvidence
  learning_stage: string | null
  latest_significant_edit_at: string | null
  last_synced_at: string | null
}

export interface LandingDestinationEvidence {
  url: string | null
  source: 'ad_destination_url' | 'creative_link_url' | 'object_story_spec' | 'unknown'
  url_tags: string | null
  utm_status: 'present' | 'missing' | 'unknown'
  ad_level_read_available: boolean
  ad_level_synced_at: string | null
}

export interface ActiveAdWrapperEvidence {
  meta_ad_id: string
  meta_adset_id: string
  name: string | null
  meta_creative_id: string | null
  concept_id: string | null
  wrapper_created_at: string | null
  wrapper_updated_at: string | null
  wrapper_relationship_to_latest_change: 'created_at_or_after' | 'predates' | 'unknown'
  landing_destination: LandingDestinationEvidence
  underlying_media: {
    status: 'reused' | 'not_observed_reused' | 'unknown'
    media_key: string | null
    media_kind: 'video' | 'image' | 'carousel' | 'unknown'
    other_meta_ad_ids: string[]
    predates_latest_change: boolean | null
  }
  identity_summary:
    | 'new_wrapper_reused_media'
    | 'new_wrapper_shared_media'
    | 'new_wrapper_media_reuse_not_observed'
    | 'existing_wrapper_reused_media'
    | 'existing_wrapper_media_reuse_not_observed'
    | 'identity_unknown'
}

export interface MetaSetupEvidenceProjection {
  contract_version: 1
  as_of: string
  ad_account_db_id: string
  meta_account_id: string
  status: 'available' | 'blocked'
  complete: boolean
  blocker_codes: SetupEvidenceBlockerCode[]
  campaigns: SetupCampaignEvidence[]
  adsets: SetupAdsetEvidence[]
  active_ad_wrappers: ActiveAdWrapperEvidence[]
  creative_reuse: {
    distinct_active_ad_wrappers: number
    distinct_active_meta_creative_ids: number
    /** Exact active-media cardinality; null when any active wrapper lacks media identity. */
    distinct_active_media: number | null
    concept_coverage_complete: boolean
    distinct_known_concepts: number | null
    reused_meta_creative_id_groups: Array<{ meta_creative_id: string; meta_ad_ids: string[] }>
    reused_media_groups: Array<{ media_key: string; meta_ad_ids: string[]; spans_active_adsets: boolean }>
    reused_concept_groups: Array<{ concept_id: string; meta_ad_ids: string[] }>
  }
  cold_warm_comparison: {
    status: 'clean' | 'blocked'
    cold_meta_adset_id: string | null
    warm_meta_adset_id: string | null
    role_basis: 'governed' | 'display_name_only' | 'unresolved'
    blocker_codes: SetupEvidenceBlockerCode[]
  }
  latest_material_change: LatestSetupMaterialChangeV1
  action_authority_tier: 'diagnostic_only'
  prescriptions: []
}
