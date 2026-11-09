import { NextRequest } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { ownerOnly } from '@/lib/auth/require-owner'
import { enforceApiRateLimit } from '@/lib/security/api-rate-limit'
import { rejectCrossOriginMutation } from '@/lib/security/same-origin'
import { scoreRequestSchema } from '@/lib/creative/copy-brief'
import { scoreCopy, scoreCopyVariants } from '@/lib/creative/copy-studio'
import { parseCopyBody, privateJson } from '@/lib/creative/copy-route'

export const runtime = 'nodejs'

// POST /api/creative/copy/score: deterministic scoring, no AI and no database writes, so it works with
// AI off and in the demo. POST (not GET) because the copy is a body, never a URL that lands in logs.
const MAX_BODY_BYTES = 64_000

export async function POST(req: NextRequest) {
  const crossOrigin = rejectCrossOriginMutation(req)
  if (crossOrigin) return crossOrigin
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return privateJson({ error: 'Unauthorized' }, { status: 401 })
  const forbidden = ownerOnly(user)
  if (forbidden) return forbidden

  // Cheap but not free (up to 12 variants per call): 120 per 10 minutes is far above interactive use.
  const limited = await enforceApiRateLimit({ bucket: 'copy_score', actorKey: user.id, limit: 120, windowSeconds: 600 })
  if (limited) return limited

  const body = await parseCopyBody(req, MAX_BODY_BYTES, scoreRequestSchema)
  if (!body.ok) return body.response
  if ('text' in body.data) return privateJson({ score: scoreCopy(body.data.text, { goal: body.data.goal }) })
  return privateJson(scoreCopyVariants(body.data.variants, { goal: body.data.goal }))
}
