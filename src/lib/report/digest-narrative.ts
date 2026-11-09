import type { DigestDescriptiveStates } from './daily-digest-signals'

export interface DeterministicDigestNarrative {
  text: string
  source: 'deterministic'
}

/**
 * The V3 narrative is a pure rendering of the three committed descriptive states. It does not
 * accept a model callback, a prompt, or free-form prose, so it cannot add facts, causal claims, or
 * action authority that are absent from the executive evidence snapshot.
 */
export function buildDeterministicDigestNarrative(
  states: DigestDescriptiveStates,
): DeterministicDigestNarrative {
  return {
    text: [states.business.line, states.paid_delivery.line, states.data_confidence.line].join(' '),
    source: 'deterministic',
  }
}
