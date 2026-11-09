// Shared framing only. These strings NEVER classify text or grant authority; a surface must already
// carry an ActionDecision tier (or be structurally diagnostic) before rendering either label.

export type ProposalRisk = 'high' | 'medium' | 'low'

/** Header for a block of proposed, owner-applied actions. */
export const PROPOSED_ACTIONS_LABEL = 'Diagnostic context'

/** One-line read-only / approval note shown alongside any surfaced action. */
export const READ_ONLY_APPLY_NOTE =
  'Displayed text never executes a change. Only a current execution-eligible ActionDecision, paired owner approval, and write mode can reach Meta.'

/** Map an alert/flag severity to the envelope's risk word. No fabricated confidence — this only
 *  restates the severity the surface already has. */
export function severityToRisk(severity: string | null | undefined): ProposalRisk {
  if (severity === 'critical') return 'high'
  if (severity === 'warning') return 'medium'
  return 'low'
}
