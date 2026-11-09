import type { SupabaseClient } from '@supabase/supabase-js'
import type { AudienceRef } from '@/lib/audience/resolver'
import {
  buildMetaSetupGenerationFingerprint,
  sha256Fingerprint,
  type NormalizedMetaSetupSnapshotV1,
} from '@/lib/setup-history'
import type {
  MetaSetupEvidenceInput,
  SetupAdRow,
  SetupCampaignRow,
  SetupCreativeRow,
} from './setup-evidence-types'

const PAGE_SIZE = 1_000
const MAX_PAGES = 20
const SETUP_ENTITY_LEVELS = new Set(['campaign', 'adset', 'ad', 'audience', 'creative'])

type Query = {
  eq(column: string, value: unknown): Query
  order(column: string, options?: { ascending?: boolean }): Query
  range(from: number, to: number): PromiseLike<{
    data: Record<string, unknown>[] | null
    error: { message: string } | null
  }>
}

export interface SetupProjectionGenerationRowV1 {
  id: string
  observed_at: string
  complete: boolean
  blocker_codes: string[]
  entity_count: number
  generation_fingerprint: string | null
}

export interface GenerationBoundSetupRowsV1 {
  campaigns: SetupCampaignRow[]
  adsets: Record<string, unknown>[]
  ads: SetupAdRow[]
  creatives: SetupCreativeRow[]
  audience: Pick<MetaSetupEvidenceInput, 'audience_inventory' | 'audiences_by_id'>
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
}

function objectOrNull(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function arrayOrNull<T>(value: unknown, guard: (entry: unknown) => entry is T): T[] | null {
  return Array.isArray(value) && value.every(guard) ? [...value] : null
}

function isTargetingOptimization(value: unknown): value is { key: string; value: number } {
  const row = objectOrNull(value)
  return Boolean(text(row?.key)) && typeof row?.value === 'number' && Number.isFinite(row.value)
}

function parseGenerationSnapshot(
  row: Record<string, unknown>,
  accountId: string,
  generationId: string,
): NormalizedMetaSetupSnapshotV1 {
  const level = text(row.entity_level)
  const metaEntityId = text(row.meta_entity_id)
  const entityDbId = row.entity_db_id === null ? null : text(row.entity_db_id)
  const parentMetaIds = objectOrNull(row.parent_meta_ids)
  const config = objectOrNull(row.config)
  const configFingerprint = text(row.config_fingerprint)
  const observedSyncedAt = row.observed_synced_at === null ? null : text(row.observed_synced_at)
  if (
    text(row.generation_id) !== generationId
    || text(row.ad_account_id) !== accountId
    || row.contract_version !== 1
    || !level
    || !SETUP_ENTITY_LEVELS.has(level)
    || !metaEntityId
    || !parentMetaIds
    || !config
    || !configFingerprint
    || (row.entity_db_id !== null && !entityDbId)
    || (row.observed_synced_at !== null && !observedSyncedAt)
  ) throw new Error('meta setup snapshot contains invalid generation-bound data')
  if (sha256Fingerprint(config) !== configFingerprint) {
    throw new Error(`meta setup snapshot config fingerprint mismatch: ${level}:${metaEntityId}`)
  }
  return {
    contract_version: 1,
    entity_level: level as NormalizedMetaSetupSnapshotV1['entity_level'],
    entity_db_id: entityDbId,
    meta_entity_id: metaEntityId,
    parent_meta_ids: parentMetaIds,
    config,
    config_fingerprint: configFingerprint,
    observed_synced_at: observedSyncedAt,
  }
}

async function readGenerationSnapshots(
  db: SupabaseClient,
  accountId: string,
  generationId: string,
): Promise<NormalizedMetaSetupSnapshotV1[]> {
  const rows: Record<string, unknown>[] = []
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const from = page * PAGE_SIZE
    const query = db.from('meta_setup_entity_snapshots').select(
      'id,generation_id,ad_account_id,contract_version,entity_level,entity_db_id,meta_entity_id,parent_meta_ids,config,config_fingerprint,observed_synced_at',
    ) as unknown as Query
    const result = await query
      .eq('ad_account_id', accountId)
      .eq('generation_id', generationId)
      .order('id', { ascending: true })
      .range(from, from + PAGE_SIZE - 1)
    if (result.error) throw new Error(`meta setup snapshots read failed: ${result.error.message}`)
    if (!Array.isArray(result.data)) throw new Error('meta setup snapshots read returned a non-array result')
    rows.push(...result.data)
    if (result.data.length < PAGE_SIZE) {
      return rows.map((row) => parseGenerationSnapshot(row, accountId, generationId))
    }
  }
  throw new Error(`meta setup snapshots read exceeded ${PAGE_SIZE * MAX_PAGES} rows`)
}

