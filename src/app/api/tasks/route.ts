import { createClient } from '@/lib/supabase/server'
import { ownerOnly } from '@/lib/auth/require-owner'
import { getAdminClient } from '@/lib/supabase/admin'
import { NextRequest } from 'next/server'
import { projectCurrentActionableTasks } from '@/lib/authority/diagnostic-surface'
import { activeAccountErrorCode, resolveOnlyActiveAccount } from '@/lib/accounts/active-account'
import { apiErrorResponse } from '@/lib/security/api-error'
import { rejectCrossOriginMutation } from '@/lib/security/same-origin'

export const runtime = 'nodejs'

// GET /api/tasks
export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const forbidden = ownerOnly(user)
  if (forbidden) return forbidden

  const sp = req.nextUrl.searchParams
  const status = sp.get('status')
  const priority = sp.get('priority')

  const validStatuses = new Set(['open', 'in_progress', 'done', 'dismissed'])
  const validPriorities = new Set(['low', 'medium', 'high', 'urgent'])

  // Support comma-separated status list (e.g. "open,in_progress")
  const statuses = status ? status.split(',').map((s) => s.trim()) : []
  const invalidStatuses = statuses.filter((s) => !validStatuses.has(s))
  if (invalidStatuses.length > 0) {
    return Response.json(
      { error: `Invalid status: ${invalidStatuses.join(', ')}. Must be one of: ${[...validStatuses].join(', ')}` },
      { status: 400 }
    )
  }

  if (priority && !validPriorities.has(priority)) {
    return Response.json(
      { error: `Invalid priority. Must be one of: ${[...validPriorities].join(', ')}` },
      { status: 400 }
    )
  }

  const adminClient = getAdminClient()
  const activeAccount = await resolveOnlyActiveAccount(adminClient)
  if (!activeAccount.ok) {
    const responseStatus = activeAccount.reason === 'not_found' ? 404 : activeAccount.reason === 'ambiguous' ? 409 : 503
    return Response.json({
      error: activeAccount.reason === 'ambiguous'
        ? 'More than one active ad account is configured'
        : activeAccount.reason === 'not_found'
          ? 'No active ad account found'
          : 'The active ad account could not be resolved',
      code: activeAccountErrorCode(activeAccount.reason),
    }, { status: responseStatus })
  }

  let query = adminClient
    .from('audit_tasks')
    .select('id, title, description, recommendation, priority, status, due_date, created_at, action_decision:action_decisions(authority_tier, policy_version, authority_reason, owner_copy)')
    .eq('ad_account_id', activeAccount.account.id)
    .order('created_at', { ascending: false })

  if (statuses.length === 1) {
    query = query.eq('status', statuses[0])
  } else if (statuses.length > 1) {
    query = query.in('status', statuses)
  }
  if (priority) query = query.eq('priority', priority)

  const { data, error } = await query

  if (error) {
    return apiErrorResponse('GET /api/tasks', 'TASK_READ_UNAVAILABLE', error, 503, {
      status: 'TASK_READ_UNAVAILABLE',
      data: null,
      total: null,
    })
  }

  const rows = (data ?? []) as Array<Record<string, unknown>>
  const actionable = projectCurrentActionableTasks(rows)
  const actionableIds = new Set(actionable.map((row) => String(row.id)))
  const historicalRecords = rows
    .filter((row) => !actionableIds.has(String(row.id)))
    .map((row) => ({ id: row.id, recorded_at: row.created_at ?? null }))

  return Response.json({
    data: actionable,
    total: actionable.length,
    historical_records: historicalRecords,
    historical_record_count: historicalRecords.length,
  })
}

// POST /api/tasks — direct task publication is disabled. A live task must be written by the governed
// recommendation pipeline with a current ActionDecision; arbitrary UI/LLM prose is never authority.
export async function POST(req: NextRequest) {
  const crossOrigin = rejectCrossOriginMutation(req)
  if (crossOrigin) return crossOrigin
  void req
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 })
  const forbidden = ownerOnly(user)
  if (forbidden) return forbidden
  return Response.json({
    status: 'ACTION_DECISION_REQUIRED',
    code: 'ACTION_DECISION_REQUIRED',
    blocker_codes: ['current_action_decision_required', 'governed_task_publication_not_implemented'],
    error: 'Tasks can only be published by the governed ActionDecision pipeline.',
  }, { status: 409 })
}
