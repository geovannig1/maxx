import type { SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import {
  readLatestPaidCohortArtifact,
  type PaidCohortDirectionArtifact,
  type PaidCohortEvaluationArtifact,
} from '@/lib/attribution/paid-cohort-store'
import {
  resolveCreativeAssignment,
  type CreativeAssignmentObservation,
  type CreativeAssignmentResolution,
} from './assignment-stability'
import {
  projectPaidCreativeOutcomes,
  type PaidCreativeAssignmentsByDirection,
  type PaidCreativeDisplayMetadata,
  type PaidCreativeOutcomes,
} from './paid-outcomes'

const PAGE_SIZE = 1000
const MAX_PAGES = 100
const META_ID_PATTERN = /^\d{1,32}$/
const ISO_INSTANT_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/

const accountIdSchema = z.string().uuid()
const accountSchema = z.object({
  timezone_name: z.string().min(1).max(128)
    .refine((value) => value === value.trim())
    .refine((value) => {
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: value }).format(0)
        return true
      } catch {
        return false
      }
    }),
}).strict()
const observationSchema = z.object({
  id: z.string().uuid(),
  ad_account_id: z.string().uuid(),
  meta_ad_id: z.string().regex(META_ID_PATTERN),
  meta_creative_id: z.string().regex(META_ID_PATTERN).nullable(),
  observed_at: z.string().regex(ISO_INSTANT_PATTERN).datetime({ offset: true }),
  meta_updated_time: z.string().regex(ISO_INSTANT_PATTERN).datetime({ offset: true }).nullable(),
}).strict()
const metadataSchema = z.object({
  ad_account_id: z.string().uuid(),
  creative_id: z.string().regex(META_ID_PATTERN),
  creative_name: z.string().nullable(),
  thumbnail_url: z.string().nullable(),
}).strict()

type QueryBuilder = ReturnType<ReturnType<SupabaseClient['from']>['select']>
type AssignmentRow = z.infer<typeof observationSchema>

export type PaidCreativeOutcomesStoreErrorCode =
  | 'INPUT_INVALID'
  | 'SOURCE_READ_FAILED'
  | 'SOURCE_DATA_INVALID'
  | 'SOURCE_PAGE_LIMIT_EXCEEDED'

export class PaidCreativeOutcomesStoreError extends Error {
  constructor(
    public readonly code: PaidCreativeOutcomesStoreErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'PaidCreativeOutcomesStoreError'
  }
}

function sourceReadError(table: string, reason: string): PaidCreativeOutcomesStoreError {
  return new PaidCreativeOutcomesStoreError(
    'SOURCE_READ_FAILED',
    `${table} source read failed: ${reason}`,
  )
}

async function readTimezone(db: SupabaseClient, adAccountId: string): Promise<string> {
  const result = await db.from('ad_accounts')
    .select('timezone_name')
    .eq('id', adAccountId)
    .maybeSingle()
  if (result.error) throw sourceReadError('ad_accounts', result.error.message)
  const parsed = accountSchema.safeParse(result.data)
  if (!parsed.success) {
    throw new PaidCreativeOutcomesStoreError(
      'SOURCE_DATA_INVALID',
      'The governed ad account timezone is missing or malformed.',
    )
  }
  return parsed.data.timezone_name
}

async function readAssignmentRows(
  db: SupabaseClient,
  adAccountId: string,
  metaAdIds: string[],
  signal?: AbortSignal,
): Promise<AssignmentRow[]> {
  if (metaAdIds.length === 0) return []
  const rows: AssignmentRow[] = []
  const seenIds = new Set<string>()
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const start = page * PAGE_SIZE
    const query = db.from('ad_creative_assignment_observations')
      .select('id, ad_account_id, meta_ad_id, meta_creative_id, observed_at, meta_updated_time')
      .eq('ad_account_id', adAccountId)
      .in('meta_ad_id', metaAdIds)
      .order('observed_at', { ascending: true })
      .order('id', { ascending: true })
      .range(start, start + PAGE_SIZE - 1)
    const result = await (signal ? query.abortSignal(signal) : query)
    if (result.error) {
      throw sourceReadError('ad_creative_assignment_observations', result.error.message)
    }
    if (!Array.isArray(result.data)) {
      throw new PaidCreativeOutcomesStoreError(
        'SOURCE_DATA_INVALID',
        'ad_creative_assignment_observations returned a non-array result.',
      )
    }
    for (const raw of result.data) {
      const parsed = observationSchema.safeParse(raw)
      if (
        !parsed.success
        || parsed.data.ad_account_id !== adAccountId
        || !metaAdIds.includes(parsed.data.meta_ad_id)
        || seenIds.has(parsed.data.id)
      ) {
        throw new PaidCreativeOutcomesStoreError(
          'SOURCE_DATA_INVALID',
          'ad_creative_assignment_observations returned a malformed row.',
        )
      }
      seenIds.add(parsed.data.id)
      rows.push(parsed.data)
    }
    if (result.data.length < PAGE_SIZE) return rows
  }
  throw new PaidCreativeOutcomesStoreError(
    'SOURCE_PAGE_LIMIT_EXCEEDED',
    `ad_creative_assignment_observations exceeded the audited ${PAGE_SIZE * MAX_PAGES}-row read bound.`,
  )
}

function resolverObservation(row: AssignmentRow): CreativeAssignmentObservation {
  return {
    id: row.id,
    metaAdId: row.meta_ad_id,
    metaCreativeId: row.meta_creative_id,
    observedAt: row.observed_at,
    metaUpdatedTime: row.meta_updated_time,
  }
}

