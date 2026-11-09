import { ACTION_DECISION_POLICY_FLOOR } from '@/lib/authority/legacy-cutover'
import { isMoneyKind, type ActionKind, type AuthorityTier } from '@/lib/authority/action-authority'
import type { ActionTargetLevel } from '@/lib/authority/action-decision-store'
import { budgetParamKey, budgetParamValue } from './budget-param'

export type GovernedWriteAction = 'pause_ad' | 'activate_ad' | 'adjust_budget' | 'duplicate_adset'

export interface WriteAuthorityDecision {
  id: string
  ad_account_id: string
  action_kind: ActionKind
  target_level: ActionTargetLevel
  target_id: string | null
  authority_tier: AuthorityTier
  policy_version: number | null
  approval_state: 'not_requested' | 'pending' | 'approved' | 'rejected'
  proposed_mutation: Record<string, unknown> | null
  causal_contribution_estimate_id: string | null
}

export interface GovernedWriteRequest {
  adAccountDbId: string
  actionType: GovernedWriteAction
  entityLevel: 'ad' | 'adset' | 'campaign'
  metaEntityId: string
  params: Record<string, unknown>
}

export interface WriteAuthorityValidation {
  allowed: boolean
  reason: string
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)]),
    )
  }
  return value
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b))
}

/** The exact mutation envelope an ActionDecision must have authorised. */
export function expectedMutation(request: Pick<GovernedWriteRequest, 'actionType' | 'params'>): Record<string, unknown> {
  switch (request.actionType) {
    case 'pause_ad':
      return { action_type: 'pause_ad', status: 'PAUSED' }
    case 'activate_ad':
      return { action_type: 'activate_ad', status: 'ACTIVE' }
    case 'adjust_budget':
    case 'duplicate_adset':
      return { action_type: request.actionType, ...expectedParams(request) }
  }
}

function expectedParams(request: Pick<GovernedWriteRequest, 'actionType' | 'params'>): Record<string, unknown> {
  switch (request.actionType) {
    case 'pause_ad':
    case 'activate_ad':
      return {}
    // The budget is read and authorised under the one key the request carries (new_daily_budget, or its
    // deprecated name for decisions stored before the v1 release); a request carrying both never matches.
    case 'adjust_budget':
      return { [budgetParamKey(request.params)]: Number(budgetParamValue(request.params)) }
    case 'duplicate_adset': {
      const budget = budgetParamValue(request.params)
      return {
        new_name: String(request.params.new_name),
        [budgetParamKey(request.params)]: budget == null ? null : Number(budget),
      }
    }
  }
}

function actionKindMatches(actionType: GovernedWriteAction, kind: ActionKind): boolean {
  if (actionType === 'pause_ad') return kind === 'pause'
  if (actionType === 'activate_ad') return kind === 'activate'
  if (actionType === 'adjust_budget') return kind === 'budget_scale' || kind === 'budget_cut'
  return kind === 'structural'
}

/**
 * Final application-layer authority check for a proposal or execution.
 *
 * The database repeats these invariants. Keeping the pure check here gives callers a precise blocked
 * result before they attempt a transaction, while the trigger protects against a future caller that
 * forgets this function. `requiredApprovalState` is `not_requested` for a new proposal and `approved`
 * immediately before the Meta mutation.
 */
export function validateWriteAuthority(
  decision: WriteAuthorityDecision | null | undefined,
  request: GovernedWriteRequest,
  requiredApprovalState: WriteAuthorityDecision['approval_state'],
): WriteAuthorityValidation {
  if (!decision) return { allowed: false, reason: 'No ActionDecision is linked to this write.' }
  if (decision.ad_account_id !== request.adAccountDbId) {
    return { allowed: false, reason: 'The ActionDecision belongs to a different ad account.' }
  }
  if (decision.policy_version == null || decision.policy_version < ACTION_DECISION_POLICY_FLOOR) {
    return { allowed: false, reason: 'The ActionDecision predates the current authority policy.' }
  }
  if (isMoneyKind(decision.action_kind) && !decision.causal_contribution_estimate_id?.trim()) {
    return {
      allowed: false,
      reason: 'The ActionDecision has no exact decision-grade causal contribution estimate lineage.',
    }
  }
  if (decision.authority_tier !== 'execution_eligible') {
    return { allowed: false, reason: `Authority tier ${decision.authority_tier} is not execution-eligible.` }
  }
  if (decision.approval_state !== requiredApprovalState) {
    return {
      allowed: false,
      reason: `ActionDecision approval state is ${decision.approval_state}; expected ${requiredApprovalState}.`,
    }
  }
  if (decision.target_level !== request.entityLevel || decision.target_id !== request.metaEntityId) {
    return { allowed: false, reason: 'The ActionDecision target does not match the requested Meta entity.' }
  }
  if (!actionKindMatches(request.actionType, decision.action_kind)) {
    return { allowed: false, reason: 'The ActionDecision kind does not authorize this write action.' }
  }
  if (!sameJson(request.params, expectedParams(request))) {
    return { allowed: false, reason: 'The write request contains missing or ungoverned mutation parameters.' }
  }
  const mutation = expectedMutation(request)
  if (!sameJson(decision.proposed_mutation, mutation)) {
    return {
      allowed: false,
      reason: 'The requested mutation does not exactly match the immutable mutation approved by the ActionDecision.',
    }
  }
  return { allowed: true, reason: 'The write matches a current, execution-eligible ActionDecision.' }
}
