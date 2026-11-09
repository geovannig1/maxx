/**
 * The governance guard's own refusals for an owner recommendation transition. Each message is authored
 * by `commit_recommendation_owner_transition` (RAISE EXCEPTION in the baseline migration) and is safe to
 * show the owner verbatim; tests/db/owner-transition-denials-db.test.ts keeps this list equal to the
 * shipped function. Every other error text is a database detail and stays server-side.
 */

export const OWNER_TRANSITION_RPC = 'commit_recommendation_owner_transition'

export const OWNER_TRANSITION_DENIALS: readonly string[] = [
  'invalid recommendation owner transition',
  'recommendation is missing or cross-account',
  'recommendation owner transition does not match its immutable recommendation',
  'immutable MetricClaim lineage is required for this owner transition',
  'governed ActionDecision is required for this owner transition',
  'diagnostic recommendation cannot be marked acted on',
]

const DENIALS = new Set(OWNER_TRANSITION_DENIALS)
const WRAPPER_PREFIX = `${OWNER_TRANSITION_RPC}: `

/**
 * The guard message this error carries, or null. A match is exact equality with one listed message,
 * after removing the one wrapper prefix the store adds: a database error that merely contains a guard
 * phrase, adds text around it, or arrives under another wrapper is not a guard refusal.
 */
export function ownerTransitionDenial(error: unknown): string | null {
  if (!(error instanceof Error)) return null
  const message = error.message.startsWith(WRAPPER_PREFIX) ? error.message.slice(WRAPPER_PREFIX.length) : error.message
  return DENIALS.has(message) ? message : null
}
