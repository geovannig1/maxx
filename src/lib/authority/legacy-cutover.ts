import { assertsMoneyAuthority } from './action-authority'

/**
 * STRUCTURAL LEGACY CUTOVER.
 *
 * Finding 4 was only half fixed. The phrase detector's negation bypass was
 * repaired, but LIVE READERS were still calling `assertsMoneyAuthority()` to decide whether stored
 * prose was safe to surface. That is inference about English, and inference about English is exactly
 * what must not gate authority — the policy-version cutover existed only in the (then inert)
 * `action_decisions` schema.
 *
 * The rule here is structural and needs no reading comprehension:
 *
 *   A source artifact with NO ActionDecision, or a decision BELOW the policy floor, is
 *   diagnostic-only — regardless of what its text says.
 *
 * The phrase detector survives ONLY as defence-in-depth: it can raise a warning flag on a row that
 * already resolved to diagnostic, so a surprising string still gets noticed. It can never promote a
 * row, and it is never consulted to decide that a row is safe.
 */

/** Must match `action_decision_policy_floor()` in the baseline schema. Policy v5 cuts over persisted
 * paid-cohort ActionDecision evidence to the current paid-cohort generation policy; v4 artifacts are
 * preserved as audit history but are diagnostic-only. */
export const ACTION_DECISION_POLICY_FLOOR = 5

/** The subset of a persisted decision a display surface needs. */
export interface PersistedDecisionRef {
  authority_tier: 'execution_eligible' | 'owner_review' | 'diagnostic_only'
  policy_version: number | null
  authority_reason?: string | null
  owner_copy?: string | null
}

export interface DisplayAuthority {
  tier: 'execution_eligible' | 'owner_review' | 'diagnostic_only'
  /** True when this row predates the structured policy and was resolved by STRUCTURE, not wording. */
  legacy: boolean
  /** Owner-facing text. For legacy rows this NEVER contains the stored prose as an instruction. */
  copy: string
  /** Defence-in-depth only: the stored prose reads like an instruction. Never affects `tier`. */
  prosePhraseWarning: boolean
  /** The original text, preserved verbatim for audit. Never rendered as actionable copy. */
  legacyRawForAudit?: string
}

const LEGACY_NOTICE =
  'HISTORICAL — DIAGNOSTIC ONLY. This was recorded before the action-authority policy existed, so no '
  + 'evidence, direction or tier was ever established for it. It is shown for history and must not be '
  + 'acted on. Its original wording is retained for audit only.'

/**
 * Resolve what a display surface may say about a source artifact.
 *
 * `decision` is the ActionDecision joined for this artifact, or `null` when none exists. The stored
 * prose is accepted only so it can be preserved and (optionally) warned about — it is NEVER read to
 * decide the tier.
 */
export function resolveDisplayAuthority(
  decision: PersistedDecisionRef | null | undefined,
  storedProse: string | null | undefined,
): DisplayAuthority {
  const raw = typeof storedProse === 'string' ? storedProse : ''
  // Computed for observability only. Deliberately AFTER the structural decision below in importance:
  // nothing about this value can raise a tier.
  const prosePhraseWarning = raw.length > 0 && assertsMoneyAuthority(raw)

  // STRUCTURE decides. No decision, or a decision from an older policy generation, is legacy.
  if (!decision || decision.policy_version == null
      || decision.policy_version < ACTION_DECISION_POLICY_FLOOR) {
    return {
      tier: 'diagnostic_only',
      legacy: true,
      copy: LEGACY_NOTICE,
      prosePhraseWarning,
      ...(raw ? { legacyRawForAudit: raw } : {}),
    }
  }

  return {
    tier: decision.authority_tier,
    legacy: false,
    copy: decision.owner_copy ?? decision.authority_reason ?? '',
    prosePhraseWarning,
  }
}
