import { getAdminClient } from '@/lib/supabase/admin'
import { apiErrorResponse } from '@/lib/security/api-error'
import { rotateWebhookSecret } from '@/lib/outcomes/adapters/webhook/sources'
import { createClient } from '@/lib/supabase/server'
import { ownerOnly } from '@/lib/auth/require-owner'
import { activeAccountOrResponse, secretResponse } from '@/lib/outcomes/adapters/webhook/owner-route'
import { rejectCrossOriginMutation } from '@/lib/security/same-origin'

export const runtime = 'nodejs'

// POST /api/outcomes/webhook-sources/<id>/rotate — owner only. Replaces the source's signing secret and
// returns the new one ONCE. The old secret stops verifying immediately.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ROUTE = 'POST /api/outcomes/webhook-sources/[sourceId]/rotate'

export async function POST(_req: Request, { params }: { params: Promise<{ sourceId: string }> }) {
  const crossOrigin = rejectCrossOriginMutation(_req)
  if (crossOrigin) return crossOrigin
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 })
  const forbidden = ownerOnly(user)
  if (forbidden) return forbidden
  const owner = await activeAccountOrResponse()
  if ('response' in owner) return owner.response
  const { sourceId } = await params
  const notFound = Response.json({ error: 'Not found', code: 'NOT_FOUND' }, { status: 404 })
  if (!UUID.test(sourceId)) return notFound
  const db = getAdminClient()
  try {
    const { data, error } = await db
      .from('outcome_sources')
      .select('id')
      .eq('id', sourceId.toLowerCase())
      .eq('ad_account_id', owner.adAccountId)
      .eq('kind', 'webhook')
      .maybeSingle()
    if (error) throw error
    if (!data) return notFound
    const secret = await rotateWebhookSecret(db, sourceId.toLowerCase())
    if (!secret) return notFound
    return secretResponse({ source_id: sourceId.toLowerCase(), secret })
  } catch (error) {
    return apiErrorResponse(ROUTE, 'WEBHOOK_SECRET_ROTATE_FAILED', error, 500)
  }
}
