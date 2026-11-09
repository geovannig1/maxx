import { ownerOnly } from '@/lib/auth/require-owner'
import { createClient } from '@/lib/supabase/server'
import { getAdminClient } from '@/lib/supabase/admin'
import { activeAccountErrorCode, resolveOnlyActiveAccount } from '@/lib/accounts/active-account'
import { NextRequest } from 'next/server'
import { apiErrorResponse } from '@/lib/security/api-error'
import { rejectCrossOriginMutation } from '@/lib/security/same-origin'
import { proposeOwnerChange } from '@/lib/writes/owner-changes'

export const runtime = 'nodejs'

// GET /api/changes?status=pending — list write-action change requests.
export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 })
  const forbidden = ownerOnly(user)
  if (forbidden) return forbidden

  const db = getAdminClient()
  const activeAccount = await resolveOnlyActiveAccount(db)
  if (!activeAccount.ok) {
    const status = activeAccount.reason === 'not_found' ? 404 : activeAccount.reason === 'ambiguous' ? 409 : 503
    return Response.json({
      error: activeAccount.reason === 'ambiguous'
        ? 'More than one active ad account is configured.'
        : activeAccount.reason === 'not_found'
          ? 'No active ad account is configured.'
          : 'The active ad account could not be resolved.',
      code: activeAccountErrorCode(activeAccount.reason),
    }, { status })
  }

  const status = req.nextUrl.searchParams.get('status') ?? 'pending'
  const { data, error } = await db
    .from('change_requests')
    .select('*')
    .eq('ad_account_id', activeAccount.account.id)
    .eq('status', status)
    .order('created_at', { ascending: false })
    .limit(100)

  if (error) return apiErrorResponse('GET /api/changes', 'CHANGE_REQUESTS_READ_FAILED', error, 500)
  return Response.json({ change_requests: data ?? [] })
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// POST /api/changes  body: { action_decision_id, params?, confirm_override? }
// The owner proposes a change from a Maxx decision (ADR-059). Owner-only and same-origin. Creates a
// PENDING change request (idempotent per decision); never approves or applies anything.
export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 })
  const forbidden = ownerOnly(user)
  if (forbidden) return forbidden
  const crossOrigin = rejectCrossOriginMutation(req)
  if (crossOrigin) return crossOrigin

  const body = (await req.json().catch(() => null)) as {
    action_decision_id?: unknown; params?: unknown; confirm_override?: unknown
  } | null
  if (!body || typeof body.action_decision_id !== 'string' || !UUID.test(body.action_decision_id)) {
    return Response.json({ error: 'Give the action_decision_id of the decision to propose.' }, { status: 400 })
  }
  const params = body.params == null ? {} : body.params
  if (typeof params !== 'object' || Array.isArray(params)) {
    return Response.json({ error: 'params must be an object.' }, { status: 400 })
  }

  const result = await proposeOwnerChange({
    decisionId: body.action_decision_id,
    ownerUserId: user.id,
    actor: user.email ?? 'owner',
    params: params as Record<string, unknown>,
    confirmOverride: body.confirm_override === true,
  })
  const { http, ...payload } = result
  return Response.json(payload, { status: http })
}
