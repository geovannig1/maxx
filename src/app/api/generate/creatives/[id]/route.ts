import { createClient } from '@/lib/supabase/server'
import { getAdminClient } from '@/lib/supabase/admin'
import { ownerOnly } from '@/lib/auth/require-owner'
import { NextRequest } from 'next/server'
import {
  activeAccountErrorCode,
  activeAccountErrorStatus,
  resolveOnlyActiveAccount,
} from '@/lib/accounts/active-account'
import { apiErrorResponse } from '@/lib/security/api-error'
import { rejectCrossOriginMutation } from '@/lib/security/same-origin'

export const runtime = 'nodejs'

// PATCH /api/generate/creatives/[id]  body: { is_approved?: boolean; is_rejected?: boolean }
// Owner-only. Persists the review decision on a GENERATED (draft) creative so /create's Approve/Reject
// is real, not cosmetic. A generated creative lives only in Supabase — this NEVER touches Meta / a live
// campaign (it just marks a draft asset for later manual use).
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const crossOrigin = rejectCrossOriginMutation(req)
  if (crossOrigin) return crossOrigin
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 })
  const forbidden = ownerOnly(user)
  if (forbidden) return forbidden

  const { id } = await ctx.params
  const body = (await req.json().catch(() => ({}))) as { is_approved?: boolean; is_rejected?: boolean }
  const update: Record<string, boolean> = {}
  if (typeof body.is_approved === 'boolean') update.is_approved = body.is_approved
  if (typeof body.is_rejected === 'boolean') update.is_rejected = body.is_rejected
  if (Object.keys(update).length === 0) return Response.json({ error: 'Nothing to update' }, { status: 400 })

  const db = getAdminClient()
  const activeAccount = await resolveOnlyActiveAccount(db)
  if (!activeAccount.ok) {
    return Response.json(
      { error: 'Active ad account scope is unavailable', code: activeAccountErrorCode(activeAccount.reason) },
      { status: activeAccountErrorStatus(activeAccount.reason) },
    )
  }
  const { data: creative, error: lookupError } = await db
    .from('generated_creatives')
    .select('id')
    .eq('id', id)
    .eq('ad_account_id', activeAccount.account.id)
    .maybeSingle()
  if (lookupError) return apiErrorResponse('PATCH /api/generate/creatives/[id]', 'CREATIVE_READ_FAILED', lookupError, 500)
  if (!creative) return Response.json({ error: 'Creative not found' }, { status: 404 })

  const { data: updated, error } = await db
    .from('generated_creatives')
    .update(update)
    .eq('id', id)
    .eq('ad_account_id', activeAccount.account.id)
    .select('id')
    .maybeSingle()
  if (error) return apiErrorResponse('PATCH /api/generate/creatives/[id]', 'CREATIVE_WRITE_FAILED', error, 500)
  if (!updated) return Response.json({ error: 'Creative not found' }, { status: 404 })
  return Response.json({ ok: true, id, ...update })
}
