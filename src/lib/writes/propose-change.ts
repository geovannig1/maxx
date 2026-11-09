import 'server-only'
import { getAdminClient } from '@/lib/supabase/admin'
import { nyToday } from '@/lib/utils/date-utils'
import { formatMoney } from '@/lib/utils/format-currency'
import { BUDGET_PARAM, LEGACY_BUDGET_PARAM, budgetParamKey, budgetParamValue, withBudgetKey } from './budget-param'
import { validateWriteAuthority, type GovernedWriteRequest, type WriteAuthorityDecision } from './write-authority'
import { snapshotHasExpectedOwnership } from './meta-live-state'
import {
  BUDGET_HARD_CAP, BUDGET_TOLERANCE, activeAccountConfiguredDailyBudget, budgetMin, captureState, databaseError,
  fromMetaMinorUnits, proposedAccountBudgetTotal, resolveWriteTargetContext, type WriteActionType,
} from './write-preconditions'

// AI-facing proposal of a governed write (the agent path): a PENDING change request with a dry-run
// preview and the before-state. It never executes; executor.ts applies only an approved request.
// Split out of executor.ts with no behavior change; executor.ts re-exports the public names.

export interface ProposeArgs {
  adAccountDbId: string
  actionDecisionId: string
  actionType: WriteActionType
  entityLevel: 'ad' | 'adset' | 'campaign'
  metaEntityId: string
  params: Record<string, unknown>
  reason?: string
  confidence?: number
  requestedBy?: string
  evidence?: string
  dataSource?: string
}

function idempotencyKey(a: Pick<ProposeArgs, 'actionDecisionId' | 'actionType' | 'metaEntityId' | 'params'>): string {
  const day = nyToday()
  return `${a.actionDecisionId}:${a.actionType}:${a.metaEntityId}:${JSON.stringify(a.params)}:${day}`
}

export function riskFor(actionType: WriteActionType): { risk: string; rollback: string } {
  switch (actionType) {
    case 'activate_ad':
      return { risk: 'high', rollback: 'Pause the ad again (pause_ad) — it begins spending once active.' }
    case 'adjust_budget':
      return { risk: 'high', rollback: 'Restore the previous daily budget from before_state.' }
    case 'pause_ad':
      return { risk: 'medium', rollback: 'Re-activate the ad (activate_ad).' }
    case 'duplicate_adset':
      return { risk: 'low', rollback: 'Delete the duplicated (PAUSED) ad set in Meta Ads Manager.' }
  }
}

function buildPreview(a: ProposeArgs, before: Record<string, unknown> | null): string {
  switch (a.actionType) {
    case 'pause_ad':
      return `PAUSE ad ${a.metaEntityId} (currently ${before?.status ?? 'unknown'}).`
    case 'activate_ad':
      return `ACTIVATE ad ${a.metaEntityId} (currently ${before?.status ?? 'unknown'}) — this WILL start spending.`
    case 'adjust_budget': {
      const beforeAmount = before?.daily_budget != null ? formatMoney(fromMetaMinorUnits(Number(before.daily_budget))) : 'unknown'
      return `CHANGE ad set ${a.metaEntityId} daily budget from ${beforeAmount} to ${formatMoney(Number(budgetParamValue(a.params)))}.`
    }
    case 'duplicate_adset':
      return `DUPLICATE ad set ${a.metaEntityId} as "${a.params.new_name}" (the copy is created PAUSED).`
  }
}

