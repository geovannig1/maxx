import { getAdminClient } from '@/lib/supabase/admin'
import type { SyncStatus } from '@/types/db'

/** Creates the sync-log row that also serves as the DURABLE SINGLE-FLIGHT CLAIM (`api_sync_logs_one_active_per_account`: partial
 *  unique index on ad_account_id WHERE status IN ('pending','running')). Returns the new log id, or NULL
 *  when another active sync already holds the claim for this account (unique violation) — the caller aborts
 *  early, before ingest. A real (non-conflict) DB error still throws. */
export async function createSyncLog(params: {
  adAccountId: string
  syncType: string
  triggeredBy: string
  dateRangeStart?: string
  dateRangeEnd?: string
}): Promise<string | null> {
  const supabase = getAdminClient()

  const { data, error } = await supabase
    .from('api_sync_logs')
    .insert({
      ad_account_id: params.adAccountId,
      sync_type: params.syncType,
      triggered_by: params.triggeredBy,
      status: 'pending' as SyncStatus,
      date_range_start: params.dateRangeStart ?? null,
      date_range_end: params.dateRangeEnd ?? null,
    })
    .select('id')
    .single()

  if (error) {
    // 23505 = unique_violation on the single-flight index → another sync is already active for this account.
    if (error.code === '23505') return null
    throw new Error(`createSyncLog failed: ${error.message}`)
  }

  return data.id as string
}

export async function updateSyncLog(
  logId: string,
  update: {
    status?: SyncStatus
    startedAt?: string
    completedAt?: string
    durationMs?: number
    campaignsFetched?: number
    adsetsFetched?: number
    adsFetched?: number
    creativesFetched?: number
    insightsFetched?: number
    apiCallsMade?: number
    rateLimitHit?: boolean
    retryCount?: number
    errorMessage?: string
    errorCode?: string
    /** Per-run record of which decision gate closed. See the `api_sync_logs.decision_gate` column comment. */
    decisionGate?: unknown
    errorDetails?: Record<string, unknown>
  }
): Promise<void> {
  const supabase = getAdminClient()

  const patch: Record<string, unknown> = {}

  if (update.status !== undefined) patch.status = update.status
  if (update.startedAt !== undefined) patch.started_at = update.startedAt
  if (update.completedAt !== undefined) patch.completed_at = update.completedAt
  if (update.durationMs !== undefined) patch.duration_ms = update.durationMs
  if (update.campaignsFetched !== undefined) patch.campaigns_fetched = update.campaignsFetched
  if (update.adsetsFetched !== undefined) patch.adsets_fetched = update.adsetsFetched
  if (update.adsFetched !== undefined) patch.ads_fetched = update.adsFetched
  if (update.creativesFetched !== undefined) patch.creatives_fetched = update.creativesFetched
  if (update.insightsFetched !== undefined) patch.insights_fetched = update.insightsFetched
  if (update.apiCallsMade !== undefined) patch.api_calls_made = update.apiCallsMade
  if (update.rateLimitHit !== undefined) patch.rate_limit_hit = update.rateLimitHit
  if (update.retryCount !== undefined) patch.retry_count = update.retryCount
  if (update.errorMessage !== undefined) patch.error_message = update.errorMessage
  if (update.errorCode !== undefined) patch.error_code = update.errorCode
  if (update.errorDetails !== undefined) patch.error_details = update.errorDetails
  if (update.decisionGate !== undefined) patch.decision_gate = update.decisionGate

  if (Object.keys(patch).length === 0) return

  const { error } = await supabase
    .from('api_sync_logs')
    .update(patch)
    .eq('id', logId)

  if (error) {
    throw new Error(`updateSyncLog failed: ${error.message}`)
  }
}

/**
 * Watchdog: mark sync logs stuck in `pending`/`running` past a cutoff as `failed`.
 * A process that dies mid-sync leaves an orphaned `running` row that otherwise never
 * resolves and poisons freshness checks. Run this at the start of every sync.
 */
export async function reconcileOrphanedSyncs(
  adAccountId: string,
  olderThanMinutes = 30
): Promise<number> {
  const supabase = getAdminClient()
  const cutoff = new Date(Date.now() - olderThanMinutes * 60_000).toISOString()

  const { data, error } = await supabase
    .from('api_sync_logs')
    .update({
      status: 'failed' as SyncStatus,
      completed_at: new Date().toISOString(),
      error_message: `Orphaned sync — stuck in progress for >${olderThanMinutes}m; marked failed by watchdog.`,
    })
    .eq('ad_account_id', adAccountId)
    .in('status', ['pending', 'running'])
    .lt('created_at', cutoff)
    .select('id')

  if (error) {
    throw new Error(`reconcileOrphanedSyncs failed: ${error.message}`)
  }

  return data?.length ?? 0
}

export async function getLastSuccessfulSync(adAccountId: string): Promise<string | null> {
  const supabase = getAdminClient()

  const { data, error } = await supabase
    .from('api_sync_logs')
    .select('completed_at')
    .eq('ad_account_id', adAccountId)
    .eq('status', 'success')
    .order('completed_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) {
    throw new Error(`getLastSuccessfulSync failed: ${error.message}`)
  }

  if (!data?.completed_at) return null

  return data.completed_at as string
}
