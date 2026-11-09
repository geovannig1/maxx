import { createHash } from 'node:crypto'
import type {
  LatestSetupMaterialChangeV1,
  MetaSetupEntityLevelV1,
  NormalizedMetaSetupSnapshotV1,
  SetupChangePlanV1,
  SetupMaterialChangeV1,
} from './types'

type Row = Record<string, unknown>

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function canonicalize(value: unknown): unknown {
  if (value === undefined) return null
  if (Array.isArray(value)) {
    return value
      .map((entry) => canonicalize(entry))
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
  }
  if (!isPlainObject(value)) return value

  return Object.keys(value).sort().reduce<Record<string, unknown>>((acc, key) => {
    acc[key] = canonicalize(value[key])
    return acc
  }, {})
}

export function stableJson(value: unknown): string {
  return JSON.stringify(canonicalize(value))
}

export function sha256Fingerprint(value: unknown): string {
  return `sha256:${createHash('sha256').update(stableJson(value)).digest('hex')}`
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function configOf(row: Row, fields: string[]): Record<string, unknown> {
  return fields.reduce<Record<string, unknown>>((acc, field) => {
    acc[field] = canonicalize(row[field] ?? null)
    return acc
  }, {})
}

/** Fields that change without the advertiser changing anything, and therefore cannot be MATERIAL changes.
 *
 *  Two families, both seen polluting setup_material_changes, where nearly every recorded "change" was
 *  one of these and none were advertiser-initiated:
 *
 *  1. `*_synced_at` — a record of WHEN WE READ the entity. A field describing our own sync can never be a
 *     change to the ad. `destination_url_synced_at` alone marked almost every ad "updated" every sync.
 *  2. Signed Facebook CDN URLs (`thumbnail_url`, `image_url`, including nested ones such as
 *     `object_story_spec.video_data.image_url`). These rotate server-side on their own schedule. Asset
 *     IDENTITY is unaffected: `image_hash` and `video_id` stay in the config and still detect a real swap.
 *
 *  Applied at DIFF time, not at capture: the snapshot keeps the full config, because
 *  `destination_url_synced_at` is genuine read-provenance worth recording — it simply cannot be evidence
 *  that the ADVERTISER changed something. Storage stays complete and append-only history is untouched;
 *  only the comparison ignores these. Nested containers are stripped by VALUE too, since the differ
 *  compares arrays such as `asset_feed_spec.videos` wholesale and the rotation hides inside them. */
function isVolatileKey(key: string): boolean {
  return key.endsWith('_synced_at') || key === 'thumbnail_url' || key === 'image_url'
}

export function stripVolatile(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => stripVolatile(entry))
  if (!isPlainObject(value)) return value
  return Object.keys(value).reduce<Record<string, unknown>>((acc, key) => {
    if (isVolatileKey(key)) return acc
    acc[key] = stripVolatile(value[key])
    return acc
  }, {})
}

function snapshot(input: {
  row: Row
  level: MetaSetupEntityLevelV1
  metaIdField: string
  config: Record<string, unknown>
  observedSyncedAt?: string | null
  parentMetaIds?: NormalizedMetaSetupSnapshotV1['parent_meta_ids']
}): NormalizedMetaSetupSnapshotV1 {
  const metaEntityId = asString(input.row[input.metaIdField])
  if (!metaEntityId) {
    throw new Error(`setup-history: ${input.level} missing ${input.metaIdField}`)
  }
  const normalizedConfig = canonicalize(input.config) as Record<string, unknown>
  return {
    contract_version: 1,
    entity_level: input.level,
    entity_db_id: asString(input.row.id),
    meta_entity_id: metaEntityId,
    parent_meta_ids: canonicalize(input.parentMetaIds ?? {}) as NormalizedMetaSetupSnapshotV1['parent_meta_ids'],
    config: normalizedConfig,
    config_fingerprint: sha256Fingerprint(normalizedConfig),
    observed_synced_at: input.observedSyncedAt ?? asString(input.row.last_synced_at),
  }
}

export function normalizeCampaignSetupSnapshot(row: Row): NormalizedMetaSetupSnapshotV1 {
  return snapshot({
    row,
    level: 'campaign',
    metaIdField: 'campaign_id',
    config: configOf(row, [
      'campaign_name',
      'objective',
      'status',
      'effective_status',
      'buying_type',
      'special_ad_category',
      'daily_budget',
      'lifetime_budget',
      'start_time',
      'stop_time',
    ]),
  })
}

