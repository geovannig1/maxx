import { rejectCrossOriginMutation } from '@/lib/security/same-origin'
import { createClient } from '@/lib/supabase/server'
import { getAdminClient } from '@/lib/supabase/admin'
import { ownerGate } from '@/lib/auth/owner'
import { activeAccountErrorCode, resolveOnlyActiveAccount } from '@/lib/accounts/active-account'
import { REVIEW_ACTIONS, reviewChangeRequest, type ReviewAction } from '@/lib/writes/change-review'
import { NextRequest } from 'next/server'

export const runtime = 'nodejs'
// An apply waits on Meta (a campaign plan creates up to ~60 objects). Give it the platform maximum, so a
// slow run is not killed between a Meta write and its audit (security review M1). A run that still
// dies is recovered by the owner on /changes once it is stale (CHANGE_RECOVERY_STALE_MINUTES).
export const maxDuration = 300

// PATCH /api/changes/[id]  body: { action: 'approve' | 'reject' | 'execute' | 'approve_and_apply' | 'recover', reason?: string }
// Owner-only and same-origin. Approval/rejection transitions the linked ActionDecision and change
// request in ONE database transaction. approve_and_apply applies only when WRITE_MODE_ENABLED is on
// (or through the simulated executor in demo mode); execution keeps every executor gate (ADR-059).
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 })
  if (!ownerGate(user).allowed) {
    return Response.json({ error: 'Forbidden — owner only' }, { status: 403 })
  }
  const crossOrigin = rejectCrossOriginMutation(req)
  if (crossOrigin) return crossOrigin

  const { id } = await ctx.params
  const body = (await req.json().catch(() => ({}))) as { action?: string; reason?: string }
  if (!body.action || !REVIEW_ACTIONS.includes(body.action as ReviewAction)) {
    return Response.json({ error: 'Unknown action — use approve | reject | execute | approve_and_apply | recover' }, { status: 400 })
  }

  const db = getAdminClient()
  const activeAccount = await resolveOnlyActiveAccount(db)
  if (!activeAccount.ok) {
    const status = activeAccount.reason === 'not_found' ? 404 : activeAccount.reason === 'ambiguous' ? 409 : 503
    return Response.json({
      error: activeAccount.reason === 'ambiguous'
        ? 'More than one active ad account is configured.'
        : activeAccount.reason === 'not_found'
          ? 'No active ad account is configured.'
          : 'The active ad account could not be resolved.',
      code: activeAccountErrorCode(activeAccount.reason),
    }, { status })
  }

  const result = await reviewChangeRequest({
    id,
    action: body.action as ReviewAction,
    actor: user.email ?? 'owner',
    accountId: activeAccount.account.id,
    reason: typeof body.reason === 'string' ? body.reason.slice(0, 500) : null,
  })
  return Response.json(result.body, { status: result.http })
}
