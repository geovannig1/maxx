import { NextRequest } from 'next/server'
import { z } from 'zod'
import { submitPlanForApproval } from '@/lib/campaigns/plan-submission'
import { UUID, parsePlanBody, planRateLimit, planSessionUser, privateJson } from '@/lib/campaigns/plan-route'
import { apiErrorResponse } from '@/lib/security/api-error'
import { ownerOnly } from '@/lib/auth/require-owner'
import { rejectCrossOriginMutation } from '@/lib/security/same-origin'

export const runtime = 'nodejs'

// POST /api/campaigns/plans/[planId]/submit: turn a validated draft into an owner-initiated
// create_campaign_paused change request for /changes (ADR-062). It approves and creates nothing.
const MAX_BODY_BYTES = 1_024
const bodySchema = z.object({ version_id: z.string().regex(UUID), confirm_budget_step: z.boolean().optional() }).strict()

export async function POST(req: NextRequest, ctx: { params: Promise<{ planId: string }> }) {
  const crossOrigin = rejectCrossOriginMutation(req)
  if (crossOrigin) return crossOrigin
  const session = await planSessionUser()
  if (!session.ok) return session.response
  const forbidden = ownerOnly(session.user)
  if (forbidden) return forbidden
  const limited = await planRateLimit(session.user.id, 'campaign_plan_submit', 30)
  if (limited) return limited
  const owner = { user: { id: session.user.id, email: session.user.email ?? null } }
  const body = await parsePlanBody(req, MAX_BODY_BYTES, bodySchema)
  if (!body.ok) return body.response
  const { planId } = await ctx.params
  if (!UUID.test(planId)) return privateJson({ error: 'Plan not found.', code: 'PLAN_NOT_FOUND' }, { status: 404 })
  try {
    const result = await submitPlanForApproval({
      versionId: body.data.version_id, ownerUserId: owner.user.id, actor: owner.user.email ?? 'owner',
      confirmBudgetStep: body.data.confirm_budget_step === true, planId,
    })
    return privateJson(result.body, { status: result.http })
  } catch (error) {
    return apiErrorResponse('POST /api/campaigns/plans/[planId]/submit', 'CAMPAIGN_PLAN_SUBMIT_FAILED', error, 500)
  }
}