export function normalizeAdsetSetupSnapshot(row: Row): NormalizedMetaSetupSnapshotV1 {
  return snapshot({
    row,
    level: 'adset',
    metaIdField: 'adset_id',
    parentMetaIds: { campaign_id: asString(row.campaign_meta_id) },
    observedSyncedAt: asString(row.targeting_last_synced_at) ?? asString(row.last_synced_at),
    config: configOf(row, [
      'adset_name',
      'status',
      'effective_status',
      'optimization_goal',
      'billing_event',
      'destination_type',
      'promoted_object',
      'attribution_spec',
      'targeting',
      'targeting_optimization_types',
      'daily_budget',
      'lifetime_budget',
      'bid_amount',
      'bid_strategy',
      'learning_stage',
      'last_sig_edit_ts',
      'start_time',
      'end_time',
      'meta_created_time',
      'meta_updated_time',
    ]),
  })
}

export function normalizeAdSetupSnapshot(row: Row): NormalizedMetaSetupSnapshotV1 {
  return snapshot({
    row,
    level: 'ad',
    metaIdField: 'ad_id',
    parentMetaIds: {
      campaign_id: asString(row.campaign_meta_id),
      adset_id: asString(row.adset_meta_id),
      creative_id: asString(row.creative_meta_id) ?? asString(row.meta_creative_id),
    },
    config: configOf(row, [
      'ad_name',
      'status',
      'effective_status',
      'destination_url',
      'destination_url_read_available',
      'destination_url_synced_at',
      'url_tags',
      'creative_angle',
      'meta_creative_id',
      'review_feedback',
      'issues_info',
      'tracking_specs',
      'conversion_specs',
      'meta_created_time',
      'meta_updated_time',
    ]),
  })
}

export function normalizeAudienceSetupSnapshot(row: Row): NormalizedMetaSetupSnapshotV1 {
  return snapshot({
    row,
    level: 'audience',
    metaIdField: 'audience_id',
    config: configOf(row, [
      'name',
      'subtype',
      'meta_account_id',
      'source_audience_id',
      'source_audience_name',
      'approximate_count',
      'approximate_count_lower_bound',
      'approximate_count_upper_bound',
      'retention_days',
      'lookalike_spec',
      'operation_status',
      'delivery_status',
      'meta_updated_at',
    ]),
  })
}

export function normalizeCreativeSetupSnapshot(row: Row): NormalizedMetaSetupSnapshotV1 {
  return snapshot({
    row,
    level: 'creative',
    metaIdField: 'creative_id',
    config: configOf(row, [
      'creative_name',
      'body',
      'title',
      'description',
      'call_to_action_type',
      'link_url',
      'url_tags',
      'display_url',
      'instagram_permalink_url',
      'asset_type',
      'image_url',
      'image_hash',
      'video_id',
      'thumbnail_url',
      'child_attachments',
      'object_story_spec',
      'asset_feed_spec',
      'meta_created_time',
    ]),
  })
}

export function buildMetaSetupGenerationFingerprint(snapshots: NormalizedMetaSetupSnapshotV1[]): string {
  const payload = snapshots
    .map((row) => ({
      entity_level: row.entity_level,
      meta_entity_id: row.meta_entity_id,
      config_fingerprint: row.config_fingerprint,
      parent_meta_ids: row.parent_meta_ids,
    }))
    .sort((a, b) => `${a.entity_level}:${a.meta_entity_id}`.localeCompare(`${b.entity_level}:${b.meta_entity_id}`))

  return sha256Fingerprint({ contract_version: 1, snapshots: payload })
}

function snapshotKey(row: NormalizedMetaSetupSnapshotV1): string {
  return `${row.entity_level}:${row.meta_entity_id}`
}

function flatten(value: unknown, prefix = ''): Array<{ path: string; value: unknown }> {
  if (!isPlainObject(value)) return [{ path: prefix || '$', value: canonicalize(value) }]
  const entries = Object.keys(value).sort()
  if (entries.length === 0) return [{ path: prefix || '$', value: {} }]
  return entries.flatMap((key) => flatten(value[key], prefix ? `${prefix}.${key}` : key))
}

function sameValue(a: unknown, b: unknown): boolean {
  return stableJson(a) === stableJson(b)
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value)
}

function findPlanMatch(
  change: Omit<SetupMaterialChangeV1, 'reason_status' | 'approved_plan_id' | 'reason'>,
  plans: SetupChangePlanV1[],
): { planId: string; reason: string } | null {
  for (const plan of plans) {
    const match = plan.expectedChanges.find((expected) =>
      expected.entity_level === change.entity_level
      && expected.meta_entity_id === change.meta_entity_id
      && expected.field_path === change.field_path
      && (!('before_value' in expected) || sameValue(expected.before_value, change.before_value))
      && (!('after_value' in expected) || sameValue(expected.after_value, change.after_value)),
    )
    if (match) return { planId: plan.planId, reason: match.reason }
  }
  return null
}

