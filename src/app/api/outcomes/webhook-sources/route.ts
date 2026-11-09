import { z } from 'zod'
import { getAdminClient } from '@/lib/supabase/admin'
import { apiErrorResponse } from '@/lib/security/api-error'
import { createWebhookSource } from '@/lib/outcomes/adapters/webhook/sources'
import { SIGNATURE_HEADER } from '@/lib/outcomes/adapters/webhook/signature'
import { createClient } from '@/lib/supabase/server'
import { ownerOnly } from '@/lib/auth/require-owner'
import { activeAccountOrResponse, secretResponse } from '@/lib/outcomes/adapters/webhook/owner-route'
import { rejectCrossOriginMutation } from '@/lib/security/same-origin'

export const runtime = 'nodejs'

// POST /api/outcomes/webhook-sources — owner only. Creates a signed-webhook outcome source for the
// active ad account and returns its signing secret ONCE; no endpoint returns it again (rotate to
// replace it). A new source is disabled unless `enabled: true` is sent (ADR-058: sources default off).
const bodySchema = z.strictObject({
  label: z.string().trim().min(1).max(128),
  enabled: z.boolean().optional(),
})

export async function POST(req: Request) {
  const crossOrigin = rejectCrossOriginMutation(req)
  if (crossOrigin) return crossOrigin
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 })
  const forbidden = ownerOnly(user)
  if (forbidden) return forbidden
  const owner = await activeAccountOrResponse()
  if ('response' in owner) return owner.response
  let body: z.infer<typeof bodySchema>
  try {
    body = bodySchema.parse(await req.json())
  } catch {
    return Response.json({ error: 'Invalid request body', code: 'INVALID_BODY' }, { status: 400 })
  }
  try {
    const created = await createWebhookSource(getAdminClient(), {
      adAccountId: owner.adAccountId, label: body.label, enabled: body.enabled ?? false,
    })
    return secretResponse({
      source_id: created.sourceId,
      secret: created.secret,
      enabled: body.enabled ?? false,
      signature_header: SIGNATURE_HEADER,
      path: `/api/outcomes/webhook/${created.sourceId}`,
    }, 201)
  } catch (error) {
    return apiErrorResponse('POST /api/outcomes/webhook-sources', 'WEBHOOK_SOURCE_CREATE_FAILED', error, 500)
  }
}
