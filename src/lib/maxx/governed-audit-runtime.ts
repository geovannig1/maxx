import { resolveOnlyActiveAccount } from '@/lib/accounts/active-account'
import { diagnoseLaunchPerformance } from '@/lib/diagnostics/launch-performance'
import type { MetricClaim } from '@/lib/cockpit/contracts'
import { getPerformanceCockpit } from '@/mcp/tools/performance-cockpit'
import { getReconciliation } from '@/mcp/tools/reconciliation'
import { getEconomics } from '@/mcp/tools/economics'
import { getOperatingMode } from '@/mcp/tools/operating-mode'
import { getCreativeInsights } from '@/mcp/tools/creative-insights'
import { getCreativeFatigue } from '@/mcp/tools/creative-fatigue'
import { getExpertKnowledge } from '@/mcp/tools/expert-knowledge'
import { getPlaybookTool } from '@/mcp/tools/playbook'
import { getDecisionHistory } from '@/mcp/tools/decision-history'
import { ACTION_DECISION_POLICY_FLOOR } from '@/lib/authority/legacy-cutover'
import {
  readOpenRecommendations,
  type StoredRecommendation,
} from '@/lib/recommendations/store'
import {
  buildGovernedAuditEvidence,
  type GovernedAuditEvidence,
} from './governed-audit'
import { classifyMaxxAuditFocus } from './audit-focus'

interface InternalLookup {
  tool: string
  args: Record<string, unknown>
  result: unknown
}

export interface GovernedAuditRuntimeResult {
  claims: MetricClaim[]
  requiredClaimIds: string[]
  persistedFinalActionDecisions: unknown[]
  /** Server-only reads. Callers may derive bounded provenance metadata, but must not serialize data. */
  consulted: InternalLookup[]
}

const EMPTY_RESULT: GovernedAuditRuntimeResult = {
  claims: [],
  requiredClaimIds: [],
  persistedFinalActionDecisions: [],
  consulted: [],
}

function daysBefore(date: string, days: number): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null
  const parsed = new Date(`${date}T00:00:00Z`)
  if (Number.isNaN(parsed.getTime())) return null
  parsed.setUTCDate(parsed.getUTCDate() - days)
  return parsed.toISOString().slice(0, 10)
}

async function readLookup(
  tool: string,
  args: Record<string, unknown>,
  read: () => Promise<unknown>,
): Promise<InternalLookup> {
  try {
    return { tool, args, result: await read() }
  } catch {
    console.warn(`[MaxxChat] Internal governed read failed: ${tool}`)
    return { tool, args, result: { available: false } }
  }
}

function resultFor(lookups: readonly InternalLookup[], tool: string): unknown {
  return lookups.find((lookup) => lookup.tool === tool)?.result ?? null
}

const ACTION_KINDS = new Set([
  'budget_scale', 'budget_cut', 'pause', 'activate',
  'creative_refresh', 'structural', 'observe',
])
const AUTHORITY_TIERS = new Set(['execution_eligible', 'owner_review', 'diagnostic_only'])
const APPROVAL_STATES = new Set(['not_requested', 'pending', 'approved', 'rejected'])
const SOURCE_KINDS = new Set([
  'flag', 'recommendation', 'alert', 'diagnostic', 'evaluator', 'report',
  'creative_fatigue', 'legacy',
])

/** Server-only projection. This record is rendered locally and is never added to model context. */
export function projectInternalFinalActionDecisions(
  rows: readonly StoredRecommendation[],
): unknown[] {
  const projected: unknown[] = []
  for (const row of rows) {
    const decision = row.action_decision
    if (!decision || row.metric_claim_lineage_verified !== true) continue
    if (!Number.isInteger(decision.policy_version)
        || (decision.policy_version ?? 0) < ACTION_DECISION_POLICY_FLOOR) continue
    if (typeof decision.id !== 'string' || !decision.id.trim() || decision.id.length > 240) continue
    if (typeof decision.owner_copy !== 'string' || !decision.owner_copy.trim()
        || decision.owner_copy.length > 1_200 || /[\r\n]/.test(decision.owner_copy)) continue
    if (!ACTION_KINDS.has(decision.action_kind)
        || !AUTHORITY_TIERS.has(decision.authority_tier)
        || !APPROVAL_STATES.has(decision.approval_state)
        || !SOURCE_KINDS.has(decision.source_kind)) continue
    if (decision.source_id !== null
        && (typeof decision.source_id !== 'string' || !decision.source_id.trim()
          || decision.source_id.length > 240)) continue
    projected.push({
      id: decision.id,
      persisted: true,
      final: true,
      record_type: 'action_decisions',
      policy_version: decision.policy_version,
      action_kind: decision.action_kind,
      authority_tier: decision.authority_tier,
      approval_state: decision.approval_state,
      owner_copy: decision.owner_copy,
      lineage: {
        source_kind: decision.source_kind,
        source_id: decision.source_id,
      },
    })
    if (projected.length === 3) break
  }
  return projected
}

