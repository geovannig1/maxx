import 'server-only'
import { randomUUID } from 'node:crypto'
import { getAdminClient } from '@/lib/supabase/admin'
import { resolveOnlyActiveAccount } from '@/lib/accounts/active-account'
import { ownerUserIdMismatch as ownerMismatch } from '@/lib/auth/owner-identity'
import { formatMoney } from '@/lib/utils/format-currency'
import { budgetParamValue } from './budget-param'
import { snapshotHasExpectedOwnership } from './meta-live-state'
export { listPendingChanges } from './owner-change-reads'
import {
  BUDGET_HARD_CAP, BUDGET_TOLERANCE, proposedAccountBudgetTotal, resolveWriteTargetContext, riskFor, validateBudgetAmount,
  type WriteActionType,
} from './executor'
import {
  budgetDirectionMismatch, budgetStepNeedsOverride, budgetStepPercent, maxBudgetChangePercent, normalizeOwnerParams, ownerChangePreview,
  ownerProposalEligibility, rollbackFor, type OwnerDecision,
} from './owner-change-policy'
import { snapshotBudgetToMajor, writeStateBackend, type WriteStateBackend } from './write-state-backend'
import { proposePlanRollback } from '@/lib/campaigns/plan-submission'
import { callOwnerRpc, OWNER_IDENTITY_MISMATCH } from './owner-rpc'

// ADR-059: owner-initiated proposals. Callers have already passed the owner gate (route) or hold the
// owner's user id (the later chat wave). Nothing here approves or executes; the result is a PENDING
// change request the owner reviews on the Changes page. Results are HTTP bodies: stable codes only,
// database text goes to the server log.

type Db = ReturnType<typeof getAdminClient>

export interface OwnerChangeResult {
  status: string
  http: number
  message: string
  change_request_id?: string
  preview?: string
  risk_level?: string
  rollback_plan?: string
  step_percent?: number
  max_step_percent?: number
  code?: string
}

export interface OwnerProposalInput {
  decisionId: string
  ownerUserId: string
  actor?: string
  params?: Record<string, unknown>
  /** The owner explicitly confirmed a budget step above MAX_BUDGET_CHANGE_PERCENT. */
  confirmOverride?: boolean
  /** The already-resolved active account; resolved here when omitted. */
  accountId?: string
}

const DECISION_COLUMNS = 'id, ad_account_id, action_kind, target_level, target_id, authority_tier, policy_version, approval_state, proposed_mutation, causal_contribution_estimate_id, evaluated_at, owner_copy, evidence_plane, evidence_basis'

const refuse = (status: string, http: number, message: string): OwnerChangeResult => ({ status, http, message })

function failure(step: string, error: { message?: string } | null, code = 'DATABASE_ERROR'): OwnerChangeResult {
  console.error(`[OWNER CHANGE] ${step} failed:`, error?.message ?? 'no detail')
  return { status: 'ERROR', http: 500, code, message: 'The change request could not be recorded. Nothing was changed.' }
}

/** RPC failures are classified by their stable exception name, never copied into the response. */
function rpcFailure(error: { message?: string }): OwnerChangeResult {
  const text = error.message ?? ''
  if (text === OWNER_IDENTITY_MISMATCH) return refuse('NOT_OWNER', 403, 'Only the owner can propose a change.')
  if (/already_has_a_different_change_request|not_available_for_a_new_request/.test(text)) {
    return refuse('ALREADY_DECIDED', 409, 'This decision already has a different change request.')
  }
  if (/not_execution_eligible|kind_mismatch|target_mismatch|does_not_match_action_decision|rollback_original_invalid|owner_change_budget_direction_mismatch|owner_change_step_override_required/.test(text)) {
    return refuse('AUTHORITY_REQUIRED', 409, 'The database refused this change for its decision lineage. Nothing was changed.')
  }
  return failure('owner change request RPC', error, 'CHANGE_REQUEST_CREATE_FAILED')
}

async function activeAccountId(db: Db, given?: string): Promise<string | OwnerChangeResult> {
  if (given) return given
  const active = await resolveOnlyActiveAccount(db)
  return active.ok ? active.account.id : refuse('ACCOUNT_UNAVAILABLE', 409, 'The active ad account could not be resolved uniquely.')
}

interface BudgetGate { ok: true; projected: number | null }
type GateResult = BudgetGate | OwnerChangeResult

