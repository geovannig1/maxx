import 'server-only'
import { createClient } from '@/lib/supabase/server'
import { enforceApiRateLimit } from '@/lib/security/api-rate-limit'
import { privateJson } from '@/lib/creative/copy-route'

export { parseCopyBody as parsePlanBody, privateJson } from '@/lib/creative/copy-route'

// ADR-062: shared pieces of the campaign-plan routes. Each handler itself checks, in order and before
// any database or model work: same-origin (mutations), a signed-in user, the owner gate, then a
// per-owner rate limit.

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type SessionUser = NonNullable<Awaited<ReturnType<Awaited<ReturnType<typeof createClient>>['auth']['getUser']>>['data']['user']>

export async function planSessionUser(): Promise<{ ok: true; user: SessionUser } | { ok: false; response: Response }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  return user ? { ok: true, user } : { ok: false, response: privateJson({ error: 'Unauthorized' }, { status: 401 }) }
}

export function planRateLimit(userId: string, bucket: string, limit: number, windowSeconds = 600): Promise<Response | null> {
  return enforceApiRateLimit({ bucket, actorKey: userId, limit, windowSeconds })
}