export async function readLatestProjectionGenerationV1(
  db: SupabaseClient,
  accountId: string,
): Promise<SetupProjectionGenerationRowV1 | null> {
  const result = await db
    .from('meta_setup_generations')
    .select('id,observed_at,complete,blocker_codes,entity_count,generation_fingerprint')
    .eq('ad_account_id', accountId)
    .order('observed_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(1)
  if (result.error) throw new Error(`meta setup generation read failed: ${result.error.message}`)
  if (!Array.isArray(result.data)) throw new Error('meta setup generation read returned a non-array result')
  const row = result.data[0] as Record<string, unknown> | undefined
  if (!row) return null
  const id = text(row.id)
  const observedAt = text(row.observed_at)
  const entityCount = row.entity_count
  const fingerprint = row.generation_fingerprint === null ? null : text(row.generation_fingerprint)
  const blockerCodesValid = Array.isArray(row.blocker_codes)
    && row.blocker_codes.every((item) => typeof item === 'string')
  if (
    !id
    || !observedAt
    || typeof row.complete !== 'boolean'
    || !blockerCodesValid
    || !Number.isSafeInteger(entityCount)
    || (entityCount as number) < 0
  ) {
    throw new Error('meta setup generation contains invalid projection metadata')
  }
  return {
    id,
    observed_at: observedAt,
    complete: row.complete === true,
    blocker_codes: [...row.blocker_codes as string[]],
    entity_count: entityCount as number,
    generation_fingerprint: fingerprint,
  }
}

function validateGenerationSnapshotSet(
  generation: SetupProjectionGenerationRowV1,
  snapshots: NormalizedMetaSetupSnapshotV1[],
): void {
  if (snapshots.length !== generation.entity_count) {
    throw new Error(
      `meta setup generation snapshot count mismatch: expected ${generation.entity_count}, read ${snapshots.length}`,
    )
  }
  const keys = snapshots.map((row) => `${row.entity_level}:${row.meta_entity_id}`)
  if (new Set(keys).size !== keys.length) {
    throw new Error('meta setup generation contains duplicate entity snapshots')
  }
  const computed = buildMetaSetupGenerationFingerprint(snapshots)
  if (!generation.generation_fingerprint || computed !== generation.generation_fingerprint) {
    throw new Error('meta setup generation fingerprint mismatch')
  }
}

function snapshotDbId(snapshot: NormalizedMetaSetupSnapshotV1): string {
  if (!snapshot.entity_db_id) {
    throw new Error(`meta setup snapshot is missing entity identity: ${snapshot.entity_level}:${snapshot.meta_entity_id}`)
  }
  return snapshot.entity_db_id
}

function activeConfig(config: Record<string, unknown>): boolean {
  return (text(config.effective_status) ?? text(config.status))?.toUpperCase() === 'ACTIVE'
}

function mapGenerationSetupRows(
  snapshots: NormalizedMetaSetupSnapshotV1[],
): GenerationBoundSetupRowsV1 {
  const byLevel = (level: NormalizedMetaSetupSnapshotV1['entity_level']) =>
    snapshots.filter((snapshot) => snapshot.entity_level === level)
  const campaignSnapshots = byLevel('campaign')
  const adsetSnapshots = byLevel('adset')
  const adSnapshots = byLevel('ad')
  const creativeSnapshots = byLevel('creative')
  const audienceSnapshots = byLevel('audience')
  const campaignDbIds = new Map(campaignSnapshots.map((row) => [row.meta_entity_id, snapshotDbId(row)]))
  const adsetDbIds = new Map(adsetSnapshots.map((row) => [row.meta_entity_id, snapshotDbId(row)]))
  const creativeDbIds = new Map(creativeSnapshots.map((row) => [row.meta_entity_id, snapshotDbId(row)]))
  const parentDbId = (
    snapshot: NormalizedMetaSetupSnapshotV1,
    parentKind: 'campaign_id' | 'adset_id',
    ids: Map<string, string>,
  ) => {
    const parentMetaId = text(snapshot.parent_meta_ids[parentKind])
    const parentId = parentMetaId ? ids.get(parentMetaId) : undefined
    if (!parentId && activeConfig(snapshot.config)) {
      throw new Error(`active meta setup snapshot is missing ${parentKind}: ${snapshot.entity_level}:${snapshot.meta_entity_id}`)
    }
    return parentId ?? ''
  }

  const campaigns: SetupCampaignRow[] = campaignSnapshots.map((snapshot) => ({
    id: snapshotDbId(snapshot), campaign_id: snapshot.meta_entity_id,
    campaign_name: text(snapshot.config.campaign_name), objective: text(snapshot.config.objective),
    status: text(snapshot.config.status), effective_status: text(snapshot.config.effective_status),
    buying_type: text(snapshot.config.buying_type),
    special_ad_category: text(snapshot.config.special_ad_category),
    daily_budget: numberOrNull(snapshot.config.daily_budget),
    lifetime_budget: numberOrNull(snapshot.config.lifetime_budget),
    advantage_plus_campaign: null, last_synced_at: snapshot.observed_synced_at,
  }))
  const adsets = adsetSnapshots.map((snapshot) => ({
    id: snapshotDbId(snapshot), campaign_id: parentDbId(snapshot, 'campaign_id', campaignDbIds),
    adset_id: snapshot.meta_entity_id, adset_name: text(snapshot.config.adset_name),
    status: text(snapshot.config.status), effective_status: text(snapshot.config.effective_status),
    optimization_goal: text(snapshot.config.optimization_goal),
    promoted_object: objectOrNull(snapshot.config.promoted_object),
    attribution_spec: snapshot.config.attribution_spec ?? null,
    daily_budget: numberOrNull(snapshot.config.daily_budget),
    lifetime_budget: numberOrNull(snapshot.config.lifetime_budget),
    bid_amount: numberOrNull(snapshot.config.bid_amount), bid_strategy: text(snapshot.config.bid_strategy),
    targeting: objectOrNull(snapshot.config.targeting),
    targeting_last_synced_at: snapshot.observed_synced_at,
    targeting_optimization_types: arrayOrNull(snapshot.config.targeting_optimization_types, isTargetingOptimization),
    learning_stage: text(snapshot.config.learning_stage),
    last_sig_edit_ts: text(snapshot.config.last_sig_edit_ts),
    meta_created_time: text(snapshot.config.meta_created_time),
    meta_updated_time: text(snapshot.config.meta_updated_time),
    last_synced_at: snapshot.observed_synced_at,
  }))
  const ads: SetupAdRow[] = adSnapshots.map((snapshot) => {
    const creativeMetaId = text(snapshot.parent_meta_ids.creative_id) ?? text(snapshot.config.meta_creative_id)
    const readAvailable = snapshot.config.destination_url_read_available
    return {
      id: snapshotDbId(snapshot), campaign_id: parentDbId(snapshot, 'campaign_id', campaignDbIds),
      adset_id: parentDbId(snapshot, 'adset_id', adsetDbIds),
      creative_id: creativeMetaId ? (creativeDbIds.get(creativeMetaId) ?? null) : null,
      ad_id: snapshot.meta_entity_id, ad_name: text(snapshot.config.ad_name),
      status: text(snapshot.config.status), effective_status: text(snapshot.config.effective_status),
      destination_url: text(snapshot.config.destination_url),
      destination_url_read_available: readAvailable === true ? true : readAvailable === false ? false : null,
      destination_url_synced_at: text(snapshot.config.destination_url_synced_at),
      url_tags: text(snapshot.config.url_tags), creative_angle: text(snapshot.config.creative_angle),
      meta_creative_id: creativeMetaId, meta_created_time: text(snapshot.config.meta_created_time),
      meta_updated_time: text(snapshot.config.meta_updated_time), last_synced_at: snapshot.observed_synced_at,
    }
  })
  const creatives: SetupCreativeRow[] = creativeSnapshots.map((snapshot) => ({
    id: snapshotDbId(snapshot), creative_id: snapshot.meta_entity_id,
    asset_type: text(snapshot.config.asset_type), video_id: text(snapshot.config.video_id),
    image_hash: text(snapshot.config.image_hash), link_url: text(snapshot.config.link_url),
    url_tags: text(snapshot.config.url_tags), object_story_spec: objectOrNull(snapshot.config.object_story_spec),
    asset_feed_spec: objectOrNull(snapshot.config.asset_feed_spec),
    meta_created_time: text(snapshot.config.meta_created_time), last_synced_at: snapshot.observed_synced_at,
  }))
  const audiencesById: Record<string, AudienceRef> = Object.fromEntries(
    audienceSnapshots.map((snapshot) => [snapshot.meta_entity_id, {
      id: snapshot.meta_entity_id, name: text(snapshot.config.name), subtype: text(snapshot.config.subtype),
      accountId: text(snapshot.config.meta_account_id),
      sourceAudienceId: text(snapshot.config.source_audience_id),
      sourceAudienceName: text(snapshot.config.source_audience_name),
      approximateCountLowerBound: numberOrNull(snapshot.config.approximate_count_lower_bound),
      approximateCountUpperBound: numberOrNull(snapshot.config.approximate_count_upper_bound),
      retentionDays: numberOrNull(snapshot.config.retention_days),
      operationStatus: snapshot.config.operation_status, deliveryStatus: snapshot.config.delivery_status,
      lastSyncedAt: snapshot.observed_synced_at,
    } satisfies AudienceRef]),
  )
  return {
    campaigns, adsets, ads, creatives,
    audience: {
      audience_inventory: {
        read_available: true, schema: 'rich', row_count: audienceSnapshots.length,
        reason_code: null, reason: null,
      },
      audiences_by_id: audiencesById,
    },
  }
}

export async function readValidatedGenerationSetupRowsV1(
  db: SupabaseClient,
  accountId: string,
  generation: SetupProjectionGenerationRowV1,
): Promise<GenerationBoundSetupRowsV1> {
  const snapshots = await readGenerationSnapshots(db, accountId, generation.id)
  validateGenerationSnapshotSet(generation, snapshots)
  return mapGenerationSetupRows(snapshots)
}
