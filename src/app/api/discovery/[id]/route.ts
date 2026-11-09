import { getAdminClient } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'
import { ownerOnly } from '@/lib/auth/require-owner'
import { resolveOnlyActiveAccount } from '@/lib/accounts/active-account'
import { NextRequest } from 'next/server'
import { apiErrorResponse } from '@/lib/security/api-error'
import { rejectCrossOriginMutation } from '@/lib/security/same-origin'

export const runtime = 'nodejs'

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const crossOrigin = rejectCrossOriginMutation(req)
  if (crossOrigin) return crossOrigin
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 })
  const forbidden = ownerOnly(user)
  if (forbidden) return forbidden

  const { id } = await params
  let body: { is_saved?: boolean; user_notes?: string }
  try { body = await req.json() } catch { return Response.json({ error: 'Invalid JSON' }, { status: 400 }) }

  const db = getAdminClient()
  const activeAccount = await resolveOnlyActiveAccount(db)
  if (!activeAccount.ok) {
    return Response.json(
      { error: `Active account ownership is ${activeAccount.reason}.` },
      { status: activeAccount.reason === 'unavailable' ? 500 : 409 },
    )
  }

  const { data: sources, error: sourceError } = await db
    .from('competitor_sources')
    .select('id')
    .eq('ad_account_id', activeAccount.account.id)

  if (sourceError) return apiErrorResponse('discovery/[id]', 'competitor_sources_read_failed', sourceError)
  const sourceIds = (sources ?? []).map((source) => String(source.id))
  if (sourceIds.length === 0) return Response.json({ error: 'Competitor ad not found' }, { status: 404 })

  const update: Record<string, unknown> = {}
  if (body.is_saved !== undefined) {
    update.is_saved = body.is_saved
    update.saved_at = body.is_saved ? new Date().toISOString() : null
  }
  if (body.user_notes !== undefined) update.user_notes = body.user_notes

  if (Object.keys(update).length === 0) {
    return Response.json({ error: 'No updatable fields provided' }, { status: 400 })
  }

  const { data: updated, error } = await db
    .from('competitor_ads')
    .update(update)
    .eq('id', id)
    .in('competitor_id', sourceIds)
    .select('id')
    .maybeSingle()
  if (error) return apiErrorResponse('discovery/[id]', 'competitor_ad_update_failed', error)
  if (!updated) return Response.json({ error: 'Competitor ad not found' }, { status: 404 })
  return Response.json({ success: true })
}