/** Read-only reuse of the validated, bounded native ledger; no projection or observation writes. */
export async function readCreativeAssignmentObservations(
  db: SupabaseClient, adAccountId: string, metaAdIds: readonly string[], options: { signal?: AbortSignal } = {},
): Promise<CreativeAssignmentObservation[]> {
  const account = accountIdSchema.parse(adAccountId)
  const ids = [...new Set(z.array(z.string().regex(META_ID_PATTERN)).parse(metaAdIds))]
  return (await readAssignmentRows(db, account, ids, options.signal)).map(resolverObservation)
}

function resolveDirection(
  timezone: string,
  direction: PaidCohortDirectionArtifact,
  observations: ReadonlyMap<string, CreativeAssignmentObservation[]>,
): ReadonlyMap<string, CreativeAssignmentResolution> {
  const resolutions = new Map<string, CreativeAssignmentResolution>()
  for (const unit of direction.adUnits) {
    const resolution = resolveCreativeAssignment({
      timezone,
      metaAdId: unit.metaAdId,
      windowStart: direction.generation.windowStart,
      windowEnd: direction.generation.windowEnd,
      observations: observations.get(unit.metaAdId) ?? [],
    })
    if (resolution.state === 'blocked' && resolution.blockerCode === 'assignment_evidence_invalid') {
      throw new PaidCreativeOutcomesStoreError(
        'SOURCE_DATA_INVALID',
        'Creative assignment evidence failed governed validation.',
      )
    }
    resolutions.set(unit.metaAdId, resolution)
  }
  return resolutions
}

function resolveAssignments(
  artifact: PaidCohortEvaluationArtifact,
  timezone: string,
  rows: AssignmentRow[],
): PaidCreativeAssignmentsByDirection {
  const observations = new Map<string, CreativeAssignmentObservation[]>()
  for (const row of rows) {
    const values = observations.get(row.meta_ad_id) ?? []
    values.push(resolverObservation(row))
    observations.set(row.meta_ad_id, values)
  }
  return {
    recent_scale: resolveDirection(timezone, artifact.recentScale, observations),
    matured_cut: resolveDirection(timezone, artifact.maturedCut, observations),
  }
}

async function readMetadata(
  db: SupabaseClient,
  adAccountId: string,
  creativeIds: string[],
): Promise<ReadonlyMap<string, PaidCreativeDisplayMetadata>> {
  const metadata = new Map<string, PaidCreativeDisplayMetadata>()
  if (creativeIds.length === 0) return metadata
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const start = page * PAGE_SIZE
    const result = await (db.from('creatives')
      .select('ad_account_id, creative_id, creative_name, thumbnail_url')
      .eq('ad_account_id', adAccountId)
      .in('creative_id', creativeIds)
      .order('creative_id', { ascending: true })
      .range(start, start + PAGE_SIZE - 1) as QueryBuilder)
    if (result.error) throw sourceReadError('creatives', result.error.message)
    if (!Array.isArray(result.data)) {
      throw new PaidCreativeOutcomesStoreError('SOURCE_DATA_INVALID', 'creatives returned invalid data.')
    }
    for (const raw of result.data) {
      const parsed = metadataSchema.safeParse(raw)
      if (
        !parsed.success
        || parsed.data.ad_account_id !== adAccountId
        || !creativeIds.includes(parsed.data.creative_id)
        || metadata.has(parsed.data.creative_id)
      ) {
        throw new PaidCreativeOutcomesStoreError('SOURCE_DATA_INVALID', 'creatives returned invalid data.')
      }
      metadata.set(parsed.data.creative_id, {
        creative_name: parsed.data.creative_name,
        thumbnail_url: parsed.data.thumbnail_url,
      })
    }
    if (result.data.length < PAGE_SIZE) return metadata
  }
  throw new PaidCreativeOutcomesStoreError(
    'SOURCE_PAGE_LIMIT_EXCEEDED',
    `creatives exceeded the audited ${PAGE_SIZE * MAX_PAGES}-row read bound.`,
  )
}

function stableCreativeIds(assignments: PaidCreativeAssignmentsByDirection): string[] {
  const ids: string[] = []
  for (const direction of [assignments.recent_scale, assignments.matured_cut]) {
    for (const resolution of direction.values()) {
      if (resolution.state === 'observed_stable') ids.push(resolution.metaCreativeId)
    }
  }
  return [...new Set(ids)].sort((left, right) => left.localeCompare(right))
}

export async function readPaidCreativeOutcomes(
  db: SupabaseClient,
  adAccountId: string,
): Promise<PaidCreativeOutcomes> {
  if (!accountIdSchema.safeParse(adAccountId).success) {
    throw new PaidCreativeOutcomesStoreError(
      'INPUT_INVALID',
      'Paid creative outcomes require a UUID ad account ID.',
    )
  }

  const artifact = await readLatestPaidCohortArtifact(db, adAccountId)
  if (!artifact) {
    return projectPaidCreativeOutcomes(null, { recent_scale: new Map(), matured_cut: new Map() }, new Map())
  }

  const timezone = await readTimezone(db, adAccountId)
  const metaAdIds = [...new Set([
    ...artifact.recentScale.adUnits.map((unit) => unit.metaAdId),
    ...artifact.maturedCut.adUnits.map((unit) => unit.metaAdId),
  ])].sort((left, right) => left.localeCompare(right))
  const rows = await readAssignmentRows(db, adAccountId, metaAdIds)
  const assignments = resolveAssignments(artifact, timezone, rows)
  const governed = projectPaidCreativeOutcomes(artifact, assignments, new Map())

  let metadata: ReadonlyMap<string, PaidCreativeDisplayMetadata>
  try {
    metadata = await readMetadata(db, adAccountId, stableCreativeIds(assignments))
  } catch {
    return governed
  }
  return projectPaidCreativeOutcomes(artifact, assignments, metadata)
}
