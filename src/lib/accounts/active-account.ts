import { getAdminClient } from '@/lib/supabase/admin'

export interface ResolvedActiveAccount {
  id: string
  /** Meta's account identifier (normally `act_<digits>`), distinct from the database UUID. */
  accountId: string
  accountName: string | null
}

export type ActiveAccountResolution =
  | { ok: true; account: ResolvedActiveAccount }
  | { ok: false; reason: 'not_found' | 'ambiguous' | 'unavailable' }

export type ActiveAccountErrorCode =
  | 'ACTIVE_ACCOUNT_NOT_FOUND'
  | 'ACTIVE_ACCOUNT_AMBIGUOUS'
  | 'ACTIVE_ACCOUNT_UNAVAILABLE'

/**
 * Resolve account ownership only when exactly one active row exists.
 *
 * `limit(2)` is intentional: there is no database uniqueness constraint on active accounts, so
 * `limit(1)` would hide an ambiguous owner/model scope. Inactive rows never participate.
 */
export async function resolveOnlyActiveAccount(
  db: ReturnType<typeof getAdminClient> = getAdminClient(),
): Promise<ActiveAccountResolution> {
  try {
    const { data, error } = await db.from('ad_accounts').select('id, account_id, account_name').eq('is_active', true).limit(2)
    if (error) return { ok: false, reason: 'unavailable' }
    if (!data || data.length === 0) return { ok: false, reason: 'not_found' }
    if (data.length !== 1) return { ok: false, reason: 'ambiguous' }

    const id = data[0]?.id
    const accountId = data[0]?.account_id
    if (
      typeof id !== 'string'
      || id.length === 0
      || typeof accountId !== 'string'
      || accountId.length === 0
    ) return { ok: false, reason: 'unavailable' }

    const accountName = data[0]?.account_name
    return {
      ok: true,
      account: {
        id,
        accountId,
        accountName: typeof accountName === 'string' && accountName.length > 0 ? accountName : null,
      },
    }
  } catch {
    return { ok: false, reason: 'unavailable' }
  }
}

export function activeAccountErrorCode(
  reason: Exclude<ActiveAccountResolution, { ok: true }>['reason'],
): ActiveAccountErrorCode {
  if (reason === 'not_found') return 'ACTIVE_ACCOUNT_NOT_FOUND'
  if (reason === 'ambiguous') return 'ACTIVE_ACCOUNT_AMBIGUOUS'
  return 'ACTIVE_ACCOUNT_UNAVAILABLE'
}

export function activeAccountErrorStatus(
  reason: Exclude<ActiveAccountResolution, { ok: true }>['reason'],
): 404 | 409 | 503 {
  if (reason === 'not_found') return 404
  if (reason === 'ambiguous') return 409
  return 503
}
