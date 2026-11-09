import { randomUUID } from 'node:crypto'
import type { MetaSetupGenerationV1, NormalizedMetaSetupSnapshotV1, SetupChangePlanV1 } from './types'
import {
  buildMetaSetupGenerationFingerprint,
  deriveMaterialSetupChanges,
  normalizeAdSetupSnapshot,
  normalizeAdsetSetupSnapshot,
  normalizeAudienceSetupSnapshot,
  normalizeCampaignSetupSnapshot,
  normalizeCreativeSetupSnapshot,
  sha256Fingerprint,
} from './normalize'

type QueryResult<T> = PromiseLike<{ data: T[] | null; error: { message?: string } | null }>

interface SupabaseLike {
  from(table: string): {
    select(columns: string): unknown
    insert(payload: unknown): PromiseLike<{ data?: unknown[] | null; error: { message?: string } | null }>
  }
  rpc?: (
    name: string,
    args: Record<string, unknown>,
  ) => PromiseLike<{ data?: unknown; error: { message?: string; code?: string } | null }>
}

type Selectable = {
  eq(column: string, value: unknown): Selectable
  order(column: string, options?: { ascending?: boolean }): Selectable
  limit(count: number): Selectable
} & QueryResult<Record<string, unknown>>

const CAMPAIGN_COLUMNS = [
  'id', 'ad_account_id', 'campaign_id', 'campaign_name', 'objective', 'status', 'effective_status',
  'buying_type', 'special_ad_category', 'daily_budget', 'lifetime_budget', 'start_time', 'stop_time',
  'last_synced_at',
].join(',')
const ADSET_COLUMNS = [
  'id', 'ad_account_id', 'campaign_id', 'adset_id', 'adset_name', 'status', 'effective_status',
  'optimization_goal', 'billing_event', 'destination_type', 'promoted_object', 'targeting',
  'targeting_optimization_types', 'attribution_spec', 'daily_budget', 'lifetime_budget', 'bid_amount', 'bid_strategy',
  'learning_stage', 'last_sig_edit_ts', 'start_time', 'end_time', 'meta_created_time',
  'meta_updated_time', 'last_synced_at', 'targeting_last_synced_at',
].join(',')
const AD_COLUMNS = [
  'id', 'ad_account_id', 'campaign_id', 'adset_id', 'creative_id', 'meta_creative_id', 'ad_id',
  'ad_name', 'status', 'effective_status', 'destination_url', 'destination_url_read_available',
  'destination_url_synced_at', 'url_tags', 'creative_angle', 'review_feedback', 'issues_info',
  'tracking_specs', 'conversion_specs', 'meta_created_time', 'meta_updated_time', 'last_synced_at',
].join(',')
const CREATIVE_COLUMNS = [
  'id', 'ad_account_id', 'creative_id', 'creative_name', 'body', 'title', 'description',
  'call_to_action_type', 'link_url', 'url_tags', 'display_url', 'instagram_permalink_url',
  'asset_type', 'image_url', 'image_hash', 'video_id', 'thumbnail_url', 'child_attachments',
  'object_story_spec', 'asset_feed_spec', 'meta_created_time', 'last_synced_at',
].join(',')
const AUDIENCE_COLUMNS = [
  'id', 'ad_account_id', 'audience_id', 'name', 'subtype', 'meta_account_id', 'source_audience_id',
  'source_audience_name', 'approximate_count', 'approximate_count_lower_bound',
  'approximate_count_upper_bound', 'retention_days', 'lookalike_spec', 'operation_status',
  'delivery_status', 'meta_updated_at', 'last_synced_at',
].join(',')

function selectAccountRows(db: SupabaseLike, table: string, columns: string, adAccountId: string): QueryResult<Record<string, unknown>> {
  return (db.from(table).select(columns) as Selectable).eq('ad_account_id', adAccountId)
}

async function readRows(db: SupabaseLike, table: string, columns: string, adAccountId: string): Promise<Record<string, unknown>[]> {
  const { data, error } = await selectAccountRows(db, table, columns, adAccountId)
  if (error) throw new Error(`setup-history ${table} read failed: ${error.message ?? 'unknown error'}`)
  return data ?? []
}