export function deriveMaterialSetupChanges(input: {
  adAccountId: string
  fromGenerationId: string | null
  toGenerationId: string
  before: NormalizedMetaSetupSnapshotV1[]
  after: NormalizedMetaSetupSnapshotV1[]
  approvedPlans?: SetupChangePlanV1[]
}): SetupMaterialChangeV1[] {
  const beforeByKey = new Map(input.before.map((row) => [snapshotKey(row), row]))
  const afterByKey = new Map(input.after.map((row) => [snapshotKey(row), row]))
  const keys = [...new Set([...beforeByKey.keys(), ...afterByKey.keys()])].sort()
  const plans = input.approvedPlans ?? []

  return keys.flatMap((key) => {
    const before = beforeByKey.get(key)
    const after = afterByKey.get(key)
    if (!before && !after) return []

    const base = {
      ad_account_id: input.adAccountId,
      from_generation_id: input.fromGenerationId,
      to_generation_id: input.toGenerationId,
      entity_level: (after ?? before)?.entity_level as MetaSetupEntityLevelV1,
      meta_entity_id: (after ?? before)?.meta_entity_id as string,
    }

    const rawChanges: Array<Omit<SetupMaterialChangeV1, 'reason_status' | 'approved_plan_id' | 'reason'>> = []
    if (!before && after) {
      rawChanges.push({ ...base, change_type: 'added', field_path: '$', before_value: null, after_value: after.config })
    } else if (before && !after) {
      rawChanges.push({ ...base, change_type: 'removed', field_path: '$', before_value: before.config, after_value: null })
    } else if (before && after && before.config_fingerprint !== after.config_fingerprint) {
      const beforeFields = new Map(flatten(before.config).map((entry) => [entry.path, entry.value]))
      const afterFields = new Map(flatten(after.config).map((entry) => [entry.path, entry.value]))
      for (const fieldPath of [...new Set([...beforeFields.keys(), ...afterFields.keys()])].sort()) {
        // A leaf whose own key is volatile is never a material change.
        if (isVolatileKey(fieldPath.split('.').pop() ?? fieldPath)) continue
        const beforeValue = beforeFields.has(fieldPath) ? beforeFields.get(fieldPath) : null
        const afterValue = afterFields.has(fieldPath) ? afterFields.get(fieldPath) : null
        // Containers are compared with volatile members removed, so rotation nested inside an array
        // or object does not read as an edit.
        if (!sameValue(stripVolatile(beforeValue), stripVolatile(afterValue))) {
          rawChanges.push({
            ...base,
            change_type: 'updated',
            field_path: fieldPath,
            before_value: beforeValue,
            after_value: afterValue,
          })
        }
      }
    }

    return rawChanges.map((change) => {
      const matchedPlan = findPlanMatch(change, plans)
      return {
        ...change,
        reason_status: matchedPlan ? 'matched_approved_plan' : 'reason_unknown',
        approved_plan_id: matchedPlan?.planId ?? null,
        reason: matchedPlan?.reason ?? null,
      }
    })
  })
}

export function projectLatestSetupMaterialChange(input: {
  changes: Array<SetupMaterialChangeV1 & { created_at?: string | null }>
  through: string
}): LatestSetupMaterialChangeV1 {
  if (input.changes.length === 0) return { status: 'none_observed', through: input.through }
  const sorted = [...input.changes].sort((a, b) =>
    String(b.created_at ?? '').localeCompare(String(a.created_at ?? ''))
      || String(b.id ?? '').localeCompare(String(a.id ?? '')),
  )
  const latest = sorted[0]
  if (!latest) return { status: 'none_observed', through: input.through }
  const batch = latest.to_generation_id
    ? sorted.filter((change) => change.to_generation_id === latest.to_generation_id)
    : sorted.filter((change) => (change.created_at ?? null) === (latest.created_at ?? null))
  const occurredAt = latest.created_at ?? null
  if (batch.some((change) => change.reason_status !== 'matched_approved_plan' || !change.reason)) {
    return {
      status: 'unknown',
      occurredAt,
      reasonCode: 'setup_change_reason_unknown',
    }
  }
  if (batch.some((change) => !isUuid(change.id))) {
    return {
      status: 'unknown',
      occurredAt,
      reasonCode: 'setup_change_identity_unknown',
    }
  }
  const materialChangeIds = batch.map((change) => change.id).filter(isUuid).sort()
  const reasons = [...new Set(batch.map((change) => change.reason).filter((reason): reason is string => Boolean(reason)))].sort()
  const categories = [...new Set(batch.map((change) => change.field_path.split('.')[0] ?? change.field_path))].sort()
  const affectedIds = [...new Set(batch.map((change) => change.meta_entity_id))].sort()
  return {
    status: 'known',
    governanceBasis: 'matched_approved_plan',
    materialChangeId: materialChangeIds[0],
    materialChangeIds,
    occurredAt: occurredAt ?? input.through,
    reason: reasons.join('; '),
    source: 'meta_observation',
    settingCategories: categories,
    affectedMetaIds: affectedIds,
  }
}
