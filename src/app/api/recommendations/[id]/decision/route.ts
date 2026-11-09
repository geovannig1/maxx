import { createClient } from '@/lib/supabase/server'
import { ownerOnly } from '@/lib/auth/require-owner'
import { getAdminClient } from '@/lib/supabase/admin'
import { NextRequest } from 'next/server'
import { z } from 'zod'
import { USER_DECISIONS, entityKeyFor, derivesActionTaken } from '@/lib/recommendations/decisions'
import { commitRecommendationOwnerTransition } from '@/lib/authority/action-decision-store'
import { ownerTransitionDenial } from '@/lib/authority/owner-transition-denials'
import { activeAccountErrorCode, resolveOnlyActiveAccount } from '@/lib/accounts/active-account'
import { apiErrorResponse } from '@/lib/security/api-error'
import { rejectCrossOriginMutation } from '@/lib/security/same-origin'

export const runtime = 'nodejs'

// PATCH /api/recommendations/[id]/decision — record the human's decision on a recommendation.
// Records INTENT ONLY. It never executes a live change (write mode stays OFF) and never mutates
// learned_patterns; it only decorates the recommendation with what the human chose to do. Keyed by the
// stable (account, entity, type) tuple so it survives daily regeneration. Auth-gated to a signed-in user.
const bodySchema = z.object({
  user_decision: z.enum(USER_DECISIONS),
  decision_note: z.string().max(2000).optional(),
  action_taken: z.boolean().optional(),
  follow_up_date: z.string().max(20).optional(),
  expected_outcome_window: z.string().max(60).optional(),
})

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

  let body: z.infer<typeof bodySchema>
  try {
    body = bodySchema.parse(await req.json())
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

  // Resolve the recommendation to its stable decision key.
  const { data: rec, error: recErr } = await admin
    .from('recommendations')
    .select('id, ad_account_id, target_entity_id, recommendation_type')
    .eq('id', id)
    .eq('ad_account_id', adAccountId)
    .maybeSingle()
  if (recErr) return apiErrorResponse('PATCH /api/recommendations/[id]/decision', 'RECOMMENDATION_READ_FAILED', recErr, 500)
  if (!rec) return Response.json({ error: 'Recommendation not found' }, { status: 404 })

  const action_taken = derivesActionTaken(body.user_decision, body.action_taken)
  let data
  try {
    data = await commitRecommendationOwnerTransition(admin, {
      adAccountId,
      recommendationId: rec.id as string,
      entityKey: entityKeyFor(rec.target_entity_id as string | null),
      recommendationType: rec.recommendation_type as string,
      userDecision: body.user_decision,
      decisionNote: body.decision_note ?? null,
      decidedBy: user.email ?? user.id,
      actionTaken: action_taken,
      followUpDate: body.follow_up_date ?? null,
      expectedOutcomeWindow: body.expected_outcome_window ?? null,
    })
  } catch (error) {
    // Only the governance guard's own authored explanation, matched exactly, reaches the owner;
    // anything else is an unclassified database/runtime failure and stays server-side.
    const denial = ownerTransitionDenial(error)
    if (denial) return Response.json({ error: denial, code: 'RECOMMENDATION_TRANSITION_DENIED' }, { status: 409 })
    return apiErrorResponse('PATCH /api/recommendations/[id]/decision', 'RECOMMENDATION_TRANSITION_FAILED', error, 500)
  }
  // Explicit contract: recording a decision changes nothing live.
  return Response.json({ data, action_allowed_now: false, write_mode: 'off' })
}
