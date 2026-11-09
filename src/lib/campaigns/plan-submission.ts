import 'server-only'
import { randomUUID } from 'node:crypto'
import { getAdminClient } from '@/lib/supabase/admin'
import { isDemoMode } from '@/config/demo'
import { campaignPlanSpecSchema } from './plan-spec'
import { loadPlanContext } from './plan-context'
import { planPreview } from './plan-preview'
import { activeAccountId, evaluatePlan, hashSpec, minorFormatter, ownerMismatch, type PlanResult } from './plan-repository'
import { createdByRequest } from './plan-creation'
import { callOwnerRpc, OWNER_IDENTITY_MISMATCH } from '@/lib/writes/owner-rpc'

// ADR-062: "Submit for approval" turns a validated draft into an owner-initiated create_campaign_paused
// change request, shown on /changes beside every other change. The plan is re-validated against the
// account as it is NOW; a blocker refuses, and a large budget step needs the owner's explicit override,
// recorded on the request. Nothing here approves or creates anything.

const fail = (http: number, code: string, message: string, extra: Record<string, unknown> = {}): PlanResult => ({ http, body: { code, error: message, ...extra } })

export const PLAN_RISK = 'high'
export const PLAN_ROLLBACK_PLAN = 'Roll back proposes archiving every object this request created; you approve it like any other change. Paused objects spend nothing meanwhile.'

function rpcFailure(error: { message?: string }): PlanResult {
  const text = error.message ?? ''
  if (text === OWNER_IDENTITY_MISMATCH) return fail(403, 'NOT_OWNER', 'Only the owner can submit a plan or its rollback.')
  if (/campaign_plan_version_not_draft/.test(text)) return fail(409, 'PLAN_NOT_DRAFT', 'Only the current draft of a plan can be submitted.')
  if (/campaign_plan_rollback_original_invalid/.test(text)) return fail(409, 'NO_AUTOMATIC_ROLLBACK', 'Only an executed or failed creation can be rolled back.')
  if (/not_found|account_mismatch/.test(text)) return fail(404, 'PLAN_NOT_FOUND', 'Plan not found for the active account.')
  console.error('[CAMPAIGN PLAN] change request RPC failed:', text)
  return fail(500, 'CHANGE_REQUEST_CREATE_FAILED', 'The change request could not be recorded. Nothing was changed in Meta.')
}

/** Submit one draft version for the owner's approval. */
export async function submitPlanForApproval(input: { versionId: string; ownerUserId: string; actor?: string; confirmBudgetStep?: boolean; planId?: string }): Promise<PlanResult> {
  if (ownerMismatch(input.ownerUserId)) return fail(403, 'NOT_OWNER', 'Only the owner can submit a plan.')
  const db = getAdminClient()
  const accountId = await activeAccountId(db)
  if (!accountId) return fail(409, 'ACCOUNT_UNAVAILABLE', 'The active ad account could not be resolved uniquely.')
  let query = db.from('campaign_plan_versions').select('id, plan_id, status, spec, spec_hash').eq('id', input.versionId).eq('ad_account_id', accountId)
  if (input.planId) query = query.eq('plan_id', input.planId)
  const { data, error } = await query.maybeSingle()
  if (error) { console.error('[CAMPAIGN PLAN] version read failed:', error.message); return fail(500, 'CAMPAIGN_PLAN_READ_FAILED', 'The plan could not be read.') }
  if (!data) return fail(404, 'PLAN_NOT_FOUND', 'Plan not found for the active account.')
  const version = data as { id: string; plan_id: string; status: string; spec: unknown; spec_hash: string }
  if (version.status === 'pending_approval') {
    const { data: existing } = await db.from('change_requests').select('id, preview').eq('campaign_plan_version_id', version.id).eq('ad_account_id', accountId).is('rollback_of', null).maybeSingle()
    const row = existing as { id: string; preview: string } | null
    if (row) return { http: 200, body: { status: 'ALREADY_REQUESTED', change_request_id: row.id, preview: row.preview, message: 'This plan is already waiting for your approval on Changes.' } }
  }
  if (version.status !== 'draft') return fail(409, 'PLAN_NOT_DRAFT', 'Only the current draft of a plan can be submitted.')
  const spec = campaignPlanSpecSchema.safeParse(version.spec)
  if (!spec.success || hashSpec(spec.data) !== version.spec_hash) return fail(409, 'PLAN_INTEGRITY', 'The stored plan does not match its recorded hash. Nothing was submitted.')
  const loaded = await loadPlanContext(db, accountId)
  if (!loaded.ok) return fail(503, loaded.code, 'The account data the validator needs could not be read. Nothing was submitted.')
  const { validation } = evaluatePlan(spec.data, loaded.context)
  if (!validation.ok) return fail(422, 'PLAN_BLOCKED', 'The plan has blockers. Fix them and save a new version.', { validation: validation.issues })
  if (validation.stepOverrideRequired && input.confirmBudgetStep !== true) {
    return fail(409, 'STEP_LIMIT_EXCEEDED', `This plan adds ${validation.stepPercent}% to today's active account budget, above the ${loaded.context.validation.maxStepPercent}% per-change limit. Confirm the override to submit it anyway.`, {
      step_percent: validation.stepPercent, max_step_percent: loaded.context.validation.maxStepPercent,
    })
  }
  const money = minorFormatter(spec.data.currency)
  const active = loaded.context.validation.accountActiveDailyMinor
  const preview = planPreview(spec.data, money, {
    projectedAccountMinor: active === null ? null : active + validation.totalDailyMinor,
    ceilingMinor: loaded.context.validation.ceilingMinor, stepOverride: validation.stepOverrideRequired,
  })
  const warnings = validation.issues.filter((i) => i.severity === 'warning').map((i) => i.message)
  const { data: created, error: rpcError } = await callOwnerRpc(db, 'create_campaign_plan_change_request', {
    p_plan_version_id: version.id, p_owner_user_id: input.ownerUserId,
    p_request: {
      ad_account_id: accountId, action_type: 'create_campaign_paused', preview, reason: 'Owner-initiated campaign plan.',
      risk_level: PLAN_RISK, rollback_plan: PLAN_ROLLBACK_PLAN, idempotency_key: `plan:${version.id}`,
      requested_by: input.actor ?? 'owner', step_override: validation.stepOverrideRequired,
      evidence: warnings.length ? `Validated with ${warnings.length} warning(s): ${warnings.slice(0, 5).join(' ')}` : 'Validated with no blocker or warning.',
      data_source: isDemoMode() ? 'demo_sample_data' : 'meta_live_read',
    },
  })
  if (rpcError) return rpcFailure(rpcError)
  const row = (Array.isArray(created) ? created[0] : created) as { id?: string } | null
  if (!row?.id) return fail(500, 'CHANGE_REQUEST_CREATE_FAILED', 'The change request could not be recorded. Nothing was changed in Meta.')
  return {
    http: 201,
    body: {
      status: 'PENDING_APPROVAL', change_request_id: row.id, preview, risk_level: PLAN_RISK,
      message: 'Submitted. Approve it on Changes; it creates everything PAUSED, and only with write mode on.',
    },
  }
}

