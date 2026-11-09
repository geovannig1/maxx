// APPLICABLE CAUSAL EVIDENCE — scoped to the thing being decided.
//
// `hasCompletedExperiment()` asked the account a single question — "is there ANY
// completed experiment with outcome=success?" — and used the answer as causal evidence for every
// recommendation. So a successful CREATIVE test unlocked an unrelated BUDGET move on a different ad
// set, which is the opposite of what a controlled test establishes. An experiment result is evidence
// about the entity it ran on and the variable it changed. Nothing else.

export interface ExperimentRecord {
  id: string
  status: string
  outcome: string | null
  /** EXACT identity (`experiments.entity_level`/`entity_ref`). Null on legacy rows written without it — correctly unmatchable. */
  entity_level: string | null
  entity_ref: string | null
  changed_variable: string
  control_ref: string
  challenger_ref: string
  started_at: string | null
  ended_at: string | null
  owner_decision: string | null
  owner_decided_at: string | null
  result_provenance: Record<string, unknown> | null
}

export type CausalRejection =
  | 'not_complete'
  | 'not_successful'
  | 'unrelated_entity'
  | 'unrelated_variable'
  | 'missing_provenance'
  | 'stale_result'
  | 'no_owner_disposition'

export interface CausalMatch {
  experimentId: string
  changedVariable: string
}

export interface CausalEvidenceResult {
  /** Experiments that match the entity AND the variable AND are fresh AND carry provenance. */
  applicable: CausalMatch[]
  /** Why each considered experiment was rejected — surfaced, never silently dropped. */
  rejections: Array<{ experimentId: string; reason: CausalRejection; detail: string }>
  /**
   * Whether an applicable result may UNLOCK a direct action.
   *
   * Currently ALWAYS false. The repo has no governed owner-approval vocabulary: `owner_decision` is a
   * free-text column with no enum or CHECK constraint, so no value in it can be recognised as an
   * approval rather than a note. Inventing one here would manufacture authority that the schema does
   * not grant. Until a governed value exists, a completed experiment is recorded, reported and
   * scoped — but it does not by itself authorise a money move.
   */
  unlocksDirectAction: false
  /** Stated on every result so the limitation is visible wherever the evidence is read. */
  unlockBlockedReason: string
}

export const UNLOCK_BLOCKED_REASON =
  'a completed experiment is recorded and scoped, but cannot unlock a direct action: the repo has no ' +
  'governed owner-approval vocabulary (experiments.owner_decision is free text with no enum or CHECK ' +
  'constraint), so no stored value can be recognised as an approval rather than a note'

/** A result older than this is not evidence about current delivery. */
export const CAUSAL_RESULT_MAX_AGE_DAYS = 90

/** The changed_variable a recommendation kind is about. Mirrors the conflict mapping. */
export function variableForKind(kind: 'budget' | 'scale' | 'pause' | 'refresh'): string {
  if (kind === 'budget' || kind === 'scale') return 'daily_budget'
  if (kind === 'refresh') return 'creative'
  return 'status'
}

/**
 * PURE: which completed experiments actually bear on THIS decision.
 *
 * `entityRefs` are the identifiers that would appear in an experiment's control/challenger reference
 * for the unit being decided (entity key, meta id, name). A match on ANY of them ties the result to
 * the entity; no match means the result is about something else.
 */
