import type { SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'

import type { PaidCreativeOutcomes } from './paid-outcomes'
import {
  projectVisionPaidAttributeOutcomes,
  type VersionedVisionObservation,
  type VisionPaidAttributeOutcomes,
} from './vision-paid-attribute-outcomes'
import {
  computeVisionAnalysisFingerprint,
  computeVisionPromptFingerprint,
  computeVisionSourceAssetFingerprint,
  currentVisionAnalysisIdentity,
  VISION_ANALYSIS_PROMPT_VERSION,
  VISION_ANALYSIS_SCHEMA_VERSION,
  type VisionAnalysisIdentity,
} from './vision-analyzer'

const PAGE_SIZE = 1_000
const MAX_PAGES = 100
const ID_BATCH_SIZE = 100
const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/
const META_ID_PATTERN = /^\d{1,32}$/

const analysisSchema = z.object({
  format: z.enum(['video', 'static', 'carousel']),
  has_text_overlay: z.boolean(),
  hook_text: z.string().nullable(),
  shows_price: z.boolean(),
  talent_type: z.enum(['solo', 'group', 'broll', 'none']),
  setting: z.enum(['studio', 'outdoor', 'other']),
  color_mood: z.enum(['bright', 'dark', 'warm', 'neutral']),
  cta_visible: z.boolean(),
  hook_strength_score: z.number().int().min(1).max(5),
  notes: z.string().nullable(),
}).strict()

const creativeSchema = z.object({
  id: z.string().uuid(),
  ad_account_id: z.string().uuid(),
  creative_id: z.string().regex(META_ID_PATTERN),
  thumbnail_url: z.string().nullable(),
  image_url: z.string().nullable(),
  image_hash: z.string().nullable(),
  video_id: z.string().nullable(),
  body: z.string().nullable(),
  title: z.string().nullable(),
  asset_type: z.string().nullable(),
  child_attachments: z.unknown().nullable(),
  object_story_spec: z.unknown().nullable(),
  asset_feed_spec: z.unknown().nullable(),
}).strict()

const versionSchema = z.object({
  id: z.string().uuid(),
  ad_account_id: z.string().uuid(),
  creative_id: z.string().uuid(),
  meta_creative_id: z.string().regex(META_ID_PATTERN),
  analysis_schema_version: z.literal(VISION_ANALYSIS_SCHEMA_VERSION),
  prompt_version: z.literal(VISION_ANALYSIS_PROMPT_VERSION),
  provider: z.enum(['anthropic', 'openai']),
  model: z.string().min(1).max(128),
  source_asset_fingerprint: z.string().regex(HASH_PATTERN),
  prompt_fingerprint: z.string().regex(HASH_PATTERN),
  analysis_fingerprint: z.string().regex(HASH_PATTERN),
  analysis: analysisSchema,
  analyzed_at: z.string().datetime({ offset: true }),
}).strict()

type CreativeRow = z.infer<typeof creativeSchema>
type VersionRow = z.infer<typeof versionSchema>

export type VisionPaidAttributeStoreErrorCode =
  | 'INPUT_INVALID'
  | 'SOURCE_READ_FAILED'
  | 'SOURCE_DATA_INVALID'
  | 'SOURCE_PAGE_LIMIT_EXCEEDED'

export class VisionPaidAttributeStoreError extends Error {
  constructor(
    public readonly code: VisionPaidAttributeStoreErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'VisionPaidAttributeStoreError'
  }
}

function batches(values: string[]): string[][] {
  const result: string[][] = []
  for (let start = 0; start < values.length; start += ID_BATCH_SIZE) {
    result.push(values.slice(start, start + ID_BATCH_SIZE))
  }
  return result
}

function sourceReadFailed(table: string, reason: string): VisionPaidAttributeStoreError {
  return new VisionPaidAttributeStoreError(
    'SOURCE_READ_FAILED',
    `${table} source read failed: ${reason}`,
  )
}

function governedCreativeIds(paidOutcomes: PaidCreativeOutcomes): string[] {
  const ids = [paidOutcomes.recent_scale, paidOutcomes.matured_cut]
    .flatMap((direction) => direction?.creatives ?? [])
    .filter((creative) => creative.status === 'available')
    .map((creative) => creative.meta_creative_id)
  return [...new Set(ids)].sort((left, right) => left.localeCompare(right))
}

async function readCreatives(
  db: SupabaseClient,
  adAccountId: string,
  metaCreativeIds: string[],
): Promise<ReadonlyMap<string, CreativeRow>> {
  const rows = new Map<string, CreativeRow>()
  for (const batch of batches(metaCreativeIds)) {
    const result = await db.from('creatives')
      .select('id, ad_account_id, creative_id, thumbnail_url, image_url, image_hash, video_id, body, title, asset_type, child_attachments, object_story_spec, asset_feed_spec')
      .eq('ad_account_id', adAccountId)
      .in('creative_id', batch)
    if (result.error) throw sourceReadFailed('creatives', result.error.message)
    if (!Array.isArray(result.data)) {
      throw new VisionPaidAttributeStoreError('SOURCE_DATA_INVALID', 'creatives returned invalid data.')
    }
    for (const raw of result.data) {
      const parsed = creativeSchema.safeParse(raw)
      if (
        !parsed.success
        || parsed.data.ad_account_id !== adAccountId
        || !batch.includes(parsed.data.creative_id)
        || rows.has(parsed.data.creative_id)
      ) {
        throw new VisionPaidAttributeStoreError(
          'SOURCE_DATA_INVALID',
          'creatives returned malformed or duplicate vision source evidence.',
        )
      }
      rows.set(parsed.data.creative_id, parsed.data)
    }
  }
  return rows
}

async function readVersions(
  db: SupabaseClient,
  adAccountId: string,
  metaCreativeIds: string[],
  identity: VisionAnalysisIdentity,
): Promise<VersionRow[]> {
  const rows: VersionRow[] = []
  const seenIds = new Set<string>()
  for (const batch of batches(metaCreativeIds)) {
    let completed = false
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const start = page * PAGE_SIZE
      const result = await db.from('creative_vision_analysis_versions')
        .select('id, ad_account_id, creative_id, meta_creative_id, analysis_schema_version, prompt_version, provider, model, source_asset_fingerprint, prompt_fingerprint, analysis_fingerprint, analysis, analyzed_at')
        .eq('ad_account_id', adAccountId)
        .eq('analysis_schema_version', VISION_ANALYSIS_SCHEMA_VERSION)
        .eq('prompt_version', VISION_ANALYSIS_PROMPT_VERSION)
        .eq('provider', identity.provider)
        .eq('model', identity.model)
        .in('meta_creative_id', batch)
        .order('analyzed_at', { ascending: false })
        .order('id', { ascending: false })
        .range(start, start + PAGE_SIZE - 1)
      if (result.error) {
        throw sourceReadFailed('creative_vision_analysis_versions', result.error.message)
      }
      if (!Array.isArray(result.data)) {
        throw new VisionPaidAttributeStoreError(
          'SOURCE_DATA_INVALID',
          'creative_vision_analysis_versions returned invalid data.',
        )
      }
      for (const raw of result.data) {
        const parsed = versionSchema.safeParse(raw)
        if (
          !parsed.success
          || parsed.data.ad_account_id !== adAccountId
          || !batch.includes(parsed.data.meta_creative_id)
          || parsed.data.provider !== identity.provider
          || parsed.data.model !== identity.model
          || seenIds.has(parsed.data.id)
          || computeVisionAnalysisFingerprint(parsed.data.analysis)
            !== parsed.data.analysis_fingerprint
        ) {
          throw new VisionPaidAttributeStoreError(
            'SOURCE_DATA_INVALID',
            'creative_vision_analysis_versions returned malformed evidence.',
          )
        }
        seenIds.add(parsed.data.id)
        rows.push(parsed.data)
      }
      if (result.data.length < PAGE_SIZE) {
        completed = true
        break
      }
    }
    if (!completed) {
      throw new VisionPaidAttributeStoreError(
        'SOURCE_PAGE_LIMIT_EXCEEDED',
        `creative_vision_analysis_versions exceeded the audited ${PAGE_SIZE * MAX_PAGES}-row read bound.`,
      )
    }
  }
  return rows
}

