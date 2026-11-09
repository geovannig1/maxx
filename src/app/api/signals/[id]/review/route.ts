import { createClient } from '@/lib/supabase/server'
import { ownerOnly } from '@/lib/auth/require-owner'
import { getAdminClient } from '@/lib/supabase/admin'
import { NextRequest } from 'next/server'
import { z } from 'zod'
import { activeAccountErrorCode, resolveOnlyActiveAccount } from '@/lib/accounts/active-account'
import { apiErrorResponse } from '@/lib/security/api-error'
import { rejectCrossOriginMutation } from '@/lib/security/same-origin'

export const runtime = 'nodejs'

// PATCH /api/signals/[id]/review — the human APPROVAL GATE on external expert knowledge (`expert_insights.review_status`).
// Only APPROVED insights may be cited in recommendations (knowledge.filterUsableInsights) or surfaced
// as advice-adjacent signals (morning brief, dashboard TrendSignals). This changes nothing live —
// write mode stays OFF; it only governs which outside opinions Maxx may repeat. Auth-gated.
const reviewSchema = z.object({
  review_status: z.enum(['approved', 'rejected', 'pending']),
  reviewed_note: z.string().max(2000).optional(),
  // Freshness: owner-set TTL on approval. ISO date string extends/sets the expiry; explicit null
  // removes it (approved evergreen); omitted = leave the fetcher's default TTL untouched.
  expires_at: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
})

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

  let body: z.infer<typeof reviewSchema>
  try {
    body = reviewSchema.parse(await req.json())
  } catch {
    return Response.json({ error: 'Invalid request body' }, { status: 400 })
  }

  const admin = getAdminClient()
  const activeAccount = await resolveOnlyActiveAccount(admin)
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

  const { data: existing, error: fetchError } = await admin
    .from('expert_insights')
    .select('id, ad_account_id')
    .eq('id', id)
    .eq('ad_account_id', adAccountId)
    .maybeSingle()
  if (fetchError) return apiErrorResponse('PATCH /api/signals/[id]/review', 'SIGNAL_READ_FAILED', fetchError, 500)
  if (!existing) return Response.json({ error: 'Insight not found' }, { status: 404 })

  const reviewing = body.review_status !== 'pending'
  const update: Record<string, unknown> = {
    review_status: body.review_status,
    reviewed_at: reviewing ? new Date().toISOString() : null,
    reviewed_note: body.reviewed_note ?? null,
  }
  if (body.expires_at !== undefined) update.expires_at = body.expires_at // owner-set TTL (null = evergreen)

  const { data, error } = await admin
    .from('expert_insights')
    .update(update)
    .eq('id', id)
    .eq('ad_account_id', adAccountId)
    .select('id, review_status, reviewed_at, expires_at')
    .single()

  if (error) return apiErrorResponse('PATCH /api/signals/[id]/review', 'SIGNAL_REVIEW_WRITE_FAILED', error, 500)

  return Response.json({ data })
}