export function applicableCausalEvidence(
  experiments: ExperimentRecord[],
  ctx: {
    entityRefs: string[]
    /** The LEVEL being decided. Identity is the (level, ref) PAIR — a ref alone is half an identity. */
    entityLevel: 'campaign' | 'adset' | 'ad'
    kind: 'budget' | 'scale' | 'pause' | 'refresh'
    nowMs: number
  },
): CausalEvidenceResult {
  const wantVariable = variableForKind(ctx.kind)
  // EXACT identity PAIR. Substring-searching the free-text refs was the original defect; comparing
  // entity_ref alone was the second one — the schema defines identity as level+ref, so a campaign
  // result could be accepted for an ad set that happened to share the reference.
  const refs = new Set(ctx.entityRefs.map((r) => r.trim()).filter((r) => r !== ''))
  const applicable: CausalMatch[] = []
  const rejections: CausalEvidenceResult['rejections'] = []

  for (const e of experiments) {
    if (e.status !== 'complete') {
      rejections.push({ experimentId: e.id, reason: 'not_complete', detail: `status ${e.status}` })
      continue
    }
    if (e.outcome !== 'success') {
      rejections.push({ experimentId: e.id, reason: 'not_successful', detail: `outcome ${e.outcome ?? 'null'}` })
      continue
    }
    if (e.changed_variable !== wantVariable) {
      // A creative test says nothing about a budget move.
      rejections.push({
        experimentId: e.id, reason: 'unrelated_variable',
        detail: `changed "${e.changed_variable}", this decision changes "${wantVariable}"`,
      })
      continue
    }
    if (refs.size === 0) {
      rejections.push({ experimentId: e.id, reason: 'unrelated_entity', detail: 'the decision supplied no entity reference to match against' })
      continue
    }
    if (e.entity_ref === null) {
      // Legacy row with no first-class identity. Unmatchable by construction, and guessing from
      // prose is exactly what produced the defect.
      rejections.push({ experimentId: e.id, reason: 'unrelated_entity', detail: 'the experiment records no first-class entity identity (legacy row) — it cannot be matched to any unit' })
      continue
    }
    if (!refs.has(e.entity_ref) || e.entity_level !== ctx.entityLevel) {
      rejections.push({
        experimentId: e.id, reason: 'unrelated_entity',
        detail: `ran on ${e.entity_level ?? 'unknown'} ${e.entity_ref}, this decision is at ${ctx.entityLevel} level — identity is the (level, ref) PAIR`,
      })
      continue
    }
    // Provenance is what makes a result re-derivable. Without it the number cannot be trusted.
    const prov = e.result_provenance
    if (!prov || typeof prov !== 'object' || Object.keys(prov).length === 0) {
      rejections.push({ experimentId: e.id, reason: 'missing_provenance', detail: 'no result_provenance recorded' })
      continue
    }
    const endedMs = e.ended_at ? Date.parse(e.ended_at) : NaN
    if (!Number.isFinite(endedMs)) {
      rejections.push({ experimentId: e.id, reason: 'stale_result', detail: 'no usable end time — age unknown, treated as stale' })
      continue
    }
    if (ctx.nowMs - endedMs > CAUSAL_RESULT_MAX_AGE_DAYS * 86_400_000) {
      rejections.push({
        experimentId: e.id, reason: 'stale_result',
        detail: `ended ${Math.round((ctx.nowMs - endedMs) / 86_400_000)} days ago (> ${CAUSAL_RESULT_MAX_AGE_DAYS})`,
      })
      continue
    }
    // Matched. Owner disposition is recorded for visibility, but cannot unlock (see above).
    if (!e.owner_decision) {
      rejections.push({ experimentId: e.id, reason: 'no_owner_disposition', detail: 'no owner decision recorded on the result' })
    }
    applicable.push({ experimentId: e.id, changedVariable: e.changed_variable })
  }

  return { applicable, rejections, unlocksDirectAction: false, unlockBlockedReason: UNLOCK_BLOCKED_REASON }
}

/**
 * PURE: RUNNING experiments that conflict with this decision — scoped by entity AND variable.
 * A running creative test on ad set A must not block a budget decision on ad set B.
 */
export function applicableConflicts(
  experiments: ExperimentRecord[],
  ctx: { entityRefs: string[]; entityLevel: 'campaign' | 'adset' | 'ad'; kind: 'budget' | 'scale' | 'pause' | 'refresh' },
): string[] {
  const wantVariable = variableForKind(ctx.kind)
  const refs = new Set(ctx.entityRefs.map((r) => r.trim()).filter((r) => r !== ''))
  return experiments
    .filter((e) => e.status === 'running' && e.changed_variable === wantVariable)
    .filter((e) => {
      // FAIL CLOSED on an unresolvable overlap: no entity reference on either side means we cannot
      // prove the tests are about different things, so they are treated as conflicting.
      if (refs.size === 0 || e.entity_ref === null || e.entity_level === null) return true
      // Both halves must match, or a campaign test would falsely block an ad-set decision.
      return refs.has(e.entity_ref) && e.entity_level === ctx.entityLevel
    })
    .map((e) => e.id)
}
