import type { SupabaseClient } from '@supabase/supabase-js'
import { getAdminClient } from '@/lib/supabase/admin'
import { resolveOnlyActiveAccount } from '@/lib/accounts/active-account'

/** The exactly-one active ad account's DB id, or null when ownership is absent, ambiguous, or unreadable. */
export async function resolveAdAccountId(supabase: SupabaseClient = getAdminClient()): Promise<string | null> {
  const activeAccount = await resolveOnlyActiveAccount(supabase)
  return activeAccount.ok ? activeAccount.account.id : null
}
