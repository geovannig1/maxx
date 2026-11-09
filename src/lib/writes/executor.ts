import 'server-only'
import * as Sentry from '@sentry/nextjs'
import { getAdminClient } from '@/lib/supabase/admin'
import { emitAlert } from '@/lib/monitoring/alerts'
import { formatMoney } from '@/lib/utils/format-currency'
import { budgetParamValue } from './budget-param'
import {
  validateWriteAuthority,
  type GovernedWriteRequest,
  type WriteAuthorityDecision,
} from './write-authority'
import {
  isSafeMetaEntityId,
  snapshotHasExpectedOwnership,
  writeSnapshotsMatch,
} from './meta-live-state'
import { safeWriteResponse } from './write-response'
import { auditIncomplete, finalizePreconditionFailure } from './execution-audit'
import { describeAccountLock } from './account-lock'
import { validateOwnerWriteAuthority } from './owner-change-policy'
import {
  BUDGET_HARD_CAP, BUDGET_TOLERANCE, activeAccountConfiguredDailyBudget, captureState, databaseError, fromMetaMinorUnits,
  metaWrites, proposedAccountBudgetTotal, resolveWriteTargetContext, toMetaMinorUnits, validateBudgetAmount,
  type WriteActionType,
} from './write-preconditions'

export {
  BUDGET_HARD_CAP, BUDGET_TOLERANCE, activeAccountConfiguredDailyBudget, budgetMin, captureState, proposedAccountBudgetTotal,
  resolveWriteTargetContext, validateBudgetAmount, type WriteActionType, type WriteTargetContext,
} from './write-preconditions'
export { proposeChange, riskFor, type ProposeArgs } from './propose-change'

// Safe write-mode executor.
// - AI calls proposeChange() → creates a PENDING change_request (dry-run preview + before-state). No live change.
// - A human approves it in the dashboard.
// - executeApprovedChange() applies it ONLY if (a) WRITE_MODE_ENABLED, (b) status === 'approved' and
//   unexpired, (c) target ownership and the exact approved Meta state still match, and (d) it has not
//   already executed (idempotency) — then logs before/after/actor and verifies the result.

const WRITE_MODE_ENABLED = process.env.WRITE_MODE_ENABLED === 'true'

/** Map an executeApprovedChange result status to the HTTP code the API route should return — execution
 *  failures must never travel as a 200 the UI reads as success. */
export function httpStatusForExecuteResult(status: string): number {
  switch (status) {
    case 'EXECUTED_VERIFIED':
    case 'EXECUTED_UNVERIFIED':
    case 'ALREADY_EXECUTED':
    case 'ALREADY_APPLIED_UNVERIFIED':
    case 'WRITE_MODE_DISABLED':
      return 200
    case 'NOT_FOUND':
      return 404
    case 'NOT_APPROVED':
    case 'IN_PROGRESS':
    case 'ACCOUNT_WRITE_IN_PROGRESS':
    case 'PREVIOUSLY_FAILED':
    case 'AUTHORITY_REQUIRED':
    case 'EXPIRED':
    case 'OWNERSHIP_UNVERIFIED':
    case 'OWNERSHIP_MISMATCH':
    case 'PRECONDITION_UNAVAILABLE':
    case 'STALE_APPROVAL':
    case 'CURRENCY_MISMATCH':
      return 409
    case 'FAILED':
      return 502
    default:
      return 500 // ERROR, AUDIT_INCOMPLETE, anything unexpected
  }
}

function isExpired(expiresAt: unknown): boolean {
  if (typeof expiresAt !== 'string') return true
  const timestamp = Date.parse(expiresAt)
  return !Number.isFinite(timestamp) || timestamp <= Date.now()
}

