import { createClient } from '@/lib/supabase/server'
import { ownerOnly } from '@/lib/auth/require-owner'
import { getAdminClient } from '@/lib/supabase/admin'
import { NextRequest } from 'next/server'
import { z } from 'zod'
import { activeAccountErrorCode, resolveOnlyActiveAccount } from '@/lib/accounts/active-account'
import { apiErrorResponse } from '@/lib/security/api-error'
import { rejectCrossOriginMutation } from '@/lib/security/same-origin'

export const runtime = 'nodejs'

const resolveSchema = z.object({
  resolved: z.literal(true),
  resolution_note: z.string().min(1).max(1000).optional(),
})

// PATCH /api/alerts/[id] — resolve an alert
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const crossOrigin = rejectCrossOriginMutation(req)
  if (crossOrigin) return crossOrigin
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const forbidden = ownerOnly(user)
  if (forbidden) return forbidden

  const { id } = await params

  let body: z.infer<typeof resolveSchema>
  try {
    const raw = await req.json()
    body = resolveSchema.parse(raw)
  } catch {
    return Response.json({ error: 'Invalid request body' }, { status: 400 })
  }

  const adminClient = getAdminClient()
  const activeAccount = await resolveOnlyActiveAccount(adminClient)
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
  const adAccountId = activeAccount.account.id

  // Verify alert exists
  const { data: rawExisting, error: fetchError } = await adminClient
    .from('alerts')
    .select('id, ad_account_id, is_resolved')
    .eq('id', id)
    .eq('ad_account_id', adAccountId)
    .maybeSingle()
  const existing = rawExisting as { id: string; ad_account_id: string; is_resolved: boolean } | null

  if (fetchError) {
    return apiErrorResponse('PATCH /api/alerts/[id]', 'ALERT_READ_FAILED', fetchError, 500)
  }

  if (!existing) {
    return Response.json({ error: 'Alert not found' }, { status: 404 })
  }

  if (existing.is_resolved) {
    return Response.json({ error: 'Alert is already resolved' }, { status: 409 })
  }

  const { data, error } = await adminClient
    .from('alerts')
    .update({
      is_resolved: true,
      resolved_at: new Date().toISOString(),
      resolved_by: user.email ?? user.id,
      resolution_note: body.resolution_note ?? null,
    })
    .eq('id', id)
    .eq('ad_account_id', adAccountId)
    .select()
    .single()

  if (error) {
    return apiErrorResponse('PATCH /api/alerts/[id]', 'ALERT_WRITE_FAILED', error, 500)
  }

  return Response.json({ data })
}
