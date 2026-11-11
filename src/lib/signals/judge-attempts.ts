import { AiProviderError, AiTimeoutError } from '@/lib/ai'
import { OperationTimeoutError } from '@/lib/cron/time-budget'
import type { getAdminClient } from '@/lib/supabase/admin'

/**
 * Transient judge failures per feed item (migration 20261110120000; `network` since
 * 0004_secret_rotation_grace.sql). A timeout, a 429, a provider 5xx or a transport failure with no HTTP
 * status (connection reset, DNS, closed socket) says nothing about the item, so the item is not stored and is judged again on a later run; this
 * table counts those failures so the retry is bounded. A row exists only while an item is waiting for
 * another attempt: storing the item, judged or not, removes it.
 */

type Db = ReturnType<typeof getAdminClient>

export type TransientAiFailureKind = 'timeout' | 'rate_limit' | 'server' | 'network'

const TABLE = 'expert_insight_judge_attempts'

/**
 * The transient kind of an AI failure, or null when retrying cannot help. Only the gateway's own
 * classification counts (src/lib/ai/errors.ts) plus our own wait limit: a refusal, unusable output, a
 * client error (4xx), an auth error or an invalid response is terminal for the item. Retries stay
 * bounded by SIGNALS_JUDGE_MAX_TRANSIENT_FAILURES whatever the kind.
 */
export function transientAiFailureKind(error: unknown): TransientAiFailureKind | null {
  if (error instanceof AiTimeoutError || error instanceof OperationTimeoutError) return 'timeout'
  if (error instanceof AiProviderError && (error.kind === 'rate_limit' || error.kind === 'server' || error.kind === 'network')) return error.kind
  return null
}

export async function readTransientFailures(db: Db, adAccountId: string, title: string): Promise<number> {
  const { data, error } = await db.from(TABLE).select('transient_failures')
    .eq('ad_account_id', adAccountId).eq('title', title).maybeSingle()
  if (error) throw new Error(`${TABLE} read failed: ${error.message}`)
  return (data as { transient_failures: number } | null)?.transient_failures ?? 0
}

export async function recordTransientFailure(
  db: Db, adAccountId: string, title: string, failures: number, kind: TransientAiFailureKind,
): Promise<void> {
  const { error } = await db.from(TABLE).upsert({
    ad_account_id: adAccountId,
    title,
    transient_failures: failures,
    last_failure_kind: kind,
    last_failed_at: new Date().toISOString(),
  }, { onConflict: 'ad_account_id,title' })
  if (error) throw new Error(`${TABLE} write failed: ${error.message}`)
}

export async function clearTransientFailures(db: Db, adAccountId: string, title: string): Promise<void> {
  const { error } = await db.from(TABLE).delete().eq('ad_account_id', adAccountId).eq('title', title)
  if (error) throw new Error(`${TABLE} delete failed: ${error.message}`)
}