function matchingObservations(
  creatives: ReadonlyMap<string, CreativeRow>,
  versions: VersionRow[],
): VersionedVisionObservation[] {
  return versions.flatMap((version): VersionedVisionObservation[] => {
    const creative = creatives.get(version.meta_creative_id)
    if (!creative || creative.id !== version.creative_id) return []
    const input = { ...creative, object_type: creative.asset_type }
    if (
      computeVisionSourceAssetFingerprint(input) !== version.source_asset_fingerprint
      || computeVisionPromptFingerprint(input) !== version.prompt_fingerprint
    ) return []
    return [version]
  })
}

/** `identity` defaults to the current AI configuration; with AI off no analysis is read. */
export async function readVisionPaidAttributeOutcomes(
  db: SupabaseClient,
  adAccountId: string,
  paidOutcomes: PaidCreativeOutcomes,
  identity: VisionAnalysisIdentity | null = currentVisionAnalysisIdentity(),
): Promise<VisionPaidAttributeOutcomes> {
  if (!z.string().uuid().safeParse(adAccountId).success) {
    throw new VisionPaidAttributeStoreError(
      'INPUT_INVALID',
      'Versioned vision paid outcomes require a UUID ad account ID.',
    )
  }
  const metaCreativeIds = governedCreativeIds(paidOutcomes)
  if (metaCreativeIds.length === 0 || identity === null) {
    return projectVisionPaidAttributeOutcomes(paidOutcomes, [], identity)
  }
  const [creatives, versions] = await Promise.all([
    readCreatives(db, adAccountId, metaCreativeIds),
    readVersions(db, adAccountId, metaCreativeIds, identity),
  ])
  return projectVisionPaidAttributeOutcomes(
    paidOutcomes,
    matchingObservations(creatives, versions),
    identity,
  )
}
