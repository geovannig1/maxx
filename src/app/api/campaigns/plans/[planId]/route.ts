import { NextRequest } from 'next/server'
import { getPlan } from '@/lib/campaigns/plan-repository'
import { UUID, planSessionUser, privateJson } from '@/lib/campaigns/plan-route'
import { ownerOnly } from '@/lib/auth/require-owner'

export const runtime = 'nodejs'

// GET /api/campaigns/plans/[planId]: one plan of the active account with its versions, their
// validation and readiness, its change requests and the objects created (ADR-062). Owner-only.
export async function GET(_req: NextRequest, ctx: { params: Promise<{ planId: string }> }) {
  const session = await planSessionUser()
  if (!session.ok) return session.response
  const forbidden = ownerOnly(session.user)
  if (forbidden) return forbidden
  const { planId } = await ctx.params
  if (!UUID.test(planId)) return privateJson({ error: 'Plan not found.', code: 'PLAN_NOT_FOUND' }, { status: 404 })
  const result = await getPlan(planId)
  return result.ok ? privateJson(result.detail) : privateJson({ error: 'The plan could not be read.', code: result.code }, { status: result.http })
}
