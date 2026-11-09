import 'server-only'
import type { getAdminClient } from '@/lib/supabase/admin'
import { emitAlert } from '@/lib/monitoring/alerts'
import { describeAccountLock } from '@/lib/writes/account-lock'

// ADR-062: the execution claim and audit writes of a campaign-plan request. The claim is an action_log
// row 'executing' (one per account, by unique index). Everything the run acts on is re-read AFTER the
// claim (security review L1), and the change request is finalized only from the status the run started
// from (compare-and-set), so a second Apply that read a stale row can never clobber a finished run.

type Db = ReturnType<typeof getAdminClient>

export interface PlanRequestRow {
  id: string; status: string; action_type: string; expires_at: string; idempotency_key: string; params: Record<string, unknown>
  campaign_plan_version_id: string | null; rollback_of: string | null; meta_entity_id: string
}

const REQUEST_COLUMNS = 'id, status, action_type, expires_at, idempotency_key, params, campaign_plan_version_id, rollback_of, meta_entity_id'

export function dbError(step: string, error: { message?: string } | null) {
  console.error(`[CAMPAIGN PLAN EXEC] ${step} failed:`, error?.message ?? 'no detail')
  return { status: 'ERROR', error: 'DATABASE_ERROR' }
}

/** The request when it may run now (approved, or failed for a resume/retry, and unexpired). */
export async function readRequest(db: Db, id: string, accountId: string): Promise<PlanRequestRow | Record<string, unknown>> {
  const { data, error } = await db.from('change_requests').select(REQUEST_COLUMNS).eq('id', id).eq('ad_account_id', accountId).maybeSingle()
  if (error) return dbError('request read', error)
  if (!data) return { status: 'NOT_FOUND' }
  const cr = data as PlanRequestRow
  if (!cr.campaign_plan_version_id) return { status: 'NOT_A_PLAN_REQUEST' }
  if (cr.status === 'executed') return { status: 'ALREADY_EXECUTED', change_request_id: cr.id }
  if (cr.status !== 'approved' && cr.status !== 'failed') return { status: 'NOT_APPROVED', message: `Change request status is "${cr.status}"; it must be approved first.` }
  if (Date.parse(cr.expires_at) <= Date.now()) return { status: 'EXPIRED', message: 'This approval has expired. Nothing was sent to Meta. Roll back what exists, or submit the plan again.' }
  return cr
}

export const isRequest = (value: PlanRequestRow | Record<string, unknown>): value is PlanRequestRow => 'campaign_plan_version_id' in value

/** Whether a rollback of this creation is waiting for review or approved (security review L4): a resume
 *  then would create objects the owner already chose to archive. Null when it cannot be read. */
export async function rollbackInFlight(db: Db, changeRequestId: string, accountId: string): Promise<boolean | null> {
  const { data, error } = await db.from('change_requests').select('id').eq('rollback_of', changeRequestId).eq('ad_account_id', accountId)
    .in('status', ['pending', 'approved']).limit(1)
  if (error) { console.error('[CAMPAIGN PLAN EXEC] rollback read failed:', error.message); return null }
  return (data ?? []).length > 0
}

export const ROLLBACK_PENDING = { status: 'ROLLBACK_PENDING', message: 'A rollback of this creation is waiting for review or approved. Reject the rollback on Changes before resuming, or apply it. Nothing was created.' }

