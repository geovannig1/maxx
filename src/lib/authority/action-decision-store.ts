import type { SupabaseClient } from '@supabase/supabase-js'
import type { ActionKind, AuthorityTier, EvidencePlane } from './action-authority'
import type { AuthorityCeiling } from './directional-policy'
import type { AuthorityBasis } from '@/lib/modes/operating-mode'
import type { MaxxCommercialObjective } from '@/lib/economics/profit-policy'
import type { PersistedDecisionRef } from './legacy-cutover'
import { OWNER_TRANSITION_RPC } from './owner-transition-denials'

export type ActionTargetLevel = 'account' | 'campaign' | 'adset' | 'ad' | 'audience' | 'creative'
export type ActionDecisionSource = 'flag' | 'recommendation' | 'alert' | 'diagnostic' | 'evaluator' | 'report' | 'creative_fatigue' | 'legacy'

/** JSON payload accepted by the action-decision commit RPC (baseline schema). Account and source kind are forced by the RPC. */
export interface ActionDecisionCommit {
  action_kind: ActionKind
  target_level: ActionTargetLevel
  target_id: string | null
  evidence_plane: EvidencePlane
  evidence_basis: AuthorityBasis
  authority_tier: AuthorityTier
  authority_reason: string
  owner_copy: string
  direction_ceiling: AuthorityCeiling
  direction_reason: string
  policy_version: number
  dedupe_key: string
  source_id: string
  window_start: string | null
  window_end: string | null
  /** Commercial objective. Meta's campaign delivery objective is diagnostic and must not occupy this field. */
  objective: MaxxCommercialObjective | null
  matured: boolean | null
  continuity: boolean | null
  windows_conflict: boolean | null
  metrics: Record<string, number | null>
  proposed_mutation: Record<string, unknown> | null
  /** Immutable evidence lineage. Both ids name one atomically-published paid-cohort pair. */
  paid_cohort_recent_generation_id: string | null
  paid_cohort_matured_generation_id: string | null
  /** Pragmatic media-buyer mode: attributed-only association evidence with owner approval. */
  pragmatic_media_buyer: boolean
}

export interface PersistedActionDecision extends PersistedDecisionRef {
  id: string
  source_kind: ActionDecisionSource
  source_id: string | null
  action_kind: ActionKind
  target_level: ActionTargetLevel
  target_id: string | null
  evidence_plane: EvidencePlane
  evidence_basis: AuthorityBasis
  direction_ceiling: AuthorityCeiling
  direction_reason: string
  approval_state: 'not_requested' | 'pending' | 'approved' | 'rejected'
  paid_cohort_recent_generation_id: string | null
  paid_cohort_matured_generation_id: string | null
  causal_contribution_estimate_id: string | null
  /** Immutable observation snapshot used to reach this decision. */
  metrics: Record<string, number | null>
  /** Immutable owner-facing proposed state, when one was governed. */
  proposed_mutation: Record<string, unknown> | null
}

export interface RecommendationOwnerTransitionCommit {
  adAccountId: string
  recommendationId: string
  entityKey: string
  recommendationType: string
  userDecision: string
  decisionNote: string | null
  decidedBy: string
  actionTaken: boolean
  followUpDate: string | null
  expectedOutcomeWindow: string | null
}

export interface PersistedRecommendationOwnerTransition {
  user_decision: string
  action_taken: boolean
  decision_date: string
}

const READ_COLUMNS = 'id, source_kind, source_id, action_kind, target_level, target_id, evidence_plane, evidence_basis, authority_tier, authority_reason, owner_copy, direction_ceiling, direction_reason, policy_version, approval_state, paid_cohort_recent_generation_id, paid_cohort_matured_generation_id, causal_contribution_estimate_id, metrics, proposed_mutation'

/** Batch read; callers choose whether a read failure should fail-stop or resolve legacy. */
export async function readActionDecisionsBySource(
  db: SupabaseClient,
  adAccountId: string,
  sourceKind: ActionDecisionSource,
  sourceIds: string[],
): Promise<Map<string, PersistedActionDecision>> {
  const ids = [...new Set(sourceIds.filter(Boolean))]
  if (ids.length === 0) return new Map()
  const { data, error } = await db.from('action_decisions').select(READ_COLUMNS)
    .eq('ad_account_id', adAccountId).eq('source_kind', sourceKind).in('source_id', ids)
  if (error) throw new Error(`action_decisions(${sourceKind}) read failed: ${error.message}`)
  const map = new Map<string, PersistedActionDecision>()
  for (const row of (data ?? []) as unknown as PersistedActionDecision[]) {
    if (!row.source_id) continue
    const prior = map.get(row.source_id)
    if (prior) throw new Error(`multiple action_decisions for ${sourceKind}:${row.source_id}`)
    map.set(row.source_id, row)
  }
  return map
}

/**
 * The only service-role write path for protected owner recommendation states. The database RPC binds
 * the exact recommendation, ActionDecision, account, flag generation, and immutable MetricClaims in
 * the same transaction as the upsert; callers must not fall back to a table write when this rejects.
 */
export async function commitRecommendationOwnerTransition(
  db: SupabaseClient,
  commit: RecommendationOwnerTransitionCommit,
): Promise<PersistedRecommendationOwnerTransition> {
  const { data, error } = await db.rpc('commit_recommendation_owner_transition', {
    p_account: commit.adAccountId,
    p_recommendation_id: commit.recommendationId,
    p_entity_key: commit.entityKey,
    p_recommendation_type: commit.recommendationType,
    p_user_decision: commit.userDecision,
    p_decision_note: commit.decisionNote,
    p_decided_by: commit.decidedBy,
    p_action_taken: commit.actionTaken,
    p_follow_up_date: commit.followUpDate,
    p_expected_outcome_window: commit.expectedOutcomeWindow,
  })
  if (error) throw new Error(`${OWNER_TRANSITION_RPC}: ${error.message}`)
  const row = Array.isArray(data) ? data[0] : data
  if (!row || typeof row !== 'object') throw new Error('commit_recommendation_owner_transition returned no decision')
  return row as PersistedRecommendationOwnerTransition
}
