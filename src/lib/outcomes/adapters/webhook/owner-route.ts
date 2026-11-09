import { getAdminClient } from '@/lib/supabase/admin'
import {
  activeAccountErrorCode,
  activeAccountErrorStatus,
  resolveOnlyActiveAccount,
} from '@/lib/accounts/active-account'

/** A response that carries a signing secret: never cached by a browser or a CDN. */
export function secretResponse(body: Record<string, unknown>, status = 200): Response {
  return Response.json(body, { status, headers: { 'Cache-Control': 'private, no-store' } })
}

/** The sole active ad account for the webhook source management routes, or the response to send. */
export async function activeAccountOrResponse(): Promise<{ adAccountId: string } | { response: Response }> {
  const active = await resolveOnlyActiveAccount(getAdminClient())
  if (active.ok) return { adAccountId: active.account.id }
  return {
    response: Response.json(
      { error: 'The active ad account could not be resolved.', code: activeAccountErrorCode(active.reason) },
      { status: activeAccountErrorStatus(active.reason) },
    ),
  }
}
