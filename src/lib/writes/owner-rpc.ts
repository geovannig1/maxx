import 'server-only'
import type { getAdminClient } from '@/lib/supabase/admin'
import { ownerUserIdMismatch } from '@/lib/auth/owner-identity'

// The one TS entry to the owner-initiated RPCs (security review L5). The service role is the trust
// boundary (docs/security-model.md): these SECURITY DEFINER functions trust the owner id they are given.
// So every caller goes through here, and an id that is not the pinned owner never reaches the database.
// tests/owner-rpc-single-entry.test.ts fails if any other module names these RPCs.

type Db = ReturnType<typeof getAdminClient>
export type OwnerRpc = 'create_owner_change_request' | 'create_campaign_plan_version' | 'create_campaign_plan_change_request'

export const OWNER_IDENTITY_MISMATCH = 'owner_identity_mismatch'

export async function callOwnerRpc(db: Db, fn: OwnerRpc, args: Record<string, unknown> & { p_owner_user_id: unknown }): Promise<{ data: unknown; error: { message: string } | null }> {
  if (ownerUserIdMismatch(typeof args.p_owner_user_id === 'string' ? args.p_owner_user_id : null)) {
    console.error(`[OWNER RPC] ${fn} refused: the owner id is not the pinned owner`)
    return { data: null, error: { message: OWNER_IDENTITY_MISMATCH } }
  }
  const { data, error } = await db.rpc(fn, args)
  return { data, error: error ? { message: error.message } : null }
}
