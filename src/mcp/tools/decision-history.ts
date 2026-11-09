import { getAdminClient } from '@/lib/supabase/admin'
import { getLedgerForAccount, unresolvedConflicts } from '@/lib/recommendations/setup-ledger'
import { activeAccountErrorCode, resolveOnlyActiveAccount } from '@/lib/accounts/active-account'

// Decision-memory read tool (intelligence-next): what the OWNER decided — on recommendations
// (accepted/rejected/acted-on/snoozed) and in the setup ledger (setting decisions, manual actions,
// unresolved conflicts). Read-only. This is the tool that lets the agent answer "what did we decide
// about X and why?" and stop re-recommending things the human already vetoed.

export async function getDecisionHistory(args: {
  entity_key?: string
  setting_category?: string
  limit?: number
}): Promise<object> {
  const db = getAdminClient()
  const limit = Math.min(args.limit ?? 30, 100)

  const activeAccount = await resolveOnlyActiveAccount(db)
  if (!activeAccount.ok) return {
    error: activeAccount.reason === 'ambiguous'
      ? 'More than one active ad account is configured; decision history is unavailable.'
      : activeAccount.reason === 'not_found'
        ? 'No active ad account is configured.'
        : 'The active ad account could not be resolved; decision history is unavailable.',
    error_code: activeAccountErrorCode(activeAccount.reason),
    recommendation_decisions: [],
    setup_decisions: [],
    unresolved_conflicts: [],
  }
  const adAccountDbId = activeAccount.account.id

  let decQ = db
    .from('recommendation_decisions')
    .select('entity_key, recommendation_type, user_decision, decision_note, decided_by, decision_date, action_taken, action_taken_date, follow_up_date')
    .eq('ad_account_id', adAccountDbId)
    .order('decision_date', { ascending: false })
    .limit(limit)
  if (args.entity_key) decQ = decQ.eq('entity_key', args.entity_key)
  const { data: decisions } = await decQ

  let ledger = await getLedgerForAccount(adAccountDbId, 200)
  if (args.entity_key) ledger = ledger.filter((r) => r.entity_key === args.entity_key)
  if (args.setting_category) ledger = ledger.filter((r) => r.setting_category === args.setting_category)
  const conflicts = unresolvedConflicts(ledger)

  return {
    recommendation_decisions: decisions ?? [],
    setup_decisions: ledger.slice(0, limit).map((r) => ({
      entity: r.entity_name ?? r.entity_key,
      setting: r.setting_name,
      category: r.setting_category,
      origin: r.origin,
      previous_value: r.previous_value,
      chosen_value: r.final_value ?? r.proposed_value,
      launched_value: r.actual_launched_value,
      user_decision: r.user_decision,
      note: r.decision_note,
      reason: r.reason,
      action_taken: r.action_taken,
      conflict_pending: r.conflicts_with_prior && !r.prior_deprecated && r.user_decision !== 'rejected',
      date: r.created_at.slice(0, 10),
    })),
    unresolved_conflicts: conflicts.map((c) => ({
      entity: c.entity_name ?? c.entity_key,
      setting: c.setting_name,
      change: c.change_summary,
      why_changed: c.why_changed,
      switch_risk: c.switch_risk,
    })),
    note: 'RESPECT standing decisions: never re-recommend a rejected/snoozed item without saying what changed; never propose changing a recorded setting without citing the recorded decision. This read executes nothing; any live mutation requires an exact execution-eligible ActionDecision, paired owner approval, and write mode.',
  }
}
