import { ACTION_DECISION_POLICY_FLOOR } from '@/lib/authority/legacy-cutover'
import type { ActionKind } from '@/lib/authority/action-authority'
import { formatMoney, roundMoney } from '@/lib/utils/format-currency'
import { BUDGET_PARAM, LEGACY_BUDGET_PARAM, budgetParamKey, budgetParamValue } from './budget-param'
import {
  expectedMutation,
  type GovernedWriteAction,
  type GovernedWriteRequest,
  type WriteAuthorityDecision,
  type WriteAuthorityValidation,
} from './write-authority'

// ADR-059: owner-initiated changes. PURE rules shared by the proposal service, the executor and the
// demo simulator. The engine's own tiers are untouched; this module states what changes when the
// OWNER, not the engine, initiates a change.

/** A decision older than this is stale for a new owner proposal (the engine re-evaluates daily). */
export const OWNER_DECISION_MAX_AGE_DAYS = 7
export const DEFAULT_MAX_BUDGET_CHANGE_PERCENT = 50
const DAY_MS = 86_400_000
const MAX_NAME_LENGTH = 200

export interface OwnerDecision extends WriteAuthorityDecision {
  evaluated_at: string
}

export type OwnerRefusalCode =
  | 'DIAGNOSTIC_ONLY' | 'STALE_DECISION' | 'UNSUPPORTED_MUTATION' | 'ALREADY_DECIDED' | 'INVALID_PARAMS'

export type Refusal = { ok: false; code: OwnerRefusalCode; message: string }

/** The one executor mutation a decision kind may become, on its matching level; null when none. */
export function actionTypeForDecision(kind: ActionKind | string, level: string): GovernedWriteAction | null {
  if (level === 'ad' && kind === 'pause') return 'pause_ad'
  if (level === 'ad' && kind === 'activate') return 'activate_ad'
  if (level === 'adset' && (kind === 'budget_scale' || kind === 'budget_cut')) return 'adjust_budget'
  if (level === 'adset' && kind === 'structural') return 'duplicate_adset'
  return null
}

/** Whether the owner may propose a change on this decision. Hard guards on the target come later. */
export function ownerProposalEligibility(
  decision: OwnerDecision,
  context: { now: number; newerDecisionExists: boolean },
): { ok: true; actionType: GovernedWriteAction } | Refusal {
  if (decision.authority_tier === 'diagnostic_only') {
    return { ok: false, code: 'DIAGNOSTIC_ONLY', message: 'Maxx found no supported direction for this decision (diagnostic only), so it cannot become a change. You can still change Meta yourself and record it.' }
  }
  if (decision.policy_version == null || decision.policy_version < ACTION_DECISION_POLICY_FLOOR) {
    return { ok: false, code: 'STALE_DECISION', message: 'This decision predates the current authority policy. Wait for the next evaluation.' }
  }
  const evaluated = Date.parse(decision.evaluated_at)
  if (!Number.isFinite(evaluated) || context.now - evaluated > OWNER_DECISION_MAX_AGE_DAYS * DAY_MS) {
    return { ok: false, code: 'STALE_DECISION', message: `This decision is more than ${OWNER_DECISION_MAX_AGE_DAYS} days old. Wait for a fresh evaluation.` }
  }
  if (context.newerDecisionExists) {
    return { ok: false, code: 'STALE_DECISION', message: 'A newer decision exists for this target. Propose from the newest one.' }
  }
  const actionType = actionTypeForDecision(decision.action_kind, decision.target_level)
  if (!actionType) {
    return { ok: false, code: 'UNSUPPORTED_MUTATION', message: 'Maxx can apply only: pause or activate an ad, set an ad set daily budget, or duplicate an ad set as paused.' }
  }
  if (decision.approval_state === 'approved' || decision.approval_state === 'rejected') {
    return { ok: false, code: 'ALREADY_DECIDED', message: `This decision was already ${decision.approval_state}.` }
  }
  return { ok: true, actionType }
}

function positiveAmount(value: unknown): number | null {
  const amount = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : Number.NaN
  return Number.isFinite(amount) && amount > 0 ? roundMoney(amount) : null
}