function addParentMetaIds(input: {
  campaigns: Record<string, unknown>[]
  adsets: Record<string, unknown>[]
  creatives: Record<string, unknown>[]
  ads: Record<string, unknown>[]
}) {
  const campaignByDbId = new Map(input.campaigns.map((row) => [row.id, row.campaign_id]))
  const adsetByDbId = new Map(input.adsets.map((row) => [row.id, row.adset_id]))
  const creativeByDbId = new Map(input.creatives.map((row) => [row.id, row.creative_id]))

  return {
    adsets: input.adsets.map((row) => ({ ...row, campaign_meta_id: campaignByDbId.get(row.campaign_id) ?? null })),
    ads: input.ads.map((row) => ({
      ...row,
      campaign_meta_id: campaignByDbId.get(row.campaign_id) ?? null,
      adset_meta_id: adsetByDbId.get(row.adset_id) ?? null,
      creative_meta_id: creativeByDbId.get(row.creative_id) ?? null,
    })),
  }
}

async function readPreviousGeneration(db: SupabaseLike, adAccountId: string): Promise<Record<string, unknown> | null> {
  const query = (db.from('meta_setup_generations').select(
    'id, ad_account_id, observed_at, generation_fingerprint, entity_count',
  ) as Selectable)
    .eq('ad_account_id', adAccountId)
    .eq('complete', true)
    .order('observed_at', { ascending: false })
    .limit(1)
  const { data, error } = await query
  if (error) throw new Error(`setup-history previous generation read failed: ${error.message ?? 'unknown error'}`)
  return data?.[0] ?? null
}

async function readGenerationSnapshots(
  db: SupabaseLike,
  generationId: string | null,
): Promise<NormalizedMetaSetupSnapshotV1[]> {
  if (!generationId) return []
  const query = (db.from('meta_setup_entity_snapshots').select(
    'generation_id, ad_account_id, contract_version, entity_level, entity_db_id, meta_entity_id, parent_meta_ids, config, config_fingerprint, observed_synced_at',
  ) as Selectable).eq('generation_id', generationId)
  const { data, error } = await query
  if (error) throw new Error(`setup-history snapshot read failed: ${error.message ?? 'unknown error'}`)
  return (data ?? []) as unknown as NormalizedMetaSetupSnapshotV1[]
}

async function readApprovedPlans(db: SupabaseLike, adAccountId: string): Promise<SetupChangePlanV1[]> {
  const { data, error } = await selectAccountRows(
    db,
    'setup_change_plans',
    'id, ad_account_id, source_kind, source_id, approved_at, approved_by, plan, plan_fingerprint',
    adAccountId,
  )
  if (error) throw new Error(`setup-history approved plan read failed: ${error.message ?? 'unknown error'}`)

  return (data ?? []).map((row) => ({
    contractVersion: 1,
    planId: String(row.id),
    adAccountId: String(row.ad_account_id),
    sourceKind: String(row.source_kind),
    sourceId: String(row.source_id),
    approvedAt: String(row.approved_at),
    approvedBy: String(row.approved_by),
    expectedChanges: Array.isArray((row.plan as { expected_changes?: unknown })?.expected_changes)
      ? ((row.plan as { expected_changes: SetupChangePlanV1['expectedChanges'] }).expected_changes)
      : [],
    planFingerprint: String(row.plan_fingerprint ?? sha256Fingerprint(row.plan ?? {})),
  }))
}

