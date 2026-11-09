import 'server-only'
import { getAdminClient } from '@/lib/supabase/admin'
import { isDemoMode } from '@/config/demo'
import { budgetParamValue } from './budget-param'
import { validateWriteAuthority, type GovernedWriteRequest, type WriteAuthorityDecision } from './write-authority'
import { simulatedAfterState, validateOwnerWriteAuthority } from './owner-change-policy'
import { majorToMinor } from './write-state-backend'
import type { WriteActionType } from './executor'

// ADR-059 §8: the demo's executor. `npm run demo` has no Meta; approving a change there runs the same
// authority check and the same idempotent action_log claim as the real executor, then records a
// SIMULATED result and updates the sample rows. It refuses to run outside demo mode, and demo mode is
// itself refused in production and on Vercel.

export const DEMO_SIMULATED_LABEL = 'Demo: simulated — applied to the sample data only; nothing was sent to Meta.'

const DECISION_COLUMNS = 'id, ad_account_id, action_kind, target_level, target_id, authority_tier, policy_version, approval_state, proposed_mutation, causal_contribution_estimate_id'

function databaseError(step: string, error: { message?: string } | null) {
  console.error(`[DEMO WRITE] ${step} failed:`, error?.message ?? 'no detail')
  return { status: 'ERROR', error: 'DATABASE_ERROR' }
}

export async function simulateApprovedChange(changeRequestId: string, actor: string, accountId: string): Promise<object> {
  if (!isDemoMode()) return { status: 'ERROR', error: 'DEMO_ONLY', message: 'The simulated executor runs only in demo mode.' }
  const db = getAdminClient()
  const { data: row, error } = await db.from('change_requests').select('*').eq('id', changeRequestId).eq('ad_account_id', accountId).maybeSingle()
  if (error) return databaseError('change request read', error)
  const cr = row as Record<string, unknown> | null
  if (!cr) return { status: 'NOT_FOUND' }
  if (typeof cr.expires_at !== 'string' || Date.parse(cr.expires_at) <= Date.now()) {
    return { status: 'EXPIRED', message: 'This approval request has expired. Create and approve a fresh request.' }
  }
  if (cr.status === 'executed') return { status: 'ALREADY_EXECUTED', change_request_id: changeRequestId }
  if (cr.status !== 'approved') return { status: 'NOT_APPROVED', message: `Change request status is "${String(cr.status)}" — must be "approved".` }

  const actionType = cr.action_type as WriteActionType
  const params = (cr.params ?? {}) as Record<string, unknown>
  const request: GovernedWriteRequest = {
    adAccountDbId: accountId, actionType, entityLevel: cr.entity_level as GovernedWriteRequest['entityLevel'],
    metaEntityId: cr.meta_entity_id as string, params,
  }
  const { data: decision, error: decisionError } = await db.from('action_decisions').select(DECISION_COLUMNS)
    .eq('id', String(cr.action_decision_id ?? '')).eq('ad_account_id', accountId).maybeSingle()
  if (decisionError) return databaseError('decision read', decisionError)
  const authority = cr.initiated_by === 'owner'
    ? validateOwnerWriteAuthority(decision as WriteAuthorityDecision | null, request, { rollback: cr.rollback_of != null })
    : validateWriteAuthority(decision as WriteAuthorityDecision | null, request, 'approved')
  if (!authority.allowed) return { status: 'AUTHORITY_REQUIRED', message: authority.reason }

  // The same atomic claim as the real executor: one action_log row per idempotency key.
  const { data: claim, error: claimError } = await db.from('action_log').insert({
    ad_account_id: accountId, action_type: actionType, entity_level: cr.entity_level, meta_entity_id: cr.meta_entity_id,
    payload: params, before_state: cr.before_state, actor, idempotency_key: cr.idempotency_key, status: 'executing',
    verified: false, change_request_id: changeRequestId,
  }).select('id').single()
  if (claimError || !claim) {
    const { data: existing } = await db.from('action_log').select('id, status').eq('idempotency_key', String(cr.idempotency_key)).eq('ad_account_id', accountId).maybeSingle()
    const prior = existing as { id: string; status: string } | null
    if (prior?.status === 'simulated') return { status: 'ALREADY_EXECUTED', action_log_id: prior.id }
    if (prior) return { status: 'IN_PROGRESS', action_log_id: prior.id, message: 'Another execution already claimed this change.' }
    return databaseError('execution claim', claimError)
  }

  const { data: account } = await db.from('ad_accounts').select('currency').eq('id', accountId).maybeSingle()
  const currency = (account as { currency?: string } | null)?.currency ?? 'USD'
  const before = (cr.before_state ?? {}) as Record<string, unknown>
  const after = simulatedAfterState(actionType, before, params, majorToMinor(currency))
  const result = { simulated: true, label: DEMO_SIMULATED_LABEL }

  // Keep the sample data consistent with what the owner approved, so the next read shows it.
  if (actionType === 'pause_ad' || actionType === 'activate_ad') {
    await db.from('ads').update({ status: after.status, effective_status: after.status }).eq('ad_account_id', accountId).eq('ad_id', String(cr.meta_entity_id))
  } else if (actionType === 'adjust_budget') {
    await db.from('adsets').update({ daily_budget: Number(budgetParamValue(params)) }).eq('ad_account_id', accountId).eq('adset_id', String(cr.meta_entity_id))
  }

  const { error: logError } = await db.from('action_log').update({ status: 'simulated', verified: false, result, after_state: after })
    .eq('id', (claim as { id: string }).id).eq('ad_account_id', accountId)
  const { error: crError } = await db.from('change_requests').update({ status: 'executed', executed_at: new Date().toISOString(), result, after_state: after })
    .eq('id', changeRequestId).eq('ad_account_id', accountId)
  if (logError || crError) return databaseError('simulated finalization', logError ?? crError)
  return { status: 'DEMO_SIMULATED', change_request_id: changeRequestId, simulated: true, before_state: before, after_state: after, message: DEMO_SIMULATED_LABEL }
}
