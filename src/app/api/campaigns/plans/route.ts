import { NextRequest } from 'next/server'
import { planBriefSchema } from '@/lib/campaigns/plan-brief'
import { draftCampaignPlan, listPlans } from '@/lib/campaigns/plan-repository'
import { parsePlanBody, planRateLimit, planSessionUser, privateJson } from '@/lib/campaigns/plan-route'
import { apiErrorResponse } from '@/lib/security/api-error'
import { ownerOnly } from '@/lib/auth/require-owner'
import { rejectCrossOriginMutation } from '@/lib/security/same-origin'

export const runtime = 'nodejs'
export const maxDuration = 120

// ADR-062. GET: the active account's campaign plans with their latest status.
// POST: draft a plan from a brief (one model call when AI is on and asked for; the template otherwise)
// and store it as a DRAFT version. Nothing here touches Meta, approves or submits anything.
const MAX_BODY_BYTES = 8_192

export async function GET() {
  const session = await planSessionUser()
  if (!session.ok) return session.response
  const forbidden = ownerOnly(session.user)
  if (forbidden) return forbidden
  const result = await listPlans()
  return result.ok ? privateJson({ plans: result.rows }) : privateJson({ error: 'Campaign plans could not be read.', code: result.code }, { status: 503 })
}

export async function POST(req: NextRequest) {
  // A draft may cost one planning and one copy call: 10 per 10 minutes, like the Copy studio.
  const crossOrigin = rejectCrossOriginMutation(req)
  if (crossOrigin) return crossOrigin
  const session = await planSessionUser()
  if (!session.ok) return session.response
  const forbidden = ownerOnly(session.user)
  if (forbidden) return forbidden
  const limited = await planRateLimit(session.user.id, 'campaign_plan_draft', 10)
  if (limited) return limited
  const owner = { user: { id: session.user.id, email: session.user.email ?? null } }
  const body = await parsePlanBody(req, MAX_BODY_BYTES, planBriefSchema)
  if (!body.ok) return body.response
  try {
    const result = await draftCampaignPlan(body.data, { ownerUserId: owner.user.id })
    return privateJson(result.body, { status: result.http })
  } catch (error) {
    return apiErrorResponse('POST /api/campaigns/plans', 'CAMPAIGN_PLAN_DRAFT_FAILED', error, 500)
  }
}
