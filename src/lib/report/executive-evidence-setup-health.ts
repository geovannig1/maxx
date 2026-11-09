import type { SupabaseClient } from '@supabase/supabase-js'

import type { MetaSetupEvidenceInput, SetupEvidenceBlockerCode } from './setup-evidence-types'

const SETUP_MAX_AGE_MS = 36 * 60 * 60 * 1_000

type LatestQuery = {
  eq(column: string, value: unknown): LatestQuery
  order(column: string, options?: { ascending?: boolean }): LatestQuery
  limit(count: number): LatestQuery
} & PromiseLike<{
  data: Record<string, unknown>[] | null
  error: { message: string } | null
}>

export type SetupGenerationRow = {
  id: string
  observed_at: string
  complete: boolean
  blocker_codes: string[]
}

const SETUP_GENERATION_BLOCKERS = new Set<SetupEvidenceBlockerCode>([
  'custom_audience_sync_failed',
  'creative_sync_failed',
  'creative_inventory_incomplete',
])

export async function readLatestSetupGeneration(
  db: SupabaseClient,
  accountId: string,
): Promise<SetupGenerationRow | null> {
  const query = (db.from('meta_setup_generations').select(
    'id,observed_at,complete,blocker_codes',
  ) as unknown as LatestQuery)
    .eq('ad_account_id', accountId)
    .order('observed_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(1)
  const { data, error } = await query
  if (error) throw new Error(`meta setup generation read failed: ${error.message}`)
  const row = data?.[0]
  if (!row) return null
  return {
    id: String(row.id),
    observed_at: String(row.observed_at),
    complete: row.complete === true,
    blocker_codes: Array.isArray(row.blocker_codes)
      ? row.blocker_codes.filter((item): item is string => typeof item === 'string')
      : [],
  }
}

export function validateSetupGeneration(
  row: SetupGenerationRow | null,
  asOf: string,
  currentRunSetupGenerationId: string | null | undefined,
): { head: string | null; blockerCodes: SetupEvidenceBlockerCode[]; blocksAll: boolean } {
  if (currentRunSetupGenerationId === null) {
    return {
      head: row?.observed_at ?? null,
      blockerCodes: ['setup_generation_current_run_mismatch'],
      blocksAll: true,
    }
  }
  if (!row) return { head: null, blockerCodes: ['setup_generation_unavailable'], blocksAll: true }
  if (currentRunSetupGenerationId !== undefined && row.id !== currentRunSetupGenerationId) {
    return {
      head: row.observed_at,
      blockerCodes: ['setup_generation_current_run_mismatch'],
      blocksAll: true,
    }
  }
  const observedMs = Date.parse(row.observed_at)
  const asOfMs = Date.parse(asOf)
  if (!Number.isFinite(observedMs) || !Number.isFinite(asOfMs)
    || observedMs > asOfMs || asOfMs - observedMs > SETUP_MAX_AGE_MS) {
    return { head: row.observed_at, blockerCodes: ['setup_generation_stale'], blocksAll: true }
  }
  if (!row.complete) {
    const recognized = row.blocker_codes.filter(
      (item): item is SetupEvidenceBlockerCode =>
        SETUP_GENERATION_BLOCKERS.has(item as SetupEvidenceBlockerCode),
    )
    return {
      head: row.observed_at,
      blockerCodes: recognized.length > 0 ? recognized : ['setup_generation_unavailable'],
      blocksAll: recognized.length === 0,
    }
  }
  if (row.blocker_codes.length > 0) {
    return { head: row.observed_at, blockerCodes: ['setup_generation_unavailable'], blocksAll: true }
  }
  return { head: row.observed_at, blockerCodes: [], blocksAll: false }
}

export function quarantineFailedSetupSources(
  audience: Pick<MetaSetupEvidenceInput, 'audience_inventory' | 'audiences_by_id'>,
  creativeRows: Record<string, unknown>[],
  blockerCodes: SetupEvidenceBlockerCode[],
): {
  audience: Pick<MetaSetupEvidenceInput, 'audience_inventory' | 'audiences_by_id'>
  creativeRows: Record<string, unknown>[]
} {
  const audienceBlocked = blockerCodes.includes('custom_audience_sync_failed')
  const creativeBlocked = blockerCodes.some((code) =>
    code === 'creative_sync_failed' || code === 'creative_inventory_incomplete',
  )
  return {
    audience: audienceBlocked
      ? {
          audience_inventory: {
            read_available: false,
            schema: null,
            row_count: null,
            reason_code: 'custom_audience_snapshot_unavailable',
            reason: 'The current sync did not commit a successful custom-audience inventory.',
          },
          audiences_by_id: {},
        }
      : audience,
    creativeRows: creativeBlocked ? [] : creativeRows,
  }
}