async function budgetGates(
  backend: WriteStateBackend, actionType: WriteActionType, params: Record<string, unknown>, before: Record<string, unknown>,
  context: { metaAccountId: string; currency: string; kind?: string; stepCapApplies: boolean; confirmOverride: boolean },
): Promise<GateResult> {
  const amount = budgetParamValue(params)
  if (actionType === 'duplicate_adset') {
    if (amount == null) return { ok: true, projected: null }
    const outOfBounds = validateBudgetAmount(amount)
    return outOfBounds ? refuse('BLOCKED', 409, `Refused: ${outOfBounds}.`) : { ok: true, projected: null }
  }
  if (actionType !== 'adjust_budget') return { ok: true, projected: null }
  const outOfBounds = validateBudgetAmount(amount)
  if (outOfBounds) return refuse('BLOCKED', 409, `Refused: ${outOfBounds}.`)
  const current = snapshotBudgetToMajor(context.currency)(before.daily_budget)
  if (!Number.isFinite(current)) return refuse('PRECONDITION_UNAVAILABLE', 409, 'The ad set has no readable daily budget (a lifetime budget cannot be set here).')
  const proposed = Number(amount)
  if (context.kind) {
    const direction = budgetDirectionMismatch(context.kind, current, proposed)
    if (direction) return { status: 'INVALID_PARAMS', http: 400, message: direction }
  }
  const step = budgetStepPercent(current, proposed)
  const cap = maxBudgetChangePercent()
  if (context.stepCapApplies && budgetStepNeedsOverride(current, proposed, cap) && !context.confirmOverride) {
    return {
      status: 'STEP_LIMIT_EXCEEDED', http: 409, ...(step === null ? {} : { step_percent: step }), max_step_percent: cap,
      message: step === null
        ? `The current daily budget is ${formatMoney(current)}, so any new budget is a step above the ${cap}% per-change limit. Confirm the override to propose it anyway.`
        : `This changes the budget by ${step > 0 ? '+' : ''}${step}%, above the ${cap}% per-change limit. Confirm the override to propose it anyway.`,
    }
  }
  const total = await backend.accountDailyBudgetTotal(context.metaAccountId, context.currency)
  const projected = total === null ? null : proposedAccountBudgetTotal({ currentAccountTotal: total, targetCurrentBudget: current, targetProposedBudget: proposed })
  if (projected === null) return refuse('PRECONDITION_UNAVAILABLE', 409, 'The active account-budget total could not be proven. No request was created.')
  if (projected > BUDGET_HARD_CAP + BUDGET_TOLERANCE) {
    return refuse('BLOCKED', 409, `Refused: the active account budget would be ${formatMoney(projected)}/day, above the ${formatMoney(BUDGET_HARD_CAP)}/day ceiling.`)
  }
  return { ok: true, projected }
}

