import { NextRequest } from 'next/server'
import { ownerOnly } from '@/lib/auth/require-owner'
import { createClient } from '@/lib/supabase/server'
import { rejectCrossOriginMutation } from '@/lib/security/same-origin'
import { proposeRollback } from '@/lib/writes/owner-changes'

export const runtime = 'nodejs'

// POST /api/changes/[id]/rollback — propose the inverse of an executed change (ADR-059 §7). Owner-only
// and same-origin. Creates a PENDING rollback request for the owner to approve; it applies nothing.
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 })
  const forbidden = ownerOnly(user)
  if (forbidden) return forbidden
  const crossOrigin = rejectCrossOriginMutation(req)
  if (crossOrigin) return crossOrigin

  const { id } = await ctx.params
  const result = await proposeRollback({ changeRequestId: id, ownerUserId: user.id, actor: user.email ?? 'owner' })
  const { http, ...payload } = result
  return Response.json(payload, { status: http })
}
