import 'server-only'
import { getAdminClient } from '@/lib/supabase/admin'
import { isDemoMode } from '@/config/demo'
import { executeApprovedChange, httpStatusForExecuteResult } from './executor'
import { simulateApprovedChange } from './demo-executor'
import { executeCampaignPlanChange } from '@/lib/campaigns/plan-executor'
import { recoverStuckChange } from './stuck-change-recovery'

// Owner review of a change request: approve, reject, execute, or approve_and_apply (ADR-059 §6).
// Idempotent: a second Approve on an approved row and a second Reject on a rejected row are no-ops,
// and execution itself is claimed once per idempotency key. Approval never applies anything unless
// write mode is on (or, in demo mode, through the simulated executor). Bodies carry stable codes only.

export type ReviewAction = 'approve' | 'reject' | 'execute' | 'approve_and_apply' | 'recover'
export const REVIEW_ACTIONS: readonly ReviewAction[] = ['approve', 'reject', 'execute', 'approve_and_apply', 'recover']

export interface ReviewResult { http: number; body: Record<string, unknown> }

export const WRITES_OFF_MESSAGE = 'Approved — writes are off; turn on WRITE_MODE_ENABLED to apply. It stays listed so you can apply it later.'

const writeModeEnabled = () => process.env.WRITE_MODE_ENABLED === 'true'

function reviewError(error: { message?: string }): ReviewResult {
  const text = error.message ?? ''
  if (/change_request_expired/.test(text)) {
    return { http: 409, body: { status: 'EXPIRED', error: 'This request has expired. It can be rejected but not approved; propose it again from a current decision.' } }
  }
  console.error('[CHANGE REVIEW] review RPC failed:', text)
  return { http: 409, body: { status: 'REVIEW_REJECTED', code: 'CHANGE_REVIEW_REJECTED', error: 'The review could not be recorded for this request.' } }
}

/** HTTP code of a campaign-plan execution (ADR-062): a partial failure is a 502, never a 200. */
export function httpStatusForPlanResult(status: string): number {
  if (['CREATED_PAUSED', 'CREATED_UNVERIFIED', 'DEMO_SIMULATED', 'ARCHIVED', 'ALREADY_EXECUTED', 'WRITE_MODE_DISABLED'].includes(status)) return 200
  if (status === 'NOT_FOUND') return 404
  if (status === 'PARTIAL_FAILURE') return 502
  if (status === 'ERROR') return 500
  return 409
}

async function apply(id: string, actor: string, accountId: string, plan: boolean): Promise<ReviewResult> {
  if (plan) {
    // ADR-062: a campaign plan creates objects PAUSED through its own executor (simulated in the demo).
    const result = await executeCampaignPlanChange(id, actor, accountId, { simulate: isDemoMode() })
    return { http: httpStatusForPlanResult(String(result.status ?? 'ERROR')), body: result }
  }
  if (isDemoMode()) {
    const result = await simulateApprovedChange(id, actor, accountId) as { status?: string }
    const status = result.status ?? 'ERROR'
    return { http: status === 'DEMO_SIMULATED' || status === 'ALREADY_EXECUTED' ? 200 : httpStatusForExecuteResult(status), body: result as Record<string, unknown> }
  }
  const result = await executeApprovedChange(id, actor, accountId) as { status?: string }
  return { http: httpStatusForExecuteResult(result.status ?? 'ERROR'), body: result as Record<string, unknown> }
}

export async function reviewChangeRequest(input: {
  id: string
  action: ReviewAction
  actor: string
  accountId: string
  reason?: string | null
}): Promise<ReviewResult> {
  const db = getAdminClient()
  // Pin the request to the resolved account before any RPC or executor call, so a guessed id from
  // another account never reaches either.
  const { data, error } = await db.from('change_requests').select('id, status, campaign_plan_version_id')
    .eq('id', input.id).eq('ad_account_id', input.accountId).maybeSingle()
  if (error) {
    console.error('[CHANGE REVIEW] change request read failed:', error.message)
    return { http: 500, body: { error: 'The change request could not be read.', code: 'CHANGE_REQUEST_READ_FAILED' } }
  }
  if (!data) return { http: 404, body: { error: 'Change request not found' } }
  const status = (data as { status?: string }).status
  const plan = (data as { campaign_plan_version_id?: string | null }).campaign_plan_version_id != null

  if (input.action === 'reject') {
    if (status === 'rejected') return { http: 200, body: { status: 'rejected' } }
    const { error: rpcError } = await db.rpc('review_change_request_with_decision', {
      p_change_request_id: input.id, p_actor: input.actor, p_approve: false, p_reason: input.reason ?? null,
    })
    if (rpcError) return reviewError(rpcError)
    return { http: 200, body: { status: 'rejected' } }
  }

  if (input.action === 'execute') return apply(input.id, input.actor, input.accountId, plan)
  // Security review M1: release a run that crashed while holding the account lock (stale only).
  if (input.action === 'recover') return recoverStuckChange({ id: input.id, actor: input.actor, accountId: input.accountId })

  if (status === 'executed') return { http: 200, body: { status: 'ALREADY_EXECUTED', change_request_id: input.id } }
  if (status !== 'approved') {
    const { error: rpcError } = await db.rpc('review_change_request_with_decision', {
      p_change_request_id: input.id, p_actor: input.actor, p_approve: true, p_reason: input.reason ?? null,
    })
    if (rpcError) return reviewError(rpcError)
  }

  if (input.action === 'approve') {
    return { http: 200, body: { status: 'approved', message: 'Approved. Run execute (with write mode on) to apply it — approval alone makes no live change.' } }
  }
  if (!isDemoMode() && !writeModeEnabled()) {
    return { http: 200, body: { status: 'approved', write_mode: 'off', message: WRITES_OFF_MESSAGE } }
  }
  return apply(input.id, input.actor, input.accountId, plan)
}
