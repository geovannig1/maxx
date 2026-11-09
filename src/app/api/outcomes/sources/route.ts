import { getAdminClient } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'
import { ownerOnly } from '@/lib/auth/require-owner'
import { apiErrorResponse } from '@/lib/security/api-error'
import { activeAccountOrResponse } from '@/lib/outcomes/adapters/webhook/owner-route'
import { listOutcomeSources } from '@/lib/outcomes/source-admin'

export const runtime = 'nodejs'

// GET /api/outcomes/sources: owner only. The active account's outcome sources (kind, label, on/off,
// last success). Never a config or a secret.
export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 })
  const forbidden = ownerOnly(user)
  if (forbidden) return forbidden
  const owner = await activeAccountOrResponse()
  if ('response' in owner) return owner.response
  try {
    const sources = await listOutcomeSources(getAdminClient(), owner.adAccountId)
    return Response.json({ sources }, { headers: { 'Cache-Control': 'private, no-store' } })
  } catch (error) {
    return apiErrorResponse('GET /api/outcomes/sources', 'OUTCOME_SOURCES_READ_FAILED', error, 500)
  }
}
