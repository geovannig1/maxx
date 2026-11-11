import { getAdminClient } from '@/lib/supabase/admin'
import { apiErrorResponse } from '@/lib/security/api-error'
import {
  DEFAULT_WEBHOOK_ROTATION_GRACE_MINUTES, MAX_WEBHOOK_ROTATION_GRACE_MINUTES, rotateWebhookSecret,
} from '@/lib/outcomes/adapters/webhook/sources'
import { readBoundedBody } from '@/lib/security/bounded-body'
import { createClient } from '@/lib/supabase/server'
import { ownerOnly } from '@/lib/auth/require-owner'
import { activeAccountOrResponse, secretResponse } from '@/lib/outcomes/adapters/webhook/owner-route'
import { rejectCrossOriginMutation } from '@/lib/security/same-origin'

export const runtime = 'nodejs'

// POST /api/outcomes/webhook-sources/<id>/rotate — owner only. Replaces the source's signing secret and
// returns the new one ONCE. Optional body `{ "grace_minutes": 0..1440 }` (default 60): the old secret keeps
// verifying for that long so the sender can switch; 0 stops it at once (a suspected leak). The response
// says when the old secret stops (`previous_secret_valid_until`, null when it already has); the old
// secret itself is never returned.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ROUTE = 'POST /api/outcomes/webhook-sources/[sourceId]/rotate'
const MAX_BODY_BYTES = 1024

/** The requested grace window in minutes, the default for an empty body, or null when invalid. */
async function graceMinutes(req: Request): Promise<number | null> {
  const body = await readBoundedBody(req, MAX_BODY_BYTES)
  if (!body.ok) return null
  if (body.rawBody.trim() === '') return DEFAULT_WEBHOOK_ROTATION_GRACE_MINUTES
  let json: unknown
  try {
    json = JSON.parse(body.rawBody)
  } catch {
    return null
  }
  if (!json || typeof json !== 'object' || Array.isArray(json)) return null
  const keys = Object.keys(json)
  if (keys.some((key) => key !== 'grace_minutes')) return null
  if (!('grace_minutes' in json)) return DEFAULT_WEBHOOK_ROTATION_GRACE_MINUTES
  const value = (json as { grace_minutes: unknown }).grace_minutes
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_WEBHOOK_ROTATION_GRACE_MINUTES
    ? value
    : null
}

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
  const grace = await graceMinutes(_req)
  if (grace === null) {
    return Response.json({ error: `grace_minutes must be a whole number from 0 to ${MAX_WEBHOOK_ROTATION_GRACE_MINUTES}.`, code: 'INVALID_GRACE' }, { status: 400 })
  }
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
    const rotated = await rotateWebhookSecret(db, sourceId.toLowerCase(), grace)
    if (!rotated) return notFound
    return secretResponse({
      source_id: sourceId.toLowerCase(), secret: rotated.secret, previous_secret_valid_until: rotated.previousSecretValidUntil,
    })
  } catch (error) {
    return apiErrorResponse(ROUTE, 'WEBHOOK_SECRET_ROTATE_FAILED', error, 500)
  }
}
