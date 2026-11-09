import { createClient } from '@/lib/supabase/server'
import { ownerOnly } from '@/lib/auth/require-owner'
import { getAvailableAvatars } from '@/lib/creative/video-generator'
import { apiErrorResponse } from '@/lib/security/api-error'

export const runtime = 'nodejs'

export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 })
  const forbidden = ownerOnly(user)
  if (forbidden) return forbidden

  try {
    const avatars = await getAvailableAvatars()
    return Response.json({ avatars })
  } catch (error) {
    return apiErrorResponse('GET /api/generate/avatars', 'AVATAR_LIST_FAILED', error, 500)
  }
}