/** The inverse of a creation: a PENDING request to archive every object it created (ADR-062). */
export async function proposePlanRollback(input: { changeRequestId: string; ownerUserId: string; actor?: string; accountId: string }): Promise<PlanResult> {
  if (ownerMismatch(input.ownerUserId)) return fail(403, 'NOT_OWNER', 'Only the owner can propose a rollback.')
  const db = getAdminClient()
  const { data, error } = await db.from('change_requests').select('id, status, action_type, campaign_plan_version_id, rollback_of')
    .eq('id', input.changeRequestId).eq('ad_account_id', input.accountId).maybeSingle()
  if (error) return fail(500, 'CHANGE_READ_FAILED', 'The change request could not be read.')
  const original = data as { id: string; status: string; action_type: string; campaign_plan_version_id: string | null; rollback_of: string | null } | null
  if (!original) return fail(404, 'NOT_FOUND', 'Change request not found.')
  if (original.action_type !== 'create_campaign_paused' || !original.campaign_plan_version_id || original.rollback_of) {
    return fail(409, 'NO_AUTOMATIC_ROLLBACK', 'This change cannot be rolled back automatically.')
  }
  if (original.status !== 'executed' && original.status !== 'failed') return fail(409, 'NOT_EXECUTED', 'Only an executed or failed creation can be rolled back.')
  const { data: objects, error: objectsError } = await db.from('campaign_plan_objects').select('meta_id, object_kind, state, marker, local_key')
    .eq('change_request_id', original.id).eq('ad_account_id', input.accountId)
  if (objectsError) return fail(500, 'CHANGE_READ_FAILED', 'The created objects could not be read.')
  // Archive children first: ads, then ad sets, then the campaign (creatives are not archived; they are inert).
  // Only objects recorded under this request's own markers: never anything another request made.
  const order = { ad: 0, adset: 1, campaign: 2 } as Record<string, number>
  const recorded = (objects ?? []) as Array<{ meta_id: string | null; object_kind: string; state: string; marker: string; local_key: string }>
  const ids = createdByRequest(recorded, original.campaign_plan_version_id, original.id)
    .filter((o) => o.object_kind in order && o.state !== 'archived')
    .sort((a, b) => order[a.object_kind] - order[b.object_kind]).map((o) => o.meta_id as string)
  if (ids.length === 0) return fail(409, 'NOTHING_TO_ROLL_BACK', 'No created object is recorded for this request.')
  const preview = `Rollback of a campaign plan creation: archive ${ids.length} paused object(s) in Meta (${ids.join(', ')}). Archived objects stop for good and spend nothing.`
  const { data: created, error: rpcError } = await callOwnerRpc(db, 'create_campaign_plan_change_request', {
    p_plan_version_id: original.campaign_plan_version_id, p_owner_user_id: input.ownerUserId,
    p_request: {
      ad_account_id: input.accountId, action_type: 'archive_campaign_plan_objects', rollback_of: original.id, meta_ids: ids, preview,
      reason: 'Owner rollback of a campaign plan creation.', risk_level: 'medium', rollback_plan: 'Archived objects cannot be restored; create the plan again if needed.',
      idempotency_key: `plan-rollback:${original.id}:${randomUUID()}`, requested_by: input.actor ?? 'owner',
      evidence: 'Archives exactly the objects recorded when the plan was created.', data_source: isDemoMode() ? 'demo_sample_data' : 'meta_live_read',
    },
  })
  if (rpcError) return rpcFailure(rpcError)
  const row = (Array.isArray(created) ? created[0] : created) as { id?: string } | null
  if (!row?.id) return fail(500, 'CHANGE_REQUEST_CREATE_FAILED', 'The rollback could not be recorded.')
  return { http: 201, body: { status: 'PENDING_APPROVAL', change_request_id: row.id, preview, message: 'Rollback proposed. Approve it to archive the paused objects.' } }
}
