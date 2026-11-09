import { createClient } from '@/lib/supabase/server'
import { ownerOnly } from '@/lib/auth/require-owner'
import { campaignPlanCreativeUnavailablePayload } from '@/lib/creative/campaign-plan-gate'
import { NextRequest } from 'next/server'
import { rejectCrossOriginMutation } from '@/lib/security/same-origin'

export const runtime = 'nodejs'

export async function POST(_req: NextRequest) {
  const crossOrigin = rejectCrossOriginMutation(_req)
  if (crossOrigin) return crossOrigin
  void _req
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 })
  const forbidden = ownerOnly(user)
  if (forbidden) return forbidden

  return Response.json(campaignPlanCreativeUnavailablePayload(), { status: 409 })
}