/** The exact governed params for an owner request, from the owner's input. */
export function normalizeOwnerParams(
  actionType: GovernedWriteAction,
  decision: Pick<WriteAuthorityDecision, 'proposed_mutation'>,
  input: Record<string, unknown>,
): { ok: true; params: Record<string, unknown> } | Refusal {
  const key = budgetParamKey(decision.proposed_mutation)
  let params: Record<string, unknown>
  if (actionType === 'pause_ad' || actionType === 'activate_ad') {
    params = {}
  } else if (actionType === 'adjust_budget') {
    const amount = positiveAmount(input[BUDGET_PARAM] ?? input[LEGACY_BUDGET_PARAM])
    if (amount === null) return { ok: false, code: 'INVALID_PARAMS', message: 'Give the new daily budget as a positive amount.' }
    params = { [key]: amount }
  } else {
    const name = typeof input.new_name === 'string' ? input.new_name.trim() : ''
    if (!name || name.length > MAX_NAME_LENGTH) {
      return { ok: false, code: 'INVALID_PARAMS', message: `Give the copy a name of 1 to ${MAX_NAME_LENGTH} characters.` }
    }
    const raw = input[BUDGET_PARAM] ?? input[LEGACY_BUDGET_PARAM]
    const amount = raw == null || raw === '' ? null : positiveAmount(raw)
    if (raw != null && raw !== '' && amount === null) {
      return { ok: false, code: 'INVALID_PARAMS', message: 'The copy\'s daily budget must be a positive amount, or left empty.' }
    }
    params = { new_name: name, [key]: amount }
  }
  if (decision.proposed_mutation && JSON.stringify(canonical(decision.proposed_mutation)) !== JSON.stringify(canonical(expectedMutation({ actionType, params })))) {
    return { ok: false, code: 'INVALID_PARAMS', message: 'Maxx proposed an exact change for this decision; the request must match it.' }
  }
  return { ok: true, params }
}

/** Signed step in percent of the current budget; null when the current budget is not positive. */
export function budgetStepPercent(current: number, proposed: number): number | null {
  if (!Number.isFinite(current) || current <= 0 || !Number.isFinite(proposed)) return null
  return Math.round(((proposed - current) / current) * 10_000) / 100
}

/** Whether a budget step needs the owner's explicit override: above the cap, or any step away from a
 *  zero (or unreadable non-positive) budget, whose percentage is unbounded (security review L5). */
export function budgetStepNeedsOverride(current: number, proposed: number, cap: number): boolean {
  if (Number.isFinite(current) && current <= 0) return Number.isFinite(proposed) && proposed !== current
  const step = budgetStepPercent(current, proposed)
  return step !== null && Math.abs(step) > cap
}

/** The per-step cap (MAX_BUDGET_CHANGE_PERCENT); an unset or invalid value is the default. */
export function maxBudgetChangePercent(env: Record<string, string | undefined> = process.env): number {
  const raw = env.MAX_BUDGET_CHANGE_PERCENT?.trim() ?? ''
  return /^[1-9]\d{0,5}$/.test(raw) ? Number(raw) : DEFAULT_MAX_BUDGET_CHANGE_PERCENT
}

/** A budget change must move in the direction the decision states. */
export function budgetDirectionMismatch(kind: string, current: number, proposed: number): string | null {
  if (kind === 'budget_scale' && !(proposed > current)) return 'This decision is to raise the budget; the new amount must be above the current one.'
  if (kind === 'budget_cut' && !(proposed < current)) return 'This decision is to lower the budget; the new amount must be below the current one.'
  return null
}

const quoted = (value: unknown, fallback: string) => (typeof value === 'string' && value.trim() ? `"${value}"` : fallback)

/** Owner-facing preview. `toMajor` converts Meta's minor-unit budget into the account currency. */
export function ownerChangePreview(
  actionType: GovernedWriteAction,
  params: Record<string, unknown>,
  before: Record<string, unknown>,
  toMajor: (minor: unknown) => number,
): string {
  const name = quoted(before.name, String(before.id ?? 'the target'))
  switch (actionType) {
    case 'pause_ad':
      return `Pause ad ${name} (currently ${String(before.status ?? 'unknown')}).`
    case 'activate_ad':
      return `Activate ad ${name} (currently ${String(before.status ?? 'unknown')}). It will start spending.`
    case 'duplicate_adset': {
      const budget = budgetParamValue(params)
      return `Duplicate ad set ${name} as "${String(params.new_name)}" (the copy is created paused${budget == null ? '' : `, ${formatMoney(Number(budget))}/day`}).`
    }
    case 'adjust_budget': {
      const current = toMajor(before.daily_budget)
      const proposed = Number(budgetParamValue(params))
      const step = budgetStepPercent(current, proposed)
      const verb = proposed >= current ? 'Raise' : 'Lower'
      const sign = step === null ? '' : step >= 0 ? '+' : '−'
      const stepText = step === null ? '' : ` (${sign}${Math.abs(step).toFixed(1)}%)`
      return `${verb} ad set ${name} daily budget ${formatMoney(current)} → ${formatMoney(proposed)}${stepText}.`
    }
  }
}

/** The inverse of an executed change, restoring its before-state; null when there is none. */
export function rollbackFor(
  original: { action_type: string; params: Record<string, unknown> | null; before_state: Record<string, unknown> | null },
  toMajor: (minor: unknown) => number,
): { actionType: GovernedWriteAction; params: Record<string, unknown> } | null {
  const before = original.before_state
  if (!before) return null
  if (original.action_type === 'pause_ad') return before.status === 'ACTIVE' ? { actionType: 'activate_ad', params: {} } : null
  if (original.action_type === 'activate_ad') return before.status === 'PAUSED' ? { actionType: 'pause_ad', params: {} } : null
  if (original.action_type === 'adjust_budget') {
    const amount = toMajor(before.daily_budget)
    if (!Number.isFinite(amount) || amount <= 0) return null
    return { actionType: 'adjust_budget', params: { [budgetParamKey(original.params)]: roundMoney(amount) } }
  }
  return null
}

