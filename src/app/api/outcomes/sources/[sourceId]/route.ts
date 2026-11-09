import { z } from 'zod'
import { getAdminClient } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'
import { ownerOnly } from '@/lib/auth/require-owner'
import { apiErrorResponse } from '@/lib/security/api-error'
import { enforceApiRateLimit } from '@/lib/security/api-rate-limit'
import { rejectCrossOriginMutation } from '@/lib/security/same-origin'
import { activeAccountOrResponse } from '@/lib/outcomes/adapters/webhook/owner-route'
import { setOutcomeSourceEnabled } from '@/lib/outcomes/source-admin'

export const runtime = 'nodejs'

// PATCH /api/outcomes/sources/<id> { enabled }: owner only, same-origin, rate limited. Turns one of
// the active account's outcome sources on or off. A disabled source's outcomes stay stored and are
// counted nowhere (src/lib/outcomes/source-health.ts); re-enabling counts them again.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const bodySchema = z.strictObject({ enabled: z.boolean() })

export async function PATCH(req: Request, { params }: { params: Promise<{ sourceId: string }> }) {
  const crossOrigin = rejectCrossOriginMutation(req)
  if (crossOrigin) return crossOrigin
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 })
  const forbidden = ownerOnly(user)
  if (forbidden) return forbidden
  const { sourceId } = await params
  if (!UUID.test(sourceId)) return Response.json({ error: 'Unknown outcome source.', code: 'INVALID_SOURCE_ID' }, { status: 400 })
  let body: z.infer<typeof bodySchema>
  try {
    body = bodySchema.parse(await req.json())
  } catch {
    return Response.json({ error: 'Send { "enabled": true | false }.', code: 'INVALID_BODY' }, { status: 400 })
  }
  // Toggling is a deliberate owner action; 30 per 10 minutes only absorbs double-clicks.
  const limited = await enforceApiRateLimit({ bucket: 'outcome_source_toggle', actorKey: user.id, limit: 30, windowSeconds: 600 })
  if (limited) return limited
  const owner = await activeAccountOrResponse()
  if ('response' in owner) return owner.response
  try {
    const source = await setOutcomeSourceEnabled(getAdminClient(), owner.adAccountId, sourceId, body.enabled)
    if (!source) return Response.json({ error: 'Unknown outcome source.', code: 'SOURCE_NOT_FOUND' }, { status: 404 })
    return Response.json({ source }, { headers: { 'Cache-Control': 'private, no-store' } })
  } catch (error) {
    return apiErrorResponse('PATCH /api/outcomes/sources/[sourceId]', 'OUTCOME_SOURCE_UPDATE_FAILED', error, 500)
  }
}