/** Exported for tests (the mutation stage machine is where partial-success truthfulness lives). */
export async function applyChange(
  actionType: WriteActionType,
  entityId: string,
  params: Record<string, unknown>
): Promise<{ ok: boolean; response: unknown; newEntityId?: string }> {
  if (!isSafeMetaEntityId(entityId)) {
    return { ok: false, response: { error: 'The Meta entity id is invalid.' } }
  }
  if (!metaWrites().isConfigured()) {
    return { ok: false, response: { error: 'Meta write credentials are unavailable.' } }
  }

  if (actionType === 'duplicate_adset') {
    // Re-check the budget override bounds HERE, before any Meta call — propose validates too, but an
    // out-of-bounds value must never reach Meta even if a request predates that validation.
    if (budgetParamValue(params) != null) {
      const outOfBounds = validateBudgetAmount(budgetParamValue(params))
      if (outOfBounds) return { ok: false, response: { error: `duplicate ${outOfBounds}` } }
    }
  } else if (actionType !== 'pause_ad' && actionType !== 'activate_ad') {
    // adjust_budget — re-validate the hard bounds before the Meta call (last-line defense: a legacy or
    // altered approved request could carry an out-of-bounds value that skipped propose-time validation).
    const outOfBounds = validateBudgetAmount(budgetParamValue(params))
    if (outOfBounds) return { ok: false, response: { error: outOfBounds } }
  }
  return metaWrites().apply(actionType, entityId, params)
}