/** Demo only: the state a successful mutation would leave. `toMinor` converts to Meta's units. */
export function simulatedAfterState(
  actionType: GovernedWriteAction,
  before: Record<string, unknown>,
  params: Record<string, unknown>,
  toMinor: (major: number) => number,
): Record<string, unknown> {
  switch (actionType) {
    case 'pause_ad': return { ...before, status: 'PAUSED' }
    case 'activate_ad': return { ...before, status: 'ACTIVE' }
    case 'adjust_budget': return { ...before, daily_budget: String(toMinor(Number(budgetParamValue(params)))) }
    case 'duplicate_adset': {
      const budget = budgetParamValue(params)
      return {
        id: `${String(before.id)}-copy`, name: params.new_name, status: 'PAUSED',
        daily_budget: budget == null ? before.daily_budget ?? null : String(toMinor(Number(budget))),
      }
    }
  }
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)]))
  }
  return value
}

/** Exactly the keys and types the executor's mutation takes, nothing else. */
function paramsWellFormed(request: Pick<GovernedWriteRequest, 'actionType' | 'params'>): boolean {
  const keys = Object.keys(request.params).sort()
  const budgetKey = budgetParamKey(request.params)
  const budget = budgetParamValue(request.params)
  switch (request.actionType) {
    case 'pause_ad':
    case 'activate_ad':
      return keys.length === 0
    case 'adjust_budget':
      return keys.length === 1 && keys[0] === budgetKey && typeof budget === 'number' && Number.isFinite(budget) && budget > 0
    case 'duplicate_adset':
      return JSON.stringify(keys) === JSON.stringify([budgetKey, 'new_name'].sort())
        && typeof request.params.new_name === 'string' && request.params.new_name.trim().length > 0
        && (budget === null || (typeof budget === 'number' && Number.isFinite(budget) && budget > 0))
  }
}

function kindAuthorizes(actionType: GovernedWriteAction, kind: string, rollback: boolean): boolean {
  if (rollback) {
    if (actionType === 'activate_ad') return kind === 'pause'
    if (actionType === 'pause_ad') return kind === 'activate'
    return actionType === 'adjust_budget' && (kind === 'budget_scale' || kind === 'budget_cut')
  }
  return actionTypeForDecision(kind, actionType === 'pause_ad' || actionType === 'activate_ad' ? 'ad' : 'adset') === actionType
}

/**
 * Execution authority for an OWNER-initiated request (the agent path keeps validateWriteAuthority).
 * No causal-estimate requirement: the owner, not the engine, takes the call. Everything else holds:
 * account, policy floor, never diagnostic_only, approved, exact target, kind, and an engine-proposed
 * mutation when one exists. The database trigger repeats these rules.
 */
export function validateOwnerWriteAuthority(
  decision: WriteAuthorityDecision | null | undefined,
  request: GovernedWriteRequest,
  options: { rollback: boolean },
): WriteAuthorityValidation {
  if (!decision) return { allowed: false, reason: 'No ActionDecision is linked to this write.' }
  if (decision.ad_account_id !== request.adAccountDbId) return { allowed: false, reason: 'The ActionDecision belongs to a different ad account.' }
  if (decision.policy_version == null || decision.policy_version < ACTION_DECISION_POLICY_FLOOR) {
    return { allowed: false, reason: 'The ActionDecision predates the current authority policy.' }
  }
  if (decision.authority_tier !== 'execution_eligible' && decision.authority_tier !== 'owner_review') {
    return { allowed: false, reason: `Authority tier ${decision.authority_tier} cannot back a change, even one the owner initiated.` }
  }
  if (decision.approval_state !== 'approved') {
    return { allowed: false, reason: `ActionDecision approval state is ${decision.approval_state}; expected approved.` }
  }
  if (decision.target_level !== request.entityLevel || decision.target_id !== request.metaEntityId) {
    return { allowed: false, reason: 'The ActionDecision target does not match the requested Meta entity.' }
  }
  if (!kindAuthorizes(request.actionType, decision.action_kind, options.rollback)) {
    return { allowed: false, reason: 'The ActionDecision kind does not authorize this write action.' }
  }
  if (!paramsWellFormed(request)) {
    return { allowed: false, reason: 'The write request contains missing or ungoverned mutation parameters.' }
  }
  if (!options.rollback && decision.proposed_mutation
      && JSON.stringify(canonical(decision.proposed_mutation)) !== JSON.stringify(canonical(expectedMutation(request)))) {
    return { allowed: false, reason: 'The request does not match the mutation the ActionDecision proposed.' }
  }
  return { allowed: true, reason: 'The owner-initiated write matches its approved ActionDecision.' }
}
