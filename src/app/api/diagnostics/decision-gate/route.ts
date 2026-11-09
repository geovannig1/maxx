import { createClient } from '@/lib/supabase/server'
import { getAdminClient } from '@/lib/supabase/admin'
import { ownerOnly } from '@/lib/auth/require-owner'
import {
  activeAccountErrorCode,
  activeAccountErrorStatus,
  resolveOnlyActiveAccount,
} from '@/lib/accounts/active-account'
import { DECISION_GATE_NAMES, type DecisionGateRecord } from '@/lib/sync/orchestrator'
import { apiErrorResponse } from '@/lib/security/api-error'

export const runtime = 'nodejs'

/**
 * GET /api/diagnostics/decision-gate
 *
 * Answers "why is there no new advice?" from the run's own record rather than from inference.
 *
 * A NULL `decision_gate` on the latest run means the run ended before the gate was evaluated. That is
 * reported as `not_recorded`, never folded into "the gate passed" — the whole point of the column is
 * that absence and success stay distinguishable.
 */
export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 })
  const forbidden = ownerOnly(user)
  if (forbidden) return forbidden

  const activeAccount = await resolveOnlyActiveAccount()
  if (!activeAccount.ok) {
    return Response.json(
      { error: 'Active ad account scope is unavailable', code: activeAccountErrorCode(activeAccount.reason) },
      { status: activeAccountErrorStatus(activeAccount.reason) },
    )
  }

  const db = getAdminClient()
  const { data, error } = await db
    .from('api_sync_logs')
    .select('id, created_at, completed_at, status, decision_gate')
    .eq('ad_account_id', activeAccount.account.id)
    .not('decision_gate', 'is', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) {
    return apiErrorResponse('GET /api/diagnostics/decision-gate', 'DECISION_GATE_READ_FAILED', error, 502)
  }

  if (!data) {
    // No run has recorded a gate yet. Distinct from "the gate is open".
    return Response.json({ status: 'not_recorded', gateNames: DECISION_GATE_NAMES })
  }

  const gate = data.decision_gate as DecisionGateRecord
  return Response.json({
    status: 'recorded',
    syncLogId: data.id,
    syncStatus: data.status,
    recordedAt: data.completed_at ?? data.created_at,
    gateNames: DECISION_GATE_NAMES,
    gate,
  })
}