/** Human-approved execution. Gated by WRITE_MODE_ENABLED + approval + idempotency; logs + verifies. */
export async function executeApprovedChange(
  changeRequestId: string,
  actor: string,
  expectedAdAccountId: string,
): Promise<object> {
  const db = getAdminClient()

  if (!WRITE_MODE_ENABLED) {
    // Tripwire: someone (or something) tried to execute a live change while write mode is off.
    // Surface it — an unexpected execution attempt is exactly the kind of thing we must not miss.
    emitAlert({
      area: 'write_attempt',
      // CRITICAL: an execution attempt while write mode is OFF is exactly the kind of unexpected event
      // we must not miss — a blocked attempt still signals something tried to take a live action.
      severity: 'critical',
      message: `Execution attempted while write mode is OFF (change_request ${changeRequestId}, actor ${actor}). Blocked — no live change made.`,
      dedupeKey: changeRequestId,
    })
    return {
      status: 'WRITE_MODE_DISABLED',
      message: 'Write mode is OFF (WRITE_MODE_ENABLED unset). The approved change was NOT executed. No live change made.',
    }
  }

  const { data: cr, error: crErr } = await db
    .from('change_requests')
    .select('*')
    .eq('id', changeRequestId)
    .eq('ad_account_id', expectedAdAccountId)
    .single()
  if (crErr || !cr || cr.ad_account_id !== expectedAdAccountId) {
    if (crErr) console.error('[WRITE] change request read failed:', crErr.message)
    return { status: 'NOT_FOUND' }
  }
  if (isExpired(cr.expires_at)) {
    return {
      status: 'EXPIRED',
      message: 'This approval request has expired. No Meta call was made; create and approve a fresh request.',
    }
  }
  if (cr.status !== 'approved') return { status: 'NOT_APPROVED', message: `Change request status is "${cr.status}" — must be "approved".` }

  const actionType = cr.action_type as WriteActionType
  const entityId = cr.meta_entity_id as string
  const params = (cr.params ?? {}) as Record<string, unknown>
  if (!cr.action_decision_id) {
    return {
      status: 'AUTHORITY_REQUIRED',
      message: 'This is a legacy change request with no ActionDecision lineage. It is historical and cannot execute.',
    }
  }
  const { data: decision, error: decisionError } = await db
    .from('action_decisions')
    .select('id, ad_account_id, action_kind, target_level, target_id, authority_tier, policy_version, approval_state, proposed_mutation, causal_contribution_estimate_id')
    .eq('id', cr.action_decision_id)
    .eq('ad_account_id', expectedAdAccountId)
    .maybeSingle()
  if (decisionError) return databaseError('decision lookup', decisionError)
  const governedRequest: GovernedWriteRequest = {
    adAccountDbId: expectedAdAccountId,
    actionType,
    entityLevel: cr.entity_level as GovernedWriteRequest['entityLevel'],
    metaEntityId: entityId,
    params,
  }
  // ADR-059: an owner-initiated request is checked against the owner bar; an agent request keeps the
  // execution-eligible bar. Every later gate (claim, live re-read, ceiling, verification) is shared.
  const authority = cr.initiated_by === 'owner'
    ? validateOwnerWriteAuthority(decision as WriteAuthorityDecision | null, governedRequest, { rollback: cr.rollback_of != null })
    : validateWriteAuthority(decision as WriteAuthorityDecision | null, governedRequest, 'approved')
  if (!authority.allowed) {
    return { status: 'AUTHORITY_REQUIRED', message: authority.reason }
  }

  const targetContext = await resolveWriteTargetContext(
    db,
    expectedAdAccountId,
    actionType,
    cr.entity_level as GovernedWriteRequest['entityLevel'],
    entityId,
    params,
  )
  if (!targetContext.ok) return targetContext
  const approvedState = cr.before_state && typeof cr.before_state === 'object' && !Array.isArray(cr.before_state)
    ? cr.before_state as Record<string, unknown>
    : null
  if (!snapshotHasExpectedOwnership(approvedState, actionType, entityId, targetContext.metaAccountId)) {
    return {
      status: 'STALE_APPROVAL',
      message: 'The request has no valid account-bound state snapshot. No Meta call was made; create and approve a fresh request.',
    }
  }

  // ── Atomic claim: insert the action_log row FIRST, keyed by the UNIQUE idempotency_key
  // (idx_action_log_idempotency). Two concurrent executors race on this insert and the constraint lets
  // exactly ONE win — the loser gets a duplicate-key error and aborts BEFORE any Meta call, so a change
  // can never be applied twice. This replaces the old read-then-act preflight (a plain SELECT that both
  // callers could pass before either wrote its row). A second partial unique index allows only one
  // 'executing' row per ad account, so different changes on one account also run one at a time and the
  // account-total budget check below cannot be raced. ──
  const { data: claim, error: claimErr } = await db
    .from('action_log')
    .insert({
      ad_account_id: expectedAdAccountId,
      action_type: actionType,
      entity_level: cr.entity_level,
      meta_entity_id: entityId,
      payload: params,
      before_state: cr.before_state,
      actor,
      idempotency_key: cr.idempotency_key,
      status: 'executing',
      verified: false,
      change_request_id: changeRequestId,
    })
    .select('id')
    .single()

  if (claimErr || !claim) {
    // Duplicate idempotency_key ⇒ a prior or concurrent execution already owns this change.
    const { data: existing } = await db
      .from('action_log')
      .select('id, status')
      .eq('idempotency_key', cr.idempotency_key)
      .eq('ad_account_id', expectedAdAccountId)
      .maybeSingle()
    const st = existing?.status as string | undefined
    if (st === 'executing') return { status: 'IN_PROGRESS', action_log_id: existing!.id, message: 'Another execution already claimed this change.' }
    if (st === 'failed') return { status: 'PREVIOUSLY_FAILED', action_log_id: existing!.id, message: 'A prior execution of this change failed; not retried automatically.' }
    if (st === 'verified' || st === 'applied_unverified') {
      // The action already ran — action_log is AUTHORITATIVE. Repair the change request if a
      // prior finalization left it 'approved'. The log's verification state decides the return, and its
      // repair MUST be confirmed: check the update's error AND affected rows before reporting success.
      const { data: repaired, error: repairErr } = await db
        .from('change_requests')
        .update({ status: 'executed', executed_at: new Date().toISOString() })
        .eq('id', changeRequestId)
        .eq('ad_account_id', expectedAdAccountId)
        .eq('status', 'approved')
        .select('id')
      if (repairErr) return auditIncomplete(changeRequestId, `repair update failed: ${repairErr.message}`)
      if (!repaired || repaired.length === 0) {
        // Zero rows updated is the NORMAL legit-retry case only when the CR is already 'executed';
        // any other state means the repair did not land — re-read to disambiguate.
        const { data: crNow } = await db
          .from('change_requests')
          .select('status')
          .eq('id', changeRequestId)
          .eq('ad_account_id', expectedAdAccountId)
          .maybeSingle()
        const crStatus = (crNow?.status as string | undefined) ?? 'missing'
        if (crStatus !== 'executed') return auditIncomplete(changeRequestId, `change request is '${crStatus}' after a no-op repair (expected 'executed')`)
      }
      // A CR re-read of 'executed' must NOT upgrade an unverified execution to clean ALREADY_EXECUTED.
      return st === 'applied_unverified'
        ? { status: 'ALREADY_APPLIED_UNVERIFIED', action_log_id: existing!.id, verified: false, message: 'This change was already applied, but its effect was never verified — confirm in Meta before relying on it.' }
        : { status: 'ALREADY_EXECUTED', action_log_id: existing!.id }
    }
    if (existing) return auditIncomplete(changeRequestId, `unexpected prior action_log status '${st ?? 'null'}' on a duplicate claim`)
    if ((claimErr as { code?: string } | null)?.code === '23505') {
      // No row holds this idempotency key, so the unique conflict is idx_action_log_one_executing_per_account:
      // another change on this ad account is mid-execution. Serialize: no Meta call, retry once it settles.
      return { status: 'ACCOUNT_WRITE_IN_PROGRESS', message: 'Another change on this ad account is executing. Nothing was sent to Meta; retry after it finishes.', ...(await describeAccountLock(db, expectedAdAccountId)) }
    }
    if (claimErr) console.error('[WRITE] execution claim failed:', claimErr.message)
    return { status: 'ERROR', error: 'CLAIM_FAILED', message: 'Failed to claim change for execution.' }
  }

  // The owner approved an exact state, not merely an entity id. Re-read it AFTER the atomic claim and
  // immediately before mutation. Account/parent drift, field drift, or an unavailable read retires the
  // approval without a POST; a new decision and explicit owner approval are required.
  let currentState: Record<string, unknown> | null = null
  try {
    currentState = await captureState(actionType, entityId)
  } catch {
    currentState = null
  }
  if (!currentState) {
    return finalizePreconditionFailure(db, {
      status: 'PRECONDITION_UNAVAILABLE',
      reason: 'The current Meta state could not be re-read after the execution claim.',
      claimId: claim.id,
      changeRequestId,
      adAccountId: expectedAdAccountId,
      currentState: null,
    })
  }
  if (!snapshotHasExpectedOwnership(currentState, actionType, entityId, targetContext.metaAccountId)) {
    return finalizePreconditionFailure(db, {
      status: 'OWNERSHIP_MISMATCH',
      reason: 'Meta no longer reports this target under the approved ad account and parent structure.',
      claimId: claim.id,
      changeRequestId,
      adAccountId: expectedAdAccountId,
      currentState,
    })
  }
  if (!writeSnapshotsMatch(approvedState, currentState)) {
    return finalizePreconditionFailure(db, {
      status: 'STALE_APPROVAL',
      reason: 'The live Meta configuration changed after the owner-approved snapshot.',
      claimId: claim.id,
      changeRequestId,
      adAccountId: expectedAdAccountId,
      currentState,
    })
  }

  if (actionType === 'adjust_budget') {
    const currentAccountTotal = await activeAccountConfiguredDailyBudget(targetContext.metaAccountId, targetContext.currency)
    const targetCurrentBudget = currentState.daily_budget == null ? Number.NaN : fromMetaMinorUnits(Number(currentState.daily_budget), targetContext.currency)
    const projectedAccountBudget = currentAccountTotal === null ? null : proposedAccountBudgetTotal({
      currentAccountTotal,
      targetCurrentBudget,
      targetProposedBudget: Number(budgetParamValue(params)),
    })
    if (projectedAccountBudget === null) {
      return finalizePreconditionFailure(db, {
        status: 'PRECONDITION_UNAVAILABLE',
        reason: 'The live active account-budget total could not be proven immediately before execution.',
        claimId: claim.id,
        changeRequestId,
        adAccountId: expectedAdAccountId,
        currentState,
      })
    }
    if (projectedAccountBudget > BUDGET_HARD_CAP + BUDGET_TOLERANCE) {
      return finalizePreconditionFailure(db, {
        status: 'STALE_APPROVAL',
        reason: `The proposed active account budget is now ${formatMoney(projectedAccountBudget)}/day, above the owner-approved ${formatMoney(BUDGET_HARD_CAP)}/day account ceiling.`,
        claimId: claim.id,
        changeRequestId,
        adAccountId: expectedAdAccountId,
        currentState,
      })
    }
  }

  // We own the claim — apply, verify, then finalize the claim row + change request.
  let applied: { ok: boolean; response: unknown; newEntityId?: string }
  try {
    applied = await applyChange(actionType, entityId, params)
  } catch (err) {
    console.error('[WRITE] Meta request failed:', err instanceof Error ? err.message : err)
    applied = { ok: false, response: { error: 'META_REQUEST_FAILED' } }
  }

  let afterState: Record<string, unknown> | null = null
  let verified = false
  if (applied.ok) {
    try {
      if (actionType === 'duplicate_adset') {
        // Real verification: fetch the COPY and confirm it exists PAUSED with the requested name/budget
        // actually applied — no more hardcoded `verified = true`.
        const newId = applied.newEntityId
        afterState = newId ? await metaWrites().readEntity(newId, 'id,name,daily_budget,status') : null
        const nameOk = params.new_name == null || afterState?.name === params.new_name
        const budgetOk = budgetParamValue(params) == null || Math.round(Number(afterState?.daily_budget ?? -1)) === toMetaMinorUnits(Number(budgetParamValue(params)), targetContext.currency)
        verified = !!afterState && afterState.status === 'PAUSED' && nameOk && budgetOk
      } else {
        afterState = await captureState(actionType, entityId)
        if (actionType === 'pause_ad') verified = afterState?.status === 'PAUSED'
        else if (actionType === 'activate_ad') verified = afterState?.status === 'ACTIVE'
        else if (actionType === 'adjust_budget')
          verified = Math.round(Number(afterState?.daily_budget ?? -1)) === toMetaMinorUnits(Number(budgetParamValue(params)), targetContext.currency)
      }
    } catch {
      verified = false
    }
  }

  // Only the trimmed, redacted answer is stored or returned, never Meta's raw body (security review L3).
  const response = safeWriteResponse(applied.response)

  // Finalize the claim row we already own (update, not insert). BOTH finalization writes are checked:
  // a Meta change that succeeded while its audit rows stayed 'executing'/'approved' would silently
  // block retries AND lose the audit trail — that must surface loudly, never pass as success.
  const { error: logFinalizeErr } = await db.from('action_log').update({
    result: response,
    after_state: afterState,
    status: applied.ok ? (verified ? 'verified' : 'applied_unverified') : 'failed',
    error: applied.ok ? null : JSON.stringify(response),
    verified,
  }).eq('id', claim.id).eq('ad_account_id', expectedAdAccountId)

  // Compare-and-set (security review L1): only the approved row this run claimed becomes its outcome.
  const { data: crFinalized, error: crFinalizeErr } = await db
    .from('change_requests')
    .update({ status: applied.ok ? 'executed' : 'failed', executed_at: new Date().toISOString(), result: response, after_state: afterState })
    .eq('id', changeRequestId)
    .eq('ad_account_id', expectedAdAccountId)
    .eq('status', 'approved')
    .select('id')
  const crNotFinalized = !crFinalizeErr && (!Array.isArray(crFinalized) || crFinalized.length !== 1)

  if (logFinalizeErr || crFinalizeErr || crNotFinalized) {
    const detail = [logFinalizeErr && `action_log ${claim.id}: ${logFinalizeErr.message}`, crFinalizeErr && `change_request ${changeRequestId}: ${crFinalizeErr.message}`, crNotFinalized && `change_request ${changeRequestId}: no longer approved, outcome not written over it`].filter(Boolean).join('; ')
    emitAlert({
      area: 'write_attempt',
      severity: 'critical',
      message: `WRITE AUDIT INCOMPLETE — Meta ${actionType} on ${entityId} ${applied.ok ? 'was applied' : 'failed'} but audit finalization failed (${detail}). The action_log row may be stuck 'executing' (blocks same-key retry) and the change request may still read 'approved'. Fix the rows manually before retrying.`,
      dedupeKey: `audit-incomplete:${changeRequestId}`,
    })
    Sentry.captureMessage(`[WRITE] AUDIT INCOMPLETE ${actionType} ${entityId}: ${detail}`, 'error')
    return {
      status: 'AUDIT_INCOMPLETE',
      change_request_id: changeRequestId,
      applied: applied.ok,
      verified,
      finalize_error: 'AUDIT_FINALIZE_FAILED',
      response,
      message: 'The Meta call outcome is above, but the audit records could not be finalized — do NOT retry until the rows are repaired.',
    }
  }

  // Every live write is surfaced to Sentry for audit + alerting. Only ever fires when write mode
  // is enabled (the function returns early otherwise), so it doubles as a write-mode tripwire.
  Sentry.captureMessage(
    `[WRITE] ${actionType} ${entityId} → ${applied.ok ? (verified ? 'verified' : 'applied (unverified)') : 'FAILED'} by ${actor}`,
    applied.ok ? 'info' : 'error'
  )

  return {
    status: applied.ok ? (verified ? 'EXECUTED_VERIFIED' : 'EXECUTED_UNVERIFIED') : 'FAILED',
    change_request_id: changeRequestId,
    verified,
    response,
  }
}
