/**
 * Write-access MCP tools — PROPOSAL ONLY.
 * pauseAd / activateAd / adjustBudget / duplicateAdSet create a PENDING change_request with a
 * dry-run preview, captured before-state, risk level, and rollback plan. They NEVER make a live
 * Meta change. Each request must match one execution-eligible ActionDecision exactly; a human then
 * approves that linked decision and request in one transaction, and only then — and only when
 * WRITE_MODE_ENABLED=true — does the executor apply it (idempotent + verified).
 * See src/lib/writes/executor.ts. Campaign and ad-set creation go through owner-approved campaign plans
 * (ADR-062; read-only here as get_campaign_plans / preview_campaign_plan); the test-draft tool remains a
 * NOT_IMPLEMENTED stub.
 */
import { getAdminClient } from '@/lib/supabase/admin'
import { proposeChange, type WriteActionType } from '@/lib/writes/executor'
import { BUDGET_PARAM, budgetFromToolArgs } from '@/lib/writes/budget-param'

function creationUnavailableResponse(tool: string): object {
  return {
    status: 'NOT_IMPLEMENTED',
    tool,
    message: 'Paused test creation is unavailable: Maxx has no governed experiment registry. Campaign plans (ADR-062) create campaigns in the owner console, not tests.',
    blocker_codes: ['experiment_registry_not_implemented', 'meta_object_creation_not_implemented'],
    note: 'No campaign, ad set, test, manual setup instruction, or Meta object was created.',
  }
}

// ── Account resolution + proposal helper ──
async function resolveAccountDbId(): Promise<string | null> {
  const accountId = process.env.META_AD_ACCOUNT_ID
  if (!accountId) return null
  const db = getAdminClient()
  const { data } = await db.from('ad_accounts').select('id').eq('account_id', accountId).maybeSingle()
  return (data as { id: string } | null)?.id ?? null
}

async function propose(
  actionType: WriteActionType,
  entityLevel: 'ad' | 'adset',
  metaEntityId: string,
  params: Record<string, unknown>,
  actionDecisionId: string,
  reason?: string
): Promise<object> {
  const adAccountDbId = await resolveAccountDbId()
  if (!adAccountDbId) return { status: 'ERROR', error: 'Could not resolve ad account (META_AD_ACCOUNT_ID).' }
  return proposeChange({
    adAccountDbId, actionDecisionId, actionType, entityLevel, metaEntityId, params,
    reason, requestedBy: 'agent',
  })
}

// ── Live actions — PROPOSAL ONLY (create a change request for human approval) ──
export async function pauseAd(args: { action_decision_id: string; ad_id: string; reason?: string }): Promise<object> {
  return propose('pause_ad', 'ad', args.ad_id, {}, args.action_decision_id, args.reason)
}

export async function activateAd(args: { action_decision_id: string; ad_id: string; reason?: string }): Promise<object> {
  return propose('activate_ad', 'ad', args.ad_id, {}, args.action_decision_id, args.reason)
}

/** Budget arguments: new_daily_budget (account currency), or its deprecated name new_daily_budget_usd. */
export interface BudgetToolArgs { new_daily_budget?: number; new_daily_budget_usd?: number }

export async function adjustBudget(args: { action_decision_id: string; adset_id: string; reason?: string } & BudgetToolArgs): Promise<object> {
  const budget = budgetFromToolArgs(args)
  if (!budget.ok) return { status: 'BLOCKED', message: budget.message }
  return propose(
    'adjust_budget', 'adset', args.adset_id,
    { [BUDGET_PARAM]: budget.value }, args.action_decision_id, args.reason,
  )
}

export async function duplicateAdSet(args: { action_decision_id: string; adset_id: string; new_name: string } & BudgetToolArgs): Promise<object> {
  const budget = budgetFromToolArgs(args)
  if (!budget.ok) return { status: 'BLOCKED', message: budget.message }
  return propose('duplicate_adset', 'adset', args.adset_id, {
    new_name: args.new_name,
    [BUDGET_PARAM]: budget.value ?? null,
  }, args.action_decision_id)
}

// ── Test creation — intentionally unavailable: there is no governed experiment registry. Arguments
// are ignored so direct callers cannot use this stub as an ungoverned setup-advice generator.
export async function createPausedTestDraft(_args: Record<string, unknown> = {}) {
  void _args
  return creationUnavailableResponse('create_paused_test_draft')
}