async function readInternalRecommendations(accountId: string): Promise<Record<string, unknown>> {
  const read = await readOpenRecommendations(accountId, 20)
  const rows = read.recommendations.filter(
    (row) => row.metric_claim_lineage_verified === true,
  )
  return {
    read_health: read.health,
    count: rows.length,
    persisted_final_action_decisions: projectInternalFinalActionDecisions(rows),
  }
}

/**
 * Gather the minimum evidence set for the question inside the application server.
 *
 * This is deliberately not an MCP tool and its raw results are never model context. The model may
 * still independently call the existing read-only tools; this gather only supplies deterministic
 * server-owned claims that cannot be lost when the model submits its id-only brief.
 */
export async function gatherGovernedAuditEvidence(input: {
  question: string
  closedThrough: string | null
}): Promise<GovernedAuditRuntimeResult> {
  const end = input.closedThrough
  const start = end ? daysBefore(end, 29) : null
  if (!end || !start) return EMPTY_RESULT

  const activeAccount = await resolveOnlyActiveAccount().catch(() => null)
  if (!activeAccount?.ok) return EMPTY_RESULT

  const focus = classifyMaxxAuditFocus(input.question)
  const rangeArgs = { start_date: start, end_date: end }
  const windowArgs = { window_days: 30 }
  const reads: Array<Promise<InternalLookup>> = []

  if (focus === 'owner_ads_audit' || focus === 'budget_goal' || focus === 'general') {
    reads.push(readLookup(
      'get_performance_cockpit',
      rangeArgs,
      () => getPerformanceCockpit(rangeArgs),
    ))
  }
  if (focus === 'owner_ads_audit' || focus === 'adset_setup') {
    reads.push(readLookup(
      'diagnose_ad_performance',
      windowArgs,
      () => diagnoseLaunchPerformance({
        adAccountDbId: activeAccount.account.id,
        window: { from: start, to: end },
        includeLiveEnrichment: false,
      }),
    ))
  }
  if (focus === 'adset_setup') {
    reads.push(readLookup(
      'get_expert_knowledge',
      { area: 'audience', topic: 'ad set optimization', limit: 10 },
      () => getExpertKnowledge({ area: 'audience', topic: 'ad set optimization', limit: 10 }),
    ))
    reads.push(readLookup(
      'get_playbook',
      { intent: 'structure_audience' },
      async () => getPlaybookTool({ intent: 'structure_audience' }),
    ))
  }
  if (focus === 'owner_ads_audit') {
    reads.push(readLookup('get_reconciliation', rangeArgs, () => getReconciliation(rangeArgs)))
  }
  if (focus === 'owner_ads_audit' || focus === 'budget_goal') {
    reads.push(readLookup('get_economics', rangeArgs, () => getEconomics(rangeArgs)))
  }
  if (focus === 'owner_ads_audit' || focus === 'budget_goal' || focus === 'general') {
    reads.push(readLookup('get_operating_mode', {}, () => getOperatingMode()))
  }
  if (focus === 'creative_quality') {
    reads.push(readLookup(
      'get_creative_insights',
      rangeArgs,
      () => getCreativeInsights(rangeArgs),
    ))
    reads.push(readLookup(
      'get_creative_performance',
      rangeArgs,
      () => getCreativeFatigue(rangeArgs),
    ))
  }
  if (focus === 'budget_goal') {
    reads.push(readLookup(
      'get_playbook',
      { intent: 'optimization_event' },
      async () => getPlaybookTool({ intent: 'optimization_event' }),
    ))
    reads.push(readLookup(
      'get_decision_history',
      { limit: 20 },
      () => getDecisionHistory({ limit: 20 }),
    ))
  }
  reads.push(readLookup(
    'get_recommendations',
    { limit: 20 },
    () => readInternalRecommendations(activeAccount.account.id),
  ))

  const consulted = await Promise.all(reads)
  const packet: GovernedAuditEvidence = buildGovernedAuditEvidence({
    focus,
    accountId: activeAccount.account.id,
    window: { start, end },
    asOf: new Date().toISOString(),
    cockpit: resultFor(consulted, 'get_performance_cockpit'),
    diagnosis: resultFor(consulted, 'diagnose_ad_performance'),
    reconciliation: resultFor(consulted, 'get_reconciliation'),
    economics: resultFor(consulted, 'get_economics'),
    operatingMode: resultFor(consulted, 'get_operating_mode'),
    recommendations: resultFor(consulted, 'get_recommendations'),
    creative: resultFor(consulted, 'get_creative_insights'),
  })
  return {
    claims: packet.claims,
    requiredClaimIds: packet.required_claim_ids,
    persistedFinalActionDecisions: packet.persisted_final_action_decisions,
    consulted,
  }
}
