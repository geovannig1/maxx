import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { ownerOnly } from '@/lib/auth/require-owner'
import { enforceApiRateLimit } from '@/lib/security/api-rate-limit'
import { rejectCrossOriginMutation } from '@/lib/security/same-origin'
import { apiErrorResponse } from '@/lib/security/api-error'
import { INTEGRATIONS, runChecks } from '@/lib/setup/checks'
import { liveAiProbe } from '@/lib/setup/ai-probe'

export const runtime = 'nodejs'
export const maxDuration = 60

// POST /api/setup/checks { integration, live? }: the setup checklist's "test connection" button.
// Runs the same checks module as `npm run setup` and `npm run doctor` for one integration, read-only.
// Owner only, same-origin, rate limited. The checks never put a secret in a result and redact any
// that a provider echoes back. `live: true` makes one minimal AI call, only for the AI integration.
const bodySchema = z.strictObject({ integration: z.enum(INTEGRATIONS), live: z.boolean().optional() })

export async function POST(req: Request) {
  const crossOrigin = rejectCrossOriginMutation(req)
  if (crossOrigin) return crossOrigin
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 })
  const forbidden = ownerOnly(user)
  if (forbidden) return forbidden
  let body: z.infer<typeof bodySchema>
  try {
    body = bodySchema.parse(await req.json())
  } catch {
    return Response.json({ error: 'Choose an integration to test.', code: 'INVALID_BODY' }, { status: 400 })
  }
  // Each test reaches an outside service; 20 per 10 minutes is ample for a person clicking.
  const limited = await enforceApiRateLimit({ bucket: 'setup_checks', actorKey: user.id, limit: 20, windowSeconds: 600 })
  if (limited) return limited
  const live = body.integration === 'ai' && body.live === true
  try {
    const summary = await runChecks(process.env, { fetch, ...(live ? { aiProbe: () => liveAiProbe() } : {}) }, { only: [body.integration], live })
    return Response.json(summary, { headers: { 'Cache-Control': 'private, no-store' } })
  } catch (error) {
    return apiErrorResponse('POST /api/setup/checks', 'SETUP_CHECKS_FAILED', error, 500)
  }
}
