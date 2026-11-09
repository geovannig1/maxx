// Budget-reallocation suggestions — "move $X/day from a losing entity to a winning one." This does NOT
// invent thresholds: it COMPOSES the existing flag engine (which already grounds winner/loser/
// scale_candidate against the central target ranges) plus the Trust Engine score. Every suggestion is a
// SUGGESTION only — approval-gated, write mode stays OFF — and carries the trust behind it so a move on
// thin data is shown as "review carefully", never "safe to act".

import type { FlagType } from '@/types/db'
import { TRUST_BAR } from '@/lib/trust/trust'
import { decideActionAuthority, type ActionAuthorityDecision } from '@/lib/authority/action-authority'
import type { AuthorityBasis } from '@/lib/modes/operating-mode'
import { formatMoney } from '@/lib/utils/format-currency'

/** Minimum trust to even SUGGEST an entity as a budget source/destination (below this = too thin to pair). */
export const MIN_SUGGEST_TRUST = 55
/** Conservative single-step shift: never move more than this fraction of a loser's daily budget at once
 *  (mirrors the flag engine's "20% increase, re-check in 3 days" no-oscillation guidance). */
export const MAX_SHIFT_FRACTION = 0.25

export interface EntityPerf {
  id: string
  name: string
  level: 'campaign' | 'adset'
  dailyBudget: number | null // dollars/day; null when budget lives at another level (CBO)
  spend: number
  bookings: number
  cpa: number | null
  flag: FlagType | null // from evaluateFlag()
  trust: number // 0..100 from computeTrust()
}

export interface Reallocation {
  fromId: string
  fromName: string
  toId: string
  toName: string
  suggestedShiftDaily: number // $/day to move
  rationale: string
  trust: number // min of the two entities' trust — the weakest link bounds the suggestion
  meetsBar: boolean // trust >= TRUST_BAR ⇒ "safe to act"; else "review carefully"
  approvalRequired: true // ALWAYS — write mode is off; a human gates every live change
  authorityTier: 'owner_review' | 'execution_eligible'
}

export interface ReallocationAssessment {
  fromId: string
  fromName: string
  toId: string
  toName: string
  trust: number
  cut: ActionAuthorityDecision
  scale: ActionAuthorityDecision
}

const round = (n: number) => Math.round(n)

/** Pair modelled-performance signals, then ask the ONE authority layer about both sides. Trust can
 * qualify a diagnostic for attention; it can never promote Meta-modelled outcomes into money authority. */
export function assessReallocationPairs(
  entities: EntityPerf[],
  basis: AuthorityBasis = 'calendar_period_signal',
): ReallocationAssessment[] {
  const losers = entities
    .filter((e) => e.flag === 'loser' && (e.dailyBudget ?? 0) > 0 && e.trust >= MIN_SUGGEST_TRUST)
    .sort((a, b) => b.spend - a.spend) // free the most wasteful spend first
  const winners = entities
    .filter((e) => (e.flag === 'winner' || e.flag === 'scale_candidate') && e.trust >= MIN_SUGGEST_TRUST)
    .sort((a, b) => (a.cpa ?? Infinity) - (b.cpa ?? Infinity) || b.trust - a.trust) // best efficiency first

  if (losers.length === 0 || winners.length === 0) return []

  const out: ReallocationAssessment[] = []
  const usedWinners = new Set<string>()
  for (const loser of losers) {
    // Greedily pair each loser with the best winner not yet receiving a shift (one shift per winner per
    // round keeps suggestions legible and avoids over-scaling a single entity).
    const winner = winners.find((w) => !usedWinners.has(w.id) && w.id !== loser.id)
    if (!winner) break
    usedWinners.add(winner.id)

    const trust = Math.min(loser.trust, winner.trust)
    out.push({
      fromId: loser.id,
      fromName: loser.name,
      toId: winner.id,
      toName: winner.name,
      trust,
      cut: decideActionAuthority({
        kind: 'budget_cut', plane: 'meta_modelled', subjectRef: loser.name,
        observation: `Meta-modelled delivery flags this entity as a possible budget source; spend was ${formatMoney(loser.spend)}.`,
        investigate: 'whether interaction-cohort outcomes support a reduction for this exact entity and period',
      }, basis),
      scale: decideActionAuthority({
        kind: 'budget_scale', plane: 'meta_modelled', subjectRef: winner.name,
        observation: `Meta-modelled delivery flags this entity as a possible budget destination; spend was ${formatMoney(winner.spend)}.`,
        investigate: 'whether interaction-cohort outcomes support an increase for this exact entity and period',
      }, basis),
    })
  }
  return out
}

/** Action-shaped output exists only when BOTH sides independently clear final authority. With this
 * account's current Meta-modelled inputs, assessments remain diagnostic and this returns []. */
export function suggestReallocations(
  entities: EntityPerf[],
  basis: AuthorityBasis = 'calendar_period_signal',
): Reallocation[] {
  return assessReallocationPairs(entities, basis).flatMap((pair) => {
    if (pair.cut.tier === 'diagnostic_only' || pair.scale.tier === 'diagnostic_only') return []
    const loser = entities.find((e) => e.id === pair.fromId)
    const shift = round((loser?.dailyBudget ?? 0) * MAX_SHIFT_FRACTION)
    if (shift < 1) return []
    const authorityTier = pair.cut.tier === 'execution_eligible' && pair.scale.tier === 'execution_eligible'
      ? 'execution_eligible' as const : 'owner_review' as const
    return [{
      fromId: pair.fromId, fromName: pair.fromName, toId: pair.toId, toName: pair.toName,
      suggestedShiftDaily: shift,
      rationale: `${pair.cut.copy} ${pair.scale.copy}`,
      trust: pair.trust,
      meetsBar: pair.trust >= TRUST_BAR,
      approvalRequired: true as const,
      authorityTier,
    }]
  })
}