/** AI-facing: create a PENDING change request. Never executes a live change. */
export async function proposeChange(a: ProposeArgs): Promise<object> {
  // Validate the mutation envelope before any database or Meta read. This keeps malformed requests
  // out of both the authority path and the before-state capture path.
  if (Object.hasOwn(a.params, BUDGET_PARAM) && Object.hasOwn(a.params, LEGACY_BUDGET_PARAM)) {
    return { status: 'BLOCKED', message: `Refused: give ${BUDGET_PARAM} only (${LEGACY_BUDGET_PARAM} is its deprecated name).` }
  }
  if (a.actionType === 'adjust_budget') {
    const newAmount = Number(budgetParamValue(a.params))
    if (!isFinite(newAmount) || newAmount < budgetMin()) {
      return { status: 'BLOCKED', message: `Refused: daily budget must be ≥ ${formatMoney(budgetMin())}/day (got ${String(budgetParamValue(a.params))}).` }
    }
    if (newAmount > BUDGET_HARD_CAP) {
      return { status: 'BLOCKED', message: `Refused: ${formatMoney(newAmount)}/day exceeds the hard cap of ${formatMoney(BUDGET_HARD_CAP)}/day.` }
    }
  }
  if (a.actionType === 'duplicate_adset' && budgetParamValue(a.params) != null) {
    const newAmount = Number(budgetParamValue(a.params))
    if (!isFinite(newAmount) || newAmount < budgetMin() || newAmount > BUDGET_HARD_CAP) {
      return { status: 'BLOCKED', message: `Refused: duplicate budget must be ${formatMoney(budgetMin())}–${formatMoney(BUDGET_HARD_CAP)}/day (got ${String(budgetParamValue(a.params))}).` }
    }
  }
  if (a.actionType === 'duplicate_adset' && !String(a.params.new_name ?? '').trim()) {
    return { status: 'BLOCKED', message: 'Refused: duplicate ad set name must be non-empty.' }
  }

  const db = getAdminClient()
  const key = idempotencyKey(a)
  const { data: existing, error: existingError } = await db
    .from('change_requests')
    .select('id, status, preview, action_decision_id')
    .eq('idempotency_key', key)
    .eq('ad_account_id', a.adAccountDbId)
    .maybeSingle()
  if (existingError) return databaseError('change request lookup', existingError)
  if (existing) {
    if (existing.action_decision_id !== a.actionDecisionId) {
      return { status: 'AUTHORITY_REQUIRED', message: 'An existing request has conflicting ActionDecision lineage.' }
    }
    return { status: 'ALREADY_REQUESTED', change_request_id: existing.id, request_status: existing.status, preview: existing.preview }
  }

  const { data: decision, error: decisionError } = await db
    .from('action_decisions')
    .select('id, ad_account_id, action_kind, target_level, target_id, authority_tier, policy_version, approval_state, proposed_mutation, causal_contribution_estimate_id')
    .eq('id', a.actionDecisionId)
    .eq('ad_account_id', a.adAccountDbId)
    .maybeSingle()
  if (decisionError) return databaseError('decision lookup', decisionError)
  // The budget is stored under the key its decision was authorised with: new_daily_budget, or the
  // deprecated new_daily_budget_usd for a decision recorded before the v1 release (the trigger accepts either).
  const params = a.actionType === 'adjust_budget' || a.actionType === 'duplicate_adset'
    ? withBudgetKey(a.params, budgetParamKey((decision as { proposed_mutation?: Record<string, unknown> | null } | null)?.proposed_mutation))
    : a.params
  const request: GovernedWriteRequest = {
    adAccountDbId: a.adAccountDbId,
    actionType: a.actionType,
    entityLevel: a.entityLevel,
    metaEntityId: a.metaEntityId,
    params,
  }
  const authority = validateWriteAuthority(
    decision as WriteAuthorityDecision | null,
    request,
    'not_requested',
  )
  if (!authority.allowed) return { status: 'AUTHORITY_REQUIRED', message: authority.reason }

  const targetContext = await resolveWriteTargetContext(
    db,
    a.adAccountDbId,
    a.actionType,
    a.entityLevel,
    a.metaEntityId,
    a.params,
  )
  if (!targetContext.ok) return targetContext

  let before: Record<string, unknown> | null
  try {
    before = await captureState(a.actionType, a.metaEntityId)
  } catch {
    before = null
  }
  if (!before) {
    return {
      status: 'SNAPSHOT_UNAVAILABLE',
      message: 'The current Meta state could not be captured. No approval request was created.',
    }
  }
  if (!snapshotHasExpectedOwnership(before, a.actionType, a.metaEntityId, targetContext.metaAccountId)) {
    return {
      status: 'OWNERSHIP_MISMATCH',
      message: 'Meta returned a target outside the selected ad account. No approval request was created.',
    }
  }
  let projectedAccountBudget: number | null = null
  if (a.actionType === 'adjust_budget') {
    const currentAccountTotal = await activeAccountConfiguredDailyBudget(targetContext.metaAccountId, targetContext.currency)
    const targetCurrentBudget = before.daily_budget == null ? Number.NaN : fromMetaMinorUnits(Number(before.daily_budget), targetContext.currency)
    projectedAccountBudget = currentAccountTotal === null ? null : proposedAccountBudgetTotal({
      currentAccountTotal,
      targetCurrentBudget,
      targetProposedBudget: Number(budgetParamValue(params)),
    })
    if (projectedAccountBudget === null) {
      return {
        status: 'PRECONDITION_UNAVAILABLE',
        message: 'The live active account-budget total could not be proven. No approval request was created.',
      }
    }
    if (projectedAccountBudget > BUDGET_HARD_CAP + BUDGET_TOLERANCE) {
      return {
        status: 'BLOCKED',
        message: `Refused: the proposed active account budget would be ${formatMoney(projectedAccountBudget)}/day, above the owner-approved ${formatMoney(BUDGET_HARD_CAP)}/day account ceiling.`,
      }
    }
  }
  const { risk, rollback } = riskFor(a.actionType)
  let effectiveRisk = risk
  let preview = buildPreview(a, before)
  if (a.actionType === 'adjust_budget') {
    const newAmount = Number(budgetParamValue(params))
    const beforeAmount = before?.daily_budget != null ? fromMetaMinorUnits(Number(before.daily_budget), targetContext.currency) : null
    if (beforeAmount !== null && newAmount > beforeAmount * 3) {
      effectiveRisk = 'high'
      preview += ` ⚠️ Large increase (>3× the current ${formatMoney(beforeAmount)}/day).`
    }
    preview += ` Projected active account total: ${formatMoney(projectedAccountBudget!)}/day (owner ceiling ${formatMoney(BUDGET_HARD_CAP)}/day).`
  }

  const { data, error } = await db.rpc('create_change_request_from_decision', {
    p_action_decision_id: a.actionDecisionId,
    p_request: {
      ad_account_id: a.adAccountDbId,
      action_type: a.actionType,
      entity_level: a.entityLevel,
      meta_entity_id: a.metaEntityId,
      params,
      before_state: before,
      preview,
      reason: a.reason ?? null,
      confidence: a.confidence ?? null,
      risk_level: effectiveRisk,
      rollback_plan: rollback,
      idempotency_key: key,
      requested_by: a.requestedBy ?? 'agent',
      evidence: a.evidence ?? null,
      data_source: a.dataSource ?? null,
    },
  })

  if (error) return databaseError('change request creation', error)
  const created = data as { id: string }

  return {
    status: 'PENDING_APPROVAL',
    change_request_id: created.id,
    preview,
    risk_level: effectiveRisk,
    rollback_plan: rollback,
    message:
      'Change request created. It will NOT execute until a human approves it in the dashboard AND write mode is enabled. No live change has been made.',
  }
}
