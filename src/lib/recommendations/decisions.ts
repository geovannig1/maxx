import { getAdminClient } from '@/lib/supabase/admin'
import type { Recommendation } from './types'

// Explicit human DECISION layer (closed-loop learning). Decisions record INTENT — they never execute
// anything (write mode stays OFF) and never directly mutate learned_patterns; trusted learning still
// comes ONLY from reviewed outcomes. This module owns the decision vocabulary, the stable entity key,
// the read path, and applyDecisionMemory() — the rule that makes daily regeneration RESPECT a standing
// human decision instead of regenerating blind (a rejected rec must not come back as fresh actionable).

export const USER_DECISIONS = ['accepted', 'rejected', 'acted_on', 'ignored', 'snoozed', 'needs_more_data'] as const
export type UserDecision = typeof USER_DECISIONS[number]

export interface RecommendationDecision {
  user_decision: UserDecision
  decision_note: string | null
  decided_by: string | null
  decision_date: string
  action_taken: boolean
  action_taken_date: string | null
  follow_up_date: string | null
  expected_outcome_window: string | null
  learning_eligibility: boolean | null
}

/** Stable key so a decision follows the CURRENT open rec across daily regeneration (which supersedes
 *  rec rows). Account-level recs collapse to 'account'. */
export function entityKeyFor(targetEntityId: string | null | undefined): string {
  return targetEntityId && targetEntityId.trim() ? targetEntityId : 'account'
}

export function decisionMapKey(entityKey: string, recommendationType: string): string {
  return `${entityKey}|${recommendationType}`
}

/** Whether a decision derives `action_taken`. "acted_on" always means the human acted; every other
 *  decision defaults to not-acted unless the caller explicitly says so. "accepted" ≠ executed. */
export function derivesActionTaken(userDecision: UserDecision, explicit?: boolean): boolean {
  if (userDecision === 'acted_on') return true
  return explicit ?? false
}

/** Does this decision make the recommendation's later outcome REVIEW-eligible? Only when the human
 *  actually acted. "ignored" / "needs_more_data" / "snoozed" never become negative learning by
 *  themselves — the outcome scorer already treats a not-acted-on rec as inconclusive. */
export function isOutcomeReviewEligible(d: { user_decision: UserDecision; action_taken: boolean }): boolean {
  return d.action_taken || d.user_decision === 'acted_on'
}

export type DecisionMemoryEffect =
  | 'none'
  | 'held_rejected'
  | 'held_snoozed'
  | 'held_needs_more_data'
  | 'resurfaced_after_snooze'
  | 'evidence_strengthened'
  | 'annotated_acted_on'
  | 'annotated_accepted'

const HELD_CONFIDENCE_CAP = 0.35

function fmtDate(iso: string | null | undefined): string {
  return iso ? iso.slice(0, 10) : 'earlier'
}

/** PURE: apply a standing human decision to a freshly regenerated recommendation of the same
 *  (entity, type). The veto rules:
 *  - REJECTED     → demote to hold (low confidence), cite the rejection; held until the human changes
 *                   the decision. Never silently regenerate a vetoed rec as fresh actionable.
 *  - SNOOZED      → demote to hold until follow_up_date (indefinitely if none); after the date it
 *                   resurfaces with an annotation.
 *  - NEEDS_MORE_DATA → demote to hold UNLESS the gate now scores it high-confidence (the evidence
 *                   materially strengthened since the human asked for more data) — then surface, annotated.
 *  - ACTED_ON     → surface annotated ("outcome scoring pending — avoid double-acting").
 *  - ACCEPTED     → surface annotated (accepted but not yet acted on).
 *  Never mutates the input; the annotation lands in grounding.reasons (persisted via grounding_json)
 *  AND what_could_make_this_wrong (rendered on the card). Nothing here executes anything. */
export function applyDecisionMemory(
  rec: Recommendation,
  decision: RecommendationDecision | null | undefined,
  today: string
): { rec: Recommendation; effect: DecisionMemoryEffect } {
  if (!decision) return { rec, effect: 'none' }

  const when = fmtDate(decision.decision_date)
  const note = decision.decision_note ? ` — “${decision.decision_note}”` : ''

  const annotated = (line: string): Recommendation => ({
    ...rec,
    what_could_make_this_wrong: [...rec.what_could_make_this_wrong, line],
    grounding: { ...rec.grounding, reasons: [...rec.grounding.reasons, line] },
  })
  const held = (line: string): Recommendation => {
    const a = annotated(line)
    return {
      ...a,
      confidence_score: Math.min(a.confidence_score, HELD_CONFIDENCE_CAP),
      confidence_label: 'low',
      approval_required: true,
      action_allowed_now: false,
      grounding: { ...a.grounding, decision: 'hold', passed: false },
    }
  }

  switch (decision.user_decision) {
    case 'rejected':
      return {
        rec: held(`Standing owner decision: REJECTED on ${when}${note}. Held — Maxx will not re-push this until you change that decision.`),
        effect: 'held_rejected',
      }
    case 'snoozed': {
      if (decision.follow_up_date && decision.follow_up_date <= today) {
        return {
          rec: annotated(`You snoozed this on ${when} until ${decision.follow_up_date}${note}; the snooze has expired, so it is resurfacing.`),
          effect: 'resurfaced_after_snooze',
        }
      }
      const until = decision.follow_up_date ? ` until ${decision.follow_up_date}` : ''
      return { rec: held(`Standing owner decision: SNOOZED on ${when}${until}${note}. Held.`), effect: 'held_snoozed' }
    }
    case 'needs_more_data': {
      if (rec.confidence_label === 'high') {
        return {
          rec: annotated(`You asked for more data on ${when}${note}; the grounding gate now scores this HIGH confidence, so it is resurfacing.`),
          effect: 'evidence_strengthened',
        }
      }
      return {
        rec: held(`Standing owner decision: NEEDS MORE DATA (${when})${note}. Held — evidence has not materially strengthened (still ${rec.confidence_label}).`),
        effect: 'held_needs_more_data',
      }
    }
    case 'acted_on':
      return {
        rec: annotated(`You marked this ACTED ON on ${fmtDate(decision.action_taken_date ?? decision.decision_date)}${note}; outcome scoring is pending — avoid double-acting on the same signal.`),
        effect: 'annotated_acted_on',
      }
    case 'accepted':
      return {
        rec: annotated(`You ACCEPTED this on ${when}${note} but have not marked it acted on — accepted ≠ executed.`),
        effect: 'annotated_accepted',
      }
    default:
      return { rec, effect: 'none' }
  }
}

/** Load the latest decision per (entity, type) for an account, keyed by decisionMapKey(). */
export async function getDecisionsForAccount(adAccountDbId: string): Promise<Map<string, RecommendationDecision>> {
  const db = getAdminClient()
  const out = new Map<string, RecommendationDecision>()
  const { data, error } = await db
    .from('recommendation_decisions')
    .select('entity_key, recommendation_type, user_decision, decision_note, decided_by, decision_date, action_taken, action_taken_date, follow_up_date, expected_outcome_window, learning_eligibility')
    .eq('ad_account_id', adAccountDbId)
  if (error) return out
  for (const r of (data ?? []) as (RecommendationDecision & { entity_key: string; recommendation_type: string })[]) {
    out.set(decisionMapKey(r.entity_key, r.recommendation_type), r)
  }
  return out
}
