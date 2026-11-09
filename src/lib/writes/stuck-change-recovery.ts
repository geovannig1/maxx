import 'server-only'
import { getAdminClient } from '@/lib/supabase/admin'
import { emitAlert } from '@/lib/monitoring/alerts'
import { isStale, staleMinutes } from './account-lock'
import { writeStateBackend } from './write-state-backend'
import type { WriteActionType } from './executor'

// Security review M1: the owner-visible recovery of a run that crashed while holding the account's
// execution lock. Only a run older than the stale threshold, and only on the owner's click. Before the
// lock is released the outcome is recorded as UNKNOWN: an ADR-059 change records what Meta shows now;
// a campaign plan records the objects it created and its version goes to failed (a resume creates only
// what is missing, all PAUSED). The change request becomes failed; nothing is re-applied.

type Db = ReturnType<typeof getAdminClient>
export interface RecoveryResult { http: number; body: Record<string, unknown> }

interface RequestRow { id: string; status: string; action_type: string; meta_entity_id: string; campaign_plan_version_id: string | null }

const refuse = (http: number, status: string, message: string, extra: Record<string, unknown> = {}): RecoveryResult => ({ http, body: { status, message, ...extra } })

function dbFailure(step: string, error: { message?: string } | null): RecoveryResult {
  console.error(`[STUCK CHANGE] ${step} failed:`, error?.message ?? 'no detail')
  return { http: 500, body: { status: 'ERROR', error: 'DATABASE_ERROR', message: 'The recovery could not be recorded. The change is still locked.' } }
}

async function planEvidence(db: Db, cr: RequestRow, accountId: string): Promise<Record<string, unknown> | null> {
  const { data, error } = await db.from('campaign_plan_objects').select('local_key, object_kind, meta_id, state')
    .eq('change_request_id', cr.id).eq('ad_account_id', accountId)
  if (error) return null
  const { data: version, error: vError } = await db.from('campaign_plan_versions').select('status').eq('id', cr.campaign_plan_version_id as string).eq('ad_account_id', accountId).maybeSingle()
  if (vError) return null
  if ((version as { status?: string } | null)?.status === 'creating') {
    const { error: uError } = await db.from('campaign_plan_versions').update({ status: 'failed' }).eq('id', cr.campaign_plan_version_id as string).eq('ad_account_id', accountId)
    if (uError) return null
  }
  return {
    objects: (data ?? []) as unknown[],
    message: 'The creation stopped without finishing. The objects it recorded are listed, all created PAUSED; Resume creates only the missing ones, or Roll back.',
  }
}

async function liveEvidence(db: Db, cr: RequestRow, accountId: string): Promise<Record<string, unknown>> {
  const { data: account } = await db.from('ad_accounts').select('currency').eq('id', accountId).maybeSingle()
  const currency = (account as { currency?: string } | null)?.currency ?? ''
  let live: Record<string, unknown> | null = null
  try { live = await writeStateBackend(db, accountId, currency).readSnapshot(cr.action_type as WriteActionType, cr.meta_entity_id) } catch { live = null }
  return {
    live_state_read: live !== null, live_state: live,
    message: live
      ? 'The run stopped without finishing; Meta was read again and its current state is recorded here. Check whether the change took effect before proposing it again.'
      : 'The run stopped without finishing and Meta could not be read now. Check the target in Ads Manager before proposing the change again.',
  }
}

/** Mark a stale 'executing' run of this change as unknown, record the evidence, release the account. */
export async function recoverStuckChange(input: { id: string; actor: string; accountId: string }): Promise<RecoveryResult> {
  const db = getAdminClient()
  const { data: crRow, error: crError } = await db.from('change_requests').select('id, status, action_type, meta_entity_id, campaign_plan_version_id')
    .eq('id', input.id).eq('ad_account_id', input.accountId).maybeSingle()
  if (crError) return dbFailure('request read', crError)
  if (!crRow) return refuse(404, 'NOT_FOUND', 'Change request not found.')
  const cr = crRow as RequestRow
  const { data: runs, error: runError } = await db.from('action_log').select('id, created_at')
    .eq('change_request_id', cr.id).eq('ad_account_id', input.accountId).eq('status', 'executing')
  if (runError) return dbFailure('run read', runError)
  const run = ((runs ?? []) as Array<{ id: string; created_at: string }>)[0]
  if (!run) return refuse(409, 'NOT_STUCK', 'No run of this change is in progress; there is nothing to recover.')
  if (!isStale(run.created_at)) {
    return refuse(409, 'NOT_STALE', `This run started less than ${staleMinutes()} minutes ago and may still be working. Wait, then reload Changes.`, { running_since: run.created_at, stale_after_minutes: staleMinutes() })
  }

  const evidence = cr.campaign_plan_version_id ? await planEvidence(db, cr, input.accountId) : await liveEvidence(db, cr, input.accountId)
  if (!evidence) return dbFailure('plan evidence', null)
  const result = {
    status: 'RECOVERED_UNKNOWN', recovered_by: input.actor, recovered_at: new Date().toISOString(), running_since: run.created_at,
    stale_after_minutes: staleMinutes(), ...evidence,
  }
  const afterState = 'live_state' in evidence ? evidence.live_state ?? null : null
  // Record first (compare-and-set on the request's status), release the lock last.
  const { data: updated, error: updateError } = await db.from('change_requests').update({ status: 'failed', result, after_state: afterState })
    .eq('id', cr.id).eq('ad_account_id', input.accountId).eq('status', cr.status).select('id')
  if (updateError) return dbFailure('request update', updateError)
  if (!Array.isArray(updated) || updated.length !== 1) return refuse(409, 'STATE_CHANGED', 'The change moved on while recovering. Reload Changes.')
  const { error: logError } = await db.from('action_log').update({ status: 'unknown', result, after_state: afterState, error: 'RECOVERED_STALE_RUN' })
    .eq('id', run.id).eq('ad_account_id', input.accountId).eq('status', 'executing')
  if (logError) return dbFailure('lock release', logError)
  emitAlert({
    area: 'write_attempt', severity: 'warning', dedupeKey: `stuck-change:${cr.id}`,
    message: `Owner ${input.actor} recovered stuck change ${cr.id} (${cr.action_type}), running since ${run.created_at}. Its outcome is recorded as unknown.`,
  })
  return { http: 200, body: { status: 'RECOVERED', outcome: 'unknown', change_request_id: cr.id, ...evidence } }
}
