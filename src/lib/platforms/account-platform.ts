import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import { getAdPlatform } from './registry'
import type { AdPlatform, AdPlatformId } from './types'

// Which ad platform an ad account belongs to. ad_accounts.platform (migration 0003) records it; core
// code resolves a platform from the account through adPlatformForAccount, the single resolver, instead
// of naming one. It fails closed: an unregistered, missing or malformed value throws
// UnknownAdPlatformError (from the registry), never falls back to Meta.

/** Any row or object carrying the account's `platform` column. */
export interface PlatformAccount {
  platform?: unknown
}

export class AccountPlatformUnavailableError extends Error {
  constructor(detail: string) {
    super(`The ad account's platform could not be read: ${detail}`)
    this.name = 'AccountPlatformUnavailableError'
  }
}

/** The single resolver: the registered platform the account names. Throws for anything else. */
export function adPlatformForAccount(account: PlatformAccount | null | undefined): AdPlatform {
  const id = account?.platform
  // A non-string (null, a number) becomes a string no platform is registered under.
  return getAdPlatform((typeof id === 'string' ? id : `<${String(id)}>`) as AdPlatformId)
}

type Db = Pick<SupabaseClient, 'from'>

/** The platform of one account, by its database id. Throws when it cannot be read or is unknown. */
export async function loadAccountPlatform(db: Db, adAccountDbId: string): Promise<AdPlatform> {
  const { data, error } = await db.from('ad_accounts').select('platform').eq('id', adAccountDbId).maybeSingle()
  if (error) throw new AccountPlatformUnavailableError(error.message)
  if (!data) throw new AccountPlatformUnavailableError('account not found')
  return adPlatformForAccount(data as PlatformAccount)
}

/** The platform of the only active account (the single-account install). Throws when there is not
 *  exactly one active account, when it cannot be read, or when its platform is unknown. */
export async function loadActiveAccountPlatform(db: Db): Promise<AdPlatform> {
  const { data, error } = await db.from('ad_accounts').select('platform').eq('is_active', true).limit(2)
  if (error) throw new AccountPlatformUnavailableError(error.message)
  const rows = (data ?? []) as PlatformAccount[]
  if (rows.length !== 1) throw new AccountPlatformUnavailableError(rows.length === 0 ? 'no active account' : 'more than one active account')
  return adPlatformForAccount(rows[0])
}
