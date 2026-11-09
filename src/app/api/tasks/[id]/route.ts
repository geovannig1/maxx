import { createClient } from '@/lib/supabase/server'
import { ownerOnly } from '@/lib/auth/require-owner'
import { getAdminClient } from '@/lib/supabase/admin'
import { NextRequest } from 'next/server'
import { z } from 'zod'
import { activeAccountErrorCode, resolveOnlyActiveAccount } from '@/lib/accounts/active-account'
import { projectCurrentActionableTasks, projectTaskSurface } from '@/lib/authority/diagnostic-surface'
import { apiErrorResponse } from '@/lib/security/api-error'
import { rejectCrossOriginMutation } from '@/lib/security/same-origin'

export const runtime = 'nodejs'

const updateSchema = z.object({
  status: z.enum(['open', 'in_progress', 'done', 'dismissed']),
  completion_note: z.string().max(2000).optional(),
})

// PATCH /api/tasks/[id]
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const crossOrigin = rejectCrossOriginMutation(req)
  if (crossOrigin) return crossOrigin
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const forbidden = ownerOnly(user)
  if (forbidden) return forbidden

  const { id } = await params

  let body: z.infer<typeof updateSchema>
  try {
    const raw = await req.json()
    body = updateSchema.parse(raw)
  } catch {
    return Response.json({ error: 'Invalid request body' }, { status: 400 })
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

  // Verify the task belongs to the active account. A task status is a workflow disposition, not a
  // Meta mutation: owner-authenticated diagnostic tasks may be acknowledged/scheduled/dismissed.
  // Any live ad change remains blocked by the separate ActionDecision/write-mode boundary.
  const { data: existing, error: fetchError } = await adminClient
    .from('audit_tasks')
    .select('id, title, description, recommendation, priority, status, due_date, created_at, action_decision:action_decisions(authority_tier, policy_version, authority_reason, owner_copy)')
    .eq('id', id)
    .eq('ad_account_id', activeAccount.account.id)
    .maybeSingle()

  if (fetchError) {
    return apiErrorResponse('PATCH /api/tasks/[id]', 'TASK_READ_FAILED', fetchError, 500)
  }

  if (!existing) {
    return Response.json({ error: 'Task not found' }, { status: 404 })
  }

  const actionable = projectCurrentActionableTasks([existing as Record<string, unknown>]).length > 0
  if (!actionable && body.status === 'done' && !body.completion_note) {
    return Response.json({
      error: 'A diagnostic acknowledgement requires a completion note.',
      code: 'DIAGNOSTIC_DISPOSITION_NOTE_REQUIRED',
    }, { status: 422 })
  }

  const isCompleting = body.status === 'done' || body.status === 'dismissed'

  const { data, error } = await adminClient
    .from('audit_tasks')
    .update({
      status: body.status,
      completion_note: body.completion_note ?? null,
      completed_at: isCompleting ? new Date().toISOString() : null,
      completed_by: isCompleting
        ? (user.email ?? user.id)
        : null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)
    .eq('ad_account_id', activeAccount.account.id)
    .select('id, title, description, recommendation, priority, status, due_date, created_at, action_decision:action_decisions(authority_tier, policy_version, authority_reason, owner_copy)')
    .single()

  if (error) {
    return apiErrorResponse('PATCH /api/tasks/[id]', 'TASK_WRITE_FAILED', error, 500)
  }

  return Response.json({ data: projectTaskSurface(data as Record<string, unknown>) })
}
