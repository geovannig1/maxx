import 'server-only'
import type { getAdminClient } from '@/lib/supabase/admin'

// The per-account execution lock is an action_log row 'executing' (one per account, by unique index).
// A run that crashed leaves it behind and every write on the account then waits (security review M1).
// This module only DESCRIBES the lock; nothing here takes it over. The owner recovers a stale run from
// /changes (stuck-change-recovery.ts), never an executor silently.

type Db = ReturnType<typeof getAdminClient>

export const DEFAULT_STALE_MINUTES = 15

/** Minutes after which an 'executing' run counts as stuck (CHANGE_RECOVERY_STALE_MINUTES, default 15).
 *  Above the 300 s maxDuration of PATCH /api/changes/[id], so a live run on Vercel is never stuck. */
export function staleMinutes(env: Record<string, string | undefined> = process.env): number {
  const raw = env.CHANGE_RECOVERY_STALE_MINUTES?.trim() ?? ''
  return /^[1-9]\d{0,4}$/.test(raw) ? Number(raw) : DEFAULT_STALE_MINUTES
}

export const isStale = (createdAt: string, now = Date.now()): boolean =>
  Number.isFinite(Date.parse(createdAt)) && now - Date.parse(createdAt) >= staleMinutes() * 60_000

/** Extra detail for an ACCOUNT_WRITE_IN_PROGRESS answer: when the run holding the lock is stale, which
 *  change it is and that the owner can recover it. Empty when it is not stale or cannot be read. */
export async function describeAccountLock(db: Db, accountId: string): Promise<Record<string, unknown>> {
  try {
    const { data, error } = await db.from('action_log').select('change_request_id, created_at')
      .eq('ad_account_id', accountId).eq('status', 'executing').limit(1)
    const row = (error ? null : (data ?? [])[0]) as { change_request_id: string | null; created_at: string } | undefined | null
    if (!row || !isStale(row.created_at)) return {}
    return {
      stuck_change_request_id: row.change_request_id, stuck_since: row.created_at, recoverable: true,
      message: 'A change on this ad account started and never finished. Nothing was sent to Meta for this one. Recover the stuck change on Changes ("Recover stuck change"), then try again.',
    }
  } catch {
    return {}
  }
}

/** change_request_id -> started_at for every stale 'executing' run of the account (for /changes). */
export async function stuckRunsByRequest(db: Db, accountId: string): Promise<Map<string, string>> {
  const { data, error } = await db.from('action_log').select('change_request_id, created_at')
    .eq('ad_account_id', accountId).eq('status', 'executing')
  if (error) { console.error('[ACCOUNT LOCK] executing runs read failed:', error.message); return new Map() }
  return new Map(((data ?? []) as Array<{ change_request_id: string | null; created_at: string }>)
    .filter((r) => r.change_request_id && isStale(r.created_at)).map((r) => [r.change_request_id as string, r.created_at]))
}