export async function captureMetaSetupGeneration(
  db: SupabaseLike,
  params: {
    adAccountId: string
    syncLogId?: string | null
    observedAt?: string
    sourceNotBefore?: string
    blockerCodes?: string[]
  },
): Promise<MetaSetupGenerationV1> {
  const observedAt = params.observedAt ?? new Date().toISOString()
  const generationId = randomUUID()
  const blockerCodes = [...new Set(params.blockerCodes ?? [])].sort()
  const complete = blockerCodes.length === 0

  const [allCampaigns, allAdsets, allAds, allCreatives, allAudiences, previousGeneration, approvedPlans] = await Promise.all([
    readRows(db, 'campaigns', CAMPAIGN_COLUMNS, params.adAccountId),
    readRows(db, 'adsets', ADSET_COLUMNS, params.adAccountId),
    readRows(db, 'ads', AD_COLUMNS, params.adAccountId),
    readRows(db, 'creatives', CREATIVE_COLUMNS, params.adAccountId),
    readRows(db, 'custom_audiences', AUDIENCE_COLUMNS, params.adAccountId),
    readPreviousGeneration(db, params.adAccountId),
    readApprovedPlans(db, params.adAccountId),
  ])

  const sourceBoundary = params.sourceNotBefore ? Date.parse(params.sourceNotBefore) : null
  if (params.sourceNotBefore && !Number.isFinite(sourceBoundary)) {
    throw new Error('setup-history source boundary is invalid')
  }
  const currentRows = (rows: Record<string, unknown>[]) => sourceBoundary === null
    ? rows
    : rows.filter((row) => {
        const syncedAt = Date.parse(String(row.last_synced_at ?? ''))
        return Number.isFinite(syncedAt) && syncedAt >= sourceBoundary
      })
  const campaigns = currentRows(allCampaigns)
  const rawAdsets = currentRows(allAdsets)
  const rawAds = currentRows(allAds)
  const creatives = currentRows(allCreatives)
  const audiences = currentRows(allAudiences)

  const enriched = addParentMetaIds({ campaigns, adsets: rawAdsets, ads: rawAds, creatives })
  const snapshots = [
    ...campaigns.map(normalizeCampaignSetupSnapshot),
    ...enriched.adsets.map(normalizeAdsetSetupSnapshot),
    ...enriched.ads.map(normalizeAdSetupSnapshot),
    ...audiences.map(normalizeAudienceSetupSnapshot),
    ...creatives.map(normalizeCreativeSetupSnapshot),
  ].sort((a, b) => `${a.entity_level}:${a.meta_entity_id}`.localeCompare(`${b.entity_level}:${b.meta_entity_id}`))

  const generationFingerprint = buildMetaSetupGenerationFingerprint(snapshots)
  const previousGenerationId = typeof previousGeneration?.id === 'string' ? previousGeneration.id : null
  const previousSnapshots = await readGenerationSnapshots(db, previousGenerationId)
  const changes = previousGenerationId && complete
    ? deriveMaterialSetupChanges({
        adAccountId: params.adAccountId,
        fromGenerationId: previousGenerationId,
        toGenerationId: generationId,
        before: previousSnapshots,
        after: snapshots,
        approvedPlans,
      })
    : []

  const generationRow = {
    id: generationId,
    ad_account_id: params.adAccountId,
    sync_log_id: params.syncLogId ?? null,
    contract_version: 1,
    observed_at: observedAt,
    source_kind: 'meta_sync_snapshot',
    complete,
    blocker_codes: blockerCodes,
    entity_count: snapshots.length,
    generation_fingerprint: generationFingerprint,
  }
  const snapshotRows = snapshots.map((row) => ({
    generation_id: generationId,
    ad_account_id: params.adAccountId,
    ...row,
  }))

  if (db.rpc) {
    const { error } = await db.rpc('commit_meta_setup_generation', {
      p_generation: generationRow,
      p_snapshots: snapshotRows,
      p_changes: changes,
    })
    if (error) throw new Error(`setup-history atomic commit failed: ${error.message ?? 'unknown error'}`)
  } else {
    const { error: generationError } = await db.from('meta_setup_generations').insert(generationRow)
    if (generationError) throw new Error(`setup-history generation insert failed: ${generationError.message ?? 'unknown error'}`)

    if (snapshotRows.length > 0) {
      const { error } = await db.from('meta_setup_entity_snapshots').insert(snapshotRows)
      if (error) throw new Error(`setup-history snapshot insert failed: ${error.message ?? 'unknown error'}`)
    }

    if (changes.length > 0) {
      const { error } = await db.from('setup_material_changes').insert(changes)
      if (error) throw new Error(`setup-history material change insert failed: ${error.message ?? 'unknown error'}`)
    }
  }

  return {
    contractVersion: 1,
    generationId,
    adAccountId: params.adAccountId,
    syncLogId: params.syncLogId ?? null,
    observedAt,
    complete,
    blockerCodes,
    entityCount: snapshots.length,
    generationFingerprint,
  }
}
