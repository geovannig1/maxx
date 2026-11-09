import { createClient } from '@/lib/supabase/server'
import { ownerOnly } from '@/lib/auth/require-owner'
import { rejectCrossOriginMutation } from '@/lib/security/same-origin'

export const runtime = 'nodejs'

/**
 * Quarantined until the lookup is rebuilt with public-address validation,
 * redirect revalidation, response-size limits, and untrusted-content handling.
 */
export async function POST(req: Request) {
  const crossOrigin = rejectCrossOriginMutation(req)
  if (crossOrigin) return crossOrigin
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 })
  const forbidden = ownerOnly(user)
  if (forbidden) return forbidden

  return Response.json({
    status: 'UNAVAILABLE',
    code: 'SAFE_LOOKUP_REQUIRED',
    message: 'Automatic competitor lookup is disabled until its network and untrusted-content boundary is hardened. Enter verified competitor facts manually.',
  }, { status: 409 })
}
