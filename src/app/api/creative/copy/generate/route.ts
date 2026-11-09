import { NextRequest } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { ownerOnly } from '@/lib/auth/require-owner'
import { aiStatus } from '@/lib/ai'
import { enforceApiRateLimit } from '@/lib/security/api-rate-limit'
import { rejectCrossOriginMutation } from '@/lib/security/same-origin'
import { apiErrorResponse } from '@/lib/security/api-error'
import { copyBriefSchema } from '@/lib/creative/copy-brief'
import { AI_MISCONFIGURED_MESSAGE, AI_OFF_MESSAGE, generateCopy } from '@/lib/creative/copy-generator'
import { parseCopyBody, privateJson } from '@/lib/creative/copy-route'

export const runtime = 'nodejs'
export const maxDuration = 120

// POST /api/creative/copy/generate: owner-only, metered. With AI off it answers before any rate-limit,
// database or provider work. Nothing here writes to Meta or to the database.
const MAX_BODY_BYTES = 8_192
const STATUS: Record<string, number> = { ai_off: 409, ai_misconfigured: 409, refused: 422, failed: 502, invalid_input: 400 }

export async function POST(req: NextRequest) {
  const crossOrigin = rejectCrossOriginMutation(req)
  if (crossOrigin) return crossOrigin
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return privateJson({ error: 'Unauthorized' }, { status: 401 })
  const forbidden = ownerOnly(user)
  if (forbidden) return forbidden

  const ai = aiStatus()
  if (ai.state !== 'on') {
    const off = ai.state === 'off'
    return privateJson({ status: off ? 'ai_off' : 'ai_misconfigured', code: off ? 'AI_OFF' : 'AI_MISCONFIGURED', error: off ? AI_OFF_MESSAGE : AI_MISCONFIGURED_MESSAGE }, { status: 409 })
  }
  // Each request is one model call of up to ~8k output tokens: 10 per 10 minutes, like the chat.
  const limited = await enforceApiRateLimit({ bucket: 'copy_generate', actorKey: user.id, limit: 10, windowSeconds: 600 })
  if (limited) return limited

  const body = await parseCopyBody(req, MAX_BODY_BYTES, copyBriefSchema)
  if (!body.ok) return body.response
  try {
    const result = await generateCopy(body.data)
    return result.status === 'ok'
      ? privateJson(result)
      : privateJson({ ...result, error: result.message }, { status: STATUS[result.status] ?? 500 })
  } catch (error) {
    return apiErrorResponse('POST /api/creative/copy/generate', 'COPY_GENERATION_FAILED', error, 500)
  }
}
