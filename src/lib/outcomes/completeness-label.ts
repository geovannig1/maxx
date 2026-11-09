import type { SourceCompleteness } from './source-health'

/**
 * PURE, client-safe. The owner-facing name of a source's completeness state. A reconciled source is
 * proven against its own system; a push-only source has no completeness proof, so its outcomes count as
 * they arrived: "As received" for a signed webhook, "As imported" for a CSV upload. The internal state
 * name `push_as_received` is never shown.
 */
export function sourceCompletenessLabel(completeness: SourceCompleteness, kind: string): string {
  if (completeness === 'reconciled') return 'Reconciled'
  return kind === 'csv' ? 'As imported' : 'As received'
}
