export type MetaSetupEntityLevelV1 = 'campaign' | 'adset' | 'ad' | 'audience' | 'creative'

export type SetupChangeTypeV1 = 'added' | 'removed' | 'updated'

export type SetupChangeReasonStatusV1 = 'reason_unknown' | 'matched_approved_plan'

export interface NormalizedMetaSetupSnapshotV1 {
  contract_version: 1
  entity_level: MetaSetupEntityLevelV1
  entity_db_id: string | null
  meta_entity_id: string
  parent_meta_ids: {
    campaign_id?: string | null
    adset_id?: string | null
    creative_id?: string | null
  }
  config: Record<string, unknown>
  config_fingerprint: string
  observed_synced_at: string | null
}

export interface MetaSetupGenerationV1 {
  contractVersion: 1
  generationId: string
  adAccountId: string
  syncLogId: string | null
  observedAt: string
  complete: boolean
  blockerCodes: string[]
  entityCount: number
  generationFingerprint: string
}

export interface SetupChangePlanExpectedChangeV1 {
  entity_level: MetaSetupEntityLevelV1
  meta_entity_id: string
  field_path: string
  before_value?: unknown
  after_value?: unknown
  reason: string
}

export interface SetupChangePlanV1 {
  contractVersion: 1
  planId: string
  adAccountId: string
  sourceKind: string
  sourceId: string
  approvedAt: string
  approvedBy: string
  expectedChanges: SetupChangePlanExpectedChangeV1[]
  planFingerprint: string
}

export interface SetupMaterialChangeV1 {
  id?: string
  ad_account_id: string
  from_generation_id: string | null
  to_generation_id: string
  entity_level: MetaSetupEntityLevelV1
  meta_entity_id: string
  change_type: SetupChangeTypeV1
  field_path: string
  before_value: unknown
  after_value: unknown
  reason_status: SetupChangeReasonStatusV1
  approved_plan_id: string | null
  reason: string | null
}

export type LatestSetupMaterialChangeV1 =
  | {
      status: 'known'
      governanceBasis: 'matched_approved_plan' | 'confirmed_executed_decision'
      materialChangeId: string
      materialChangeIds: string[]
      occurredAt: string
      reason: string
      source: 'ad_setup_decisions' | 'meta_observation'
      settingCategories: string[]
      affectedMetaIds: string[]
    }
  | { status: 'unknown'; occurredAt: string | null; reasonCode: string }
  | { status: 'none_observed'; through: string }
