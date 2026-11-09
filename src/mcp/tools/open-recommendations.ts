import { getAdminClient } from '@/lib/supabase/admin'
import {
  readOpenRecommendations,
  unavailableOpenRecommendationsRead,
  type OpenRecommendationsReadResult,
  type StoredRecommendation,
} from '@/lib/recommendations/store'
import { resolveOnlyActiveAccount } from '@/lib/accounts/active-account'

// MCP tool: expose the structured recommendation engine's OPEN output to the agent. Closes brain-audit
// hole 11: the daily job computes grounded, gate-evaluated recommendations (engine A) but the agent
// (engine C) couldn't see them — so chat re-derived advice from scratch and could silently disagree with
// what the dashboard showed the owner. Read-only; rows come straight from the `recommendations` table.

/** PURE: compact, agent-readable rendering of one stored recommendation (mirrors formatRecommendation,
 *  adapted to the stored/flattened row shape). */
export function renderStoredRecommendation(r: StoredRecommendation): string {
  const lines: string[] = []
  const target = r.target_entity_name ?? r.target_entity_id ?? r.target_entity_type
  lines.push(`[${r.recommendation_type.toUpperCase()}] ${target}`)
  lines.push(`  Observed: ${r.observed_fact}`)
  lines.push(`  Why: ${r.reason_for_action}`)
  lines.push(`  Authority: ${r.action_authority_tier}${r.action_authority_legacy ? ' (historical/legacy)' : ''}`)
  if (r.evidence_summary) {
    const range = r.date_range_start && r.date_range_end ? ` (${r.date_range_start}…${r.date_range_end})` : ''
    lines.push(`  Evidence: ${r.evidence_summary}${range}`)
  }
  if (r.target_language) lines.push(`  Diagnostic reference: ${r.target_language}`)
  lines.push(`  Confidence: ${r.confidence_label} (${r.confidence_score}) · Risk if wrong: ${r.risk_level} · Gate: ${r.gate_decision}`)
  if (r.low_data_warning) lines.push(`  ⚠ LOW DATA: ${r.low_data_warning}`)
  if (r.estimate_warning) lines.push(`  ⚠ ESTIMATE: ${r.estimate_warning}`)
  if (r.attribution_warning) lines.push(`  ⚠ ATTRIBUTION: ${r.attribution_warning}`)
  if (r.what_could_make_this_wrong?.length) lines.push(`  What could make this wrong: ${r.what_could_make_this_wrong.join(' ')}`)
  lines.push(`  Approval required: ${r.approval_required ? 'YES' : 'no'} · Action allowed now: ${r.action_allowed_now ? 'yes' : 'NO (write mode off / human approval)'}`)
  if (r.recommended_next_check_date) lines.push(`  Re-check on: ${r.recommended_next_check_date}`)
  return lines.join('\n')
}

export async function getOpenRecommendationsTool(args: { limit?: number }): Promise<object> {
  const limit = Math.min(Math.max(args?.limit ?? 20, 1), 50)

  let read: OpenRecommendationsReadResult = unavailableOpenRecommendationsRead(
    'account_unresolved',
    'The active ad account could not be resolved, so the current recommendation feed is unavailable.',
  )
  try {
    const db = getAdminClient()
    const activeAccount = await resolveOnlyActiveAccount(db)
    if (!activeAccount.ok) throw new Error(`active account lookup failed: ${activeAccount.reason}`)
    read = await readOpenRecommendations(activeAccount.account.id, limit)
  } catch (error) {
    console.warn(`[Recommendations MCP] Current feed unavailable: ${error instanceof Error ? error.message : 'unknown error'}`)
  }

  // `readOpenRecommendations` quarantines missing or unverifiable claim lineage. Keep this second
  // boundary because an MCP response is itself an authority surface: a future store regression or an
  // incomplete adapter must not turn an unverified recommendation into agent-visible action prose.
  const rows = read.recommendations.filter((row) => row.metric_claim_lineage_verified === true)
  const mcpLineageQuarantinedCount = read.recommendations.length - rows.length
  const note = read.health === 'healthy'
    ? read.visibleCount === 0
      ? 'The current recommendation read is a healthy empty snapshot. The engine has no visible current recommendations.'
      : 'The current recommendation read is healthy. Reconcile with these rows before proposing your own: do not duplicate one, and do not contradict one without explicitly saying what changed.'
    : read.health === 'degraded'
      ? 'The current recommendation feed is DEGRADED. Some rows or authority metadata were quarantined/unavailable; you must not infer that the engine proposes nothing from an empty returned list. Do not make a money action from this partial feed.'
      : 'The current recommendation feed is UNAVAILABLE. You cannot claim that the engine proposes nothing and must not make a money action until the read is restored.'

  return {
    read_health: read.health,
    visible_count: read.visibleCount,
    quarantined_count: read.quarantinedCount,
    mcp_lineage_quarantined_count: mcpLineageQuarantinedCount,
    read_reasons: read.reasons.map((reason) => ({
      code: reason.code,
      affected_count: reason.affectedCount,
      message: reason.message,
    })),
    count: rows.length,
    recommendations: rows.map((r) => ({
      id: r.id,
      type: r.recommendation_type,
      target: r.target_entity_name ?? r.target_entity_id ?? r.target_entity_type,
      gate_decision: r.gate_decision,
      action_authority_tier: r.action_authority_tier,
      action_authority_legacy: r.action_authority_legacy,
      confidence: r.confidence_label,
      risk: r.risk_level,
      generated_at: r.generated_at,
      rendered: renderStoredRecommendation(r),
    })),
    note,
  }
}
