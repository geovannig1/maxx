import { createClient } from '@/lib/supabase/server'
import { ownerOnly } from '@/lib/auth/require-owner'
import { getAdminClient } from '@/lib/supabase/admin'
import { NextRequest } from 'next/server'
import { z } from 'zod'
import { recomputeLearnedPatterns } from '@/lib/learning/patterns'
import { nyToday } from '@/lib/utils/date-utils'
import { activeAccountErrorCode, resolveOnlyActiveAccount } from '@/lib/accounts/active-account'
import { apiErrorResponse } from '@/lib/security/api-error'
import { rejectCrossOriginMutation } from '@/lib/security/same-origin'

export const runtime = 'nodejs'

// PATCH /api/outcomes/[id]/review — the human LEARNING GATE. Sets an auto-scored recommendation outcome
// to approved / rejected / pending. Only APPROVED outcomes feed trusted win-rates + the track-record
// adjuster (see patterns.ts / knowledge.tallyTrackRecord). This changes nothing live — write mode stays
// OFF; it only governs what Maxx is allowed to LEARN from. Auth-gated to a signed-in user.
const reviewSchema = z.object({
  // 'inconclusive' is a human override — the reviewer judges the data too weak to trust. Like rejected,
  // it is NOT 'approved', so the gate excludes it from win-rates + the track record automatically.
  review_status: z.enum(['approved', 'rejected', 'inconclusive', 'pending']),
  reviewed_note: z.string().max(2000).optional(),
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
    .from('recommendation_outcomes')
    .select('id, ad_account_id, outcome')
    .eq('id', id)
    .eq('ad_account_id', adAccountId)
    .maybeSingle()
  if (fetchError) return apiErrorResponse('PATCH /api/outcomes/[id]/review', 'OUTCOME_READ_FAILED', fetchError, 500)
  if (!existing) return Response.json({ error: 'Outcome not found' }, { status: 404 })

  const reviewing = body.review_status !== 'pending'
  const { data, error } = await admin
    .from('recommendation_outcomes')
    .update({
      review_status: body.review_status,
      reviewed_at: reviewing ? new Date().toISOString() : null,
      reviewed_note: body.reviewed_note ?? null,
    })
    .eq('id', id)
    .eq('ad_account_id', adAccountId)
    .select('id, review_status, reviewed_at')
    .single()

  if (error) return apiErrorResponse('PATCH /api/outcomes/[id]/review', 'OUTCOME_REVIEW_WRITE_FAILED', error, 500)

  // A review changes which outcomes count toward trusted win-rates — recompute patterns NOW instead of
  // waiting for the next daily cron (kills the up-to-24h lag between an approval and the dashboards /
  // track-record reflecting it). Non-fatal: patterns also recompute in cron Step 15.
  let patterns_recomputed = false
  try {
    await recomputeLearnedPatterns(adAccountId, nyToday())
    patterns_recomputed = true
  } catch (e) {
    console.warn('[review] pattern recompute skipped:', e instanceof Error ? e.message : String(e))
  }

  return Response.json({ data, patterns_recomputed })
}
