import { getAdminClient } from '@/lib/supabase/admin'
import { getLedgerForAccount, unresolvedConflicts } from '@/lib/recommendations/setup-ledger'

// Consolidated, human/agent-readable summary of everything the system has learned —
// recommendation win-rates + what's working / not working across targeting, settings, spend, and time —
// plus the DECISION MEMORY brief: the owner's standing decisions, manual actions, unresolved setting
// conflicts, and lessons awaiting review, so the report narrative can respect them instead of
// regenerating advice blind to what the human already decided.

export async function buildLearningBrief(adAccountDbId: string): Promise<string | null> {
  void adAccountDbId
  // learned_patterns has no causal-contribution lineage. Do not inject its historical CPA/bookings
  // win rates into model prompts; the decision-memory brief below remains available separately.
  return null
}

/** The owner's decision memory, formatted for the report/agent context. Null when there is nothing to
 *  say (pre-launch, no decisions yet). Read-only; degrades to null on any error so reports never break. */
export async function buildDecisionMemoryBrief(adAccountDbId: string, today: string): Promise<string | null> {
  try {
    const db = getAdminClient()
    const lines: string[] = []

    // 1. Standing decisions on recommendations (latest per stable key — the table is already latest-only).
    const { data: decRows } = await db
      .from('recommendation_decisions')
      .select('entity_key, recommendation_type, user_decision, decision_note, decision_date, action_taken')
      .eq('ad_account_id', adAccountDbId)
      .order('decision_date', { ascending: false })
      .limit(25)
    const decs = (decRows ?? []) as { entity_key: string; recommendation_type: string; user_decision: string; decision_note: string | null; decision_date: string; action_taken: boolean }[]
    if (decs.length > 0) {
      lines.push('STANDING OWNER DECISIONS (respect these — never re-push a rejected/snoozed item without saying what changed):')
      for (const d of decs) {
        const note = d.decision_note ? ` — “${d.decision_note}”` : ''
        lines.push(`- [${d.user_decision.replace(/_/g, ' ')}] ${d.recommendation_type.replace(/_/g, ' ')} on ${d.entity_key} (${d.decision_date.slice(0, 10)})${d.action_taken ? ' · acted on' : ''}${note}`)
      }
      lines.push('')
    }

    // 2. Setup ledger: manual actions this week + unresolved setting conflicts.
    const ledger = await getLedgerForAccount(adAccountDbId)
    const weekAgo = new Date(today + 'T00:00:00Z')
    weekAgo.setUTCDate(weekAgo.getUTCDate() - 7)
    const weekAgoStr = weekAgo.toISOString().slice(0, 10)
    const manual = ledger.filter((r) => r.origin === 'manual_action' && r.created_at.slice(0, 10) >= weekAgoStr).slice(0, 10)
    if (manual.length > 0) {
      lines.push('MANUAL ACTIONS LOGGED (last 7d — the human changed these outside Maxx):')
      for (const m of manual) {
        const change = `${m.previous_value ? `${m.previous_value} → ` : ''}${m.actual_launched_value ?? m.final_value ?? '—'}`
        lines.push(`- ${m.setting_name}: ${change}${m.entity_name ? ` on ${m.entity_name}` : ''} (${m.created_at.slice(0, 10)})`)
      }
      lines.push('')
    }
    const conflicts = unresolvedConflicts(ledger)
    if (conflicts.length > 0) {
      lines.push('UNRESOLVED SETTING CONFLICTS (prior decision stays ACTIVE until the owner approves the switch):')
      for (const c of conflicts.slice(0, 5)) {
        lines.push(`- ${c.setting_name}: ${c.change_summary ?? 'switch pending'}${c.entity_name ? ` on ${c.entity_name}` : ''}`)
      }
      lines.push('')
    }

    // 3. Lessons awaiting the human review gate (decisive, non-estimate, pending).
    const { count: pendingCount } = await db
      .from('recommendation_outcomes')
      .select('id', { count: 'exact', head: true })
      .eq('ad_account_id', adAccountDbId)
      .eq('review_status', 'pending')
      .in('outcome', ['worked', 'failed'])
    if ((pendingCount ?? 0) > 0) {
      lines.push(`OUTCOMES AWAITING YOUR REVIEW: ${pendingCount} scored lesson(s) pending on the review board — nothing becomes trusted learning until approved.`)
    }

    if (lines.length === 0) return null
    return lines.join('\n').trim()
  } catch {
    return null
  }
}