/** Take the account's execution lock for one attempt of this request. */
export async function claim(db: Db, cr: PlanRequestRow, accountId: string, actor: string): Promise<{ id: string } | Record<string, unknown>> {
  const { data: prior } = await db.from('action_log').select('id, status').eq('change_request_id', cr.id).eq('ad_account_id', accountId)
  const rows = (prior ?? []) as Array<{ id: string; status: string }>
  if (rows.some((r) => r.status === 'executing')) return { status: 'IN_PROGRESS', message: 'This creation is already running.' }
  const { data, error } = await db.from('action_log').insert({
    ad_account_id: accountId, action_type: cr.action_type, entity_level: 'account', meta_entity_id: cr.meta_entity_id,
    payload: cr.params, actor, idempotency_key: `${cr.idempotency_key}:attempt:${rows.length + 1}`, status: 'executing',
    verified: false, change_request_id: cr.id,
  }).select('id').single()
  if (error || !data) return { status: 'ACCOUNT_WRITE_IN_PROGRESS', message: 'Another change on this ad account is running. Try again when it finishes.', ...(await describeAccountLock(db, accountId)) }
  return data as { id: string }
}

/** Give the lock back without having acted: the attempt is recorded as not run, with its reason. */
export async function release(db: Db, accountId: string, logId: string, reason: string): Promise<void> {
  const { error } = await db.from('action_log').update({ status: 'not_run', result: { status: reason }, error: reason })
    .eq('id', logId).eq('ad_account_id', accountId).eq('status', 'executing')
  if (error) console.error('[CAMPAIGN PLAN EXEC] lock release failed:', error.message)
}

/** Re-read the request after the claim: it must still be in the status the run read before the claim. */
export async function recheckRequest(db: Db, before: PlanRequestRow, accountId: string): Promise<PlanRequestRow | Record<string, unknown>> {
  const now = await readRequest(db, before.id, accountId)
  if (!isRequest(now)) return now
  if (now.status !== before.status) return { status: 'STATE_CHANGED', message: `The request changed from ${before.status} to ${now.status} while this attempt waited. Nothing was sent to Meta; reload Changes.` }
  if (now.status === 'failed' && now.action_type === 'create_campaign_paused') {
    const inFlight = await rollbackInFlight(db, now.id, accountId)
    if (inFlight === null) return dbError('rollback read', null)
    if (inFlight) return ROLLBACK_PENDING
  }
  return now
}

export async function setVersionStatus(db: Db, versionId: string, accountId: string, status: string): Promise<boolean> {
  const { error } = await db.from('campaign_plan_versions').update({ status }).eq('id', versionId).eq('ad_account_id', accountId)
  if (error) console.error('[CAMPAIGN PLAN EXEC] version status failed:', error.message)
  return !error
}

/** Record the outcome on the claim and on the request; the request only from the status the run began with. */
export async function finalize(db: Db, accountId: string, logId: string, cr: PlanRequestRow, outcome: {
  logStatus: string; verified: boolean; crStatus: 'executed' | 'failed'; result: Record<string, unknown>; error?: string
}): Promise<Record<string, unknown> | null> {
  const now = new Date().toISOString()
  const { error: logError } = await db.from('action_log').update({ status: outcome.logStatus, verified: outcome.verified, result: outcome.result, after_state: outcome.result, error: outcome.error ?? null })
    .eq('id', logId).eq('ad_account_id', accountId)
  const { data: updated, error: crError } = await db.from('change_requests').update({
    status: outcome.crStatus, result: outcome.result, after_state: outcome.result, ...(outcome.crStatus === 'executed' ? { executed_at: now } : {}),
  }).eq('id', cr.id).eq('ad_account_id', accountId).eq('status', cr.status).select('id')
  if (logError || crError) return dbError('finalize', logError ?? crError)
  if (!Array.isArray(updated) || updated.length !== 1) {
    emitAlert({ area: 'write_attempt', severity: 'critical', dedupeKey: `plan-finalize:${cr.id}`, message: `Campaign plan request ${cr.id} left status ${cr.status} during its own run; its outcome (${outcome.crStatus}) was not written over it. Check the request and its objects.` })
    return { status: 'AUDIT_INCOMPLETE', change_request_id: cr.id, finalize_error: 'REQUEST_STATUS_CHANGED', message: 'The request changed while this attempt ran; its outcome was recorded on the action log only. Check it on Changes before retrying.' }
  }
  return null
}