/** Owner proposal from a decision. Never executes; returns a PENDING change request or a refusal. */
export async function proposeOwnerChange(input: OwnerProposalInput): Promise<OwnerChangeResult> {
  if (ownerMismatch(input.ownerUserId)) return refuse('NOT_OWNER', 403, 'Only the owner can propose a change.')
  const db = getAdminClient()
  const accountId = await activeAccountId(db, input.accountId)
  if (typeof accountId !== 'string') return accountId

  const { data: decisionRow, error: decisionError } = await db.from('action_decisions').select(DECISION_COLUMNS)
    .eq('id', input.decisionId).eq('ad_account_id', accountId).maybeSingle()
  if (decisionError) return failure('decision read', decisionError)
  if (!decisionRow) return refuse('NOT_FOUND', 404, 'Decision not found for the active account.')
  const decision = decisionRow as unknown as OwnerDecision & { owner_copy: string | null; evidence_plane: string; evidence_basis: string }

  if (decision.approval_state === 'pending') {
    const { data: existing, error } = await db.from('change_requests').select('id, status, preview')
      .eq('action_decision_id', decision.id).eq('ad_account_id', accountId).is('rollback_of', null).maybeSingle()
    if (error) return failure('existing request read', error)
    const row = existing as { id: string; status: string; preview: string } | null
    if (row) return { status: 'ALREADY_REQUESTED', http: 200, change_request_id: row.id, preview: row.preview, message: 'This change is already waiting for your review.' }
  }

  const { data: newer, error: newerError } = await db.from('action_decisions').select('id')
    .eq('ad_account_id', accountId).eq('target_level', decision.target_level).eq('target_id', decision.target_id ?? '')
    .gt('evaluated_at', decision.evaluated_at).limit(1)
  if (newerError) return failure('newer decision read', newerError)
  const eligible = ownerProposalEligibility(decision, { now: Date.now(), newerDecisionExists: (newer ?? []).length > 0 })
  if (!eligible.ok) return refuse(eligible.code, 409, eligible.message)
  const normalized = normalizeOwnerParams(eligible.actionType, decision, input.params ?? {})
  if (!normalized.ok) return refuse(normalized.code, 400, normalized.message)
  const { actionType } = eligible
  const { params } = normalized
  const entityLevel = decision.target_level as 'ad' | 'adset'
  const target = decision.target_id as string

  const context = await resolveWriteTargetContext(db, accountId, actionType, entityLevel, target, params)
  if (!context.ok) return refuse(context.status, 409, context.message)
  const backend = writeStateBackend(db, accountId, context.currency)
  const before = await backend.readSnapshot(actionType, target)
  if (!before) return refuse('SNAPSHOT_UNAVAILABLE', 409, 'The current state of the target could not be read. No request was created.')
  if (!snapshotHasExpectedOwnership(before, actionType, target, context.metaAccountId)) {
    return refuse('OWNERSHIP_MISMATCH', 409, 'The target is reported outside the selected ad account. No request was created.')
  }
  const gate = await budgetGates(backend, actionType, params, before, {
    metaAccountId: context.metaAccountId, currency: context.currency, kind: decision.action_kind,
    stepCapApplies: true, confirmOverride: input.confirmOverride === true,
  })
  if (!('ok' in gate)) return gate

  const stepOverride = actionType === 'adjust_budget'
    && budgetStepNeedsOverride(snapshotBudgetToMajor(context.currency)(before.daily_budget), Number(budgetParamValue(params)), maxBudgetChangePercent())
  const { risk, rollback } = riskFor(actionType)
  let preview = ownerChangePreview(actionType, params, before, snapshotBudgetToMajor(context.currency))
  if (gate.projected !== null) preview += ` Projected active account total: ${formatMoney(gate.projected)}/day (ceiling ${formatMoney(BUDGET_HARD_CAP)}/day).`
  if (stepOverride) preview += ` You confirmed a step above the ${maxBudgetChangePercent()}% per-change limit.`

  const { data, error } = await callOwnerRpc(db, 'create_owner_change_request', {
    p_action_decision_id: decision.id,
    p_owner_user_id: input.ownerUserId,
    p_request: {
      ad_account_id: accountId, action_type: actionType, entity_level: entityLevel, meta_entity_id: target, params,
      before_state: before, preview, reason: 'Owner-initiated from a Maxx decision.',
      risk_level: stepOverride ? 'high' : risk, rollback_plan: rollback,
      idempotency_key: `owner:${decision.id}:${actionType}:${target}:${JSON.stringify(params)}`,
      requested_by: input.actor ?? 'owner',
      evidence: `${decision.owner_copy ?? 'No owner copy recorded.'} Evidence: ${decision.evidence_plane} / ${decision.evidence_basis}. Maxx authority: ${decision.authority_tier}; you initiated this change.`,
      data_source: backend.kind === 'demo' ? 'demo_sample_data' : 'meta_live_read',
      step_override: stepOverride,
      // The limit this proposal was checked against; the database repeats the check (security review L5).
      max_step_percent: maxBudgetChangePercent(),
    },
  })
  if (error) return rpcFailure(error)
  const created = (Array.isArray(data) ? data[0] : data) as { id?: string } | null
  if (!created?.id) return failure('owner change request RPC', null, 'CHANGE_REQUEST_CREATE_FAILED')
  return {
    status: 'PENDING_APPROVAL', http: 201, change_request_id: created.id, preview, risk_level: stepOverride ? 'high' : risk, rollback_plan: rollback,
    message: 'Change proposed. It will not run until you approve it, and only with write mode on.',
  }
}

/** The later chat entry point. Same rules and result as the Changes page; never approves. */
export function proposeChangeFromDecision(
  decisionId: string,
  ownerUserId: string,
  options: { actor?: string; params?: Record<string, unknown>; confirmOverride?: boolean } = {},
): Promise<OwnerChangeResult> {
  return proposeOwnerChange({ decisionId, ownerUserId, ...options })
}

