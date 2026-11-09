import { NextRequest } from 'next/server'
import { z } from 'zod'
import { editPlanVersion } from '@/lib/campaigns/plan-repository'
import { UUID, parsePlanBody, planRateLimit, planSessionUser, privateJson } from '@/lib/campaigns/plan-route'
import { apiErrorResponse } from '@/lib/security/api-error'
import { ownerOnly } from '@/lib/auth/require-owner'
import { rejectCrossOriginMutation } from '@/lib/security/same-origin'

export const runtime = 'nodejs'

// POST /api/campaigns/plans/[planId]/versions: save the owner's edit as the plan's next version. The
// server re-validates the whole spec against the account; versions are immutable (ADR-062).
const MAX_BODY_BYTES = 65_536
const bodySchema = z.object({ spec: z.record(z.string(), z.unknown()) }).strict()

export async function POST(req: NextRequest, ctx: { params: Promise<{ planId: string }> }) {
  const crossOrigin = rejectCrossOriginMutation(req)
  if (crossOrigin) return crossOrigin
  const session = await planSessionUser()
  if (!session.ok) return session.response
  const forbidden = ownerOnly(session.user)
  if (forbidden) return forbidden
  const limited = await planRateLimit(session.user.id, 'campaign_plan_edit', 60)
  if (limited) return limited
  const owner = { user: { id: session.user.id, email: session.user.email ?? null } }
  const body = await parsePlanBody(req, MAX_BODY_BYTES, bodySchema)
  if (!body.ok) return body.response
  const { planId } = await ctx.params
  if (!UUID.test(planId)) return privateJson({ error: 'Plan not found.', code: 'PLAN_NOT_FOUND' }, { status: 404 })
  try {
    const result = await editPlanVersion({ planId, ownerUserId: owner.user.id, spec: body.data.spec })
    return privateJson(result.body, { status: result.http })
  } catch (error) {
    return apiErrorResponse('POST /api/campaigns/plans/[planId]/versions', 'CAMPAIGN_PLAN_EDIT_FAILED', error, 500)
  }
}