/** The inverse of an executed change, as a new PENDING proposal (ADR-059 §7). */
export async function proposeRollback(input: { changeRequestId: string; ownerUserId: string; actor?: string; accountId?: string }): Promise<OwnerChangeResult> {
  if (ownerMismatch(input.ownerUserId)) return refuse('NOT_OWNER', 403, 'Only the owner can propose a rollback.')
  const db = getAdminClient()
  const accountId = await activeAccountId(db, input.accountId)
  if (typeof accountId !== 'string') return accountId
  const { data: originalRow, error } = await db.from('change_requests')
    .select('id, ad_account_id, action_decision_id, action_type, entity_level, meta_entity_id, params, before_state, status, rollback_of, campaign_plan_version_id')
    .eq('id', input.changeRequestId).eq('ad_account_id', accountId).maybeSingle()
  if (error) return failure('original request read', error)
  if (!originalRow) return refuse('NOT_FOUND', 404, 'Change request not found.')
  if ((originalRow as { campaign_plan_version_id?: string | null }).campaign_plan_version_id) {
    // ADR-062: a campaign plan's rollback archives the objects its creation recorded.
    const plan = await proposePlanRollback({ changeRequestId: input.changeRequestId, ownerUserId: input.ownerUserId, actor: input.actor, accountId })
    return { status: String(plan.body.status ?? plan.body.code ?? 'ERROR'), http: plan.http, message: String(plan.body.message ?? plan.body.error ?? ''), ...(plan.body.change_request_id ? { change_request_id: String(plan.body.change_request_id) } : {}), ...(plan.body.preview ? { preview: String(plan.body.preview) } : {}) }
  }
  const original = originalRow as {
    id: string; action_decision_id: string | null; action_type: string; entity_level: string; meta_entity_id: string
    params: Record<string, unknown> | null; before_state: Record<string, unknown> | null; status: string; rollback_of: string | null
  }
  if (original.status !== 'executed') return refuse('NOT_EXECUTED', 409, 'Only an executed change can be rolled back.')
  if (original.rollback_of || !original.action_decision_id) return refuse('NO_AUTOMATIC_ROLLBACK', 409, 'This change cannot be rolled back automatically.')

  const { data: account } = await db.from('ad_accounts').select('currency').eq('id', accountId).maybeSingle()
  const currency = (account as { currency?: string } | null)?.currency ?? ''
  const inverse = rollbackFor(original, snapshotBudgetToMajor(currency))
  if (!inverse) {
    return refuse('NO_AUTOMATIC_ROLLBACK', 409, original.action_type === 'duplicate_adset'
      ? 'A duplicated ad set has no automatic rollback: delete the paused copy in Meta Ads Manager.'
      : 'The recorded before-state has nothing to restore.')
  }
  const context = await resolveWriteTargetContext(db, accountId, inverse.actionType, original.entity_level as 'ad' | 'adset', original.meta_entity_id, inverse.params)
  if (!context.ok) return refuse(context.status, 409, context.message)
  const backend = writeStateBackend(db, accountId, context.currency)
  const before = await backend.readSnapshot(inverse.actionType, original.meta_entity_id)
  if (!before) return refuse('SNAPSHOT_UNAVAILABLE', 409, 'The current state of the target could not be read. No rollback was created.')
  if (!snapshotHasExpectedOwnership(before, inverse.actionType, original.meta_entity_id, context.metaAccountId)) {
    return refuse('OWNERSHIP_MISMATCH', 409, 'The target is reported outside the selected ad account. No rollback was created.')
  }
  // A rollback restores a value that was live before; the per-step cap does not apply, the ceiling does.
  const gate = await budgetGates(backend, inverse.actionType, inverse.params, before, {
    metaAccountId: context.metaAccountId, currency: context.currency, stepCapApplies: false, confirmOverride: false,
  })
  if (!('ok' in gate)) return gate
  const { risk, rollback } = riskFor(inverse.actionType)
  const preview = `Rollback of an applied change: ${ownerChangePreview(inverse.actionType, inverse.params, before, snapshotBudgetToMajor(context.currency))}`
  const { data, error: rpcError } = await callOwnerRpc(db, 'create_owner_change_request', {
    p_action_decision_id: original.action_decision_id,
    p_owner_user_id: input.ownerUserId,
    p_request: {
      ad_account_id: accountId, action_type: inverse.actionType, entity_level: original.entity_level,
      meta_entity_id: original.meta_entity_id, params: inverse.params, before_state: before, preview,
      reason: 'Owner rollback of an applied change.', risk_level: risk, rollback_plan: rollback,
      idempotency_key: `rollback:${original.id}:${randomUUID()}`, requested_by: input.actor ?? 'owner',
      evidence: 'Restores the before-state recorded when the original change was applied.',
      data_source: backend.kind === 'demo' ? 'demo_sample_data' : 'meta_live_read', rollback_of: original.id,
    },
  })
  if (rpcError) return rpcFailure(rpcError)
  const created = (Array.isArray(data) ? data[0] : data) as { id?: string } | null
  if (!created?.id) return failure('rollback RPC', null, 'CHANGE_REQUEST_CREATE_FAILED')
  return { status: 'PENDING_APPROVAL', http: 201, change_request_id: created.id, preview, risk_level: risk, rollback_plan: rollback, message: 'Rollback proposed. Approve it to apply.' }
}

