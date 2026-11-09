import { PLAYBOOKS } from './playbooks'
import type { Playbook, PlaybookIntent } from './types'

export { PLAYBOOKS } from './playbooks'
export { CHAMPION_CONTEXT } from './types'
export type { Playbook, PlaybookIntent, PlaybookStep } from './types'

export function getPlaybook(intent: PlaybookIntent): Playbook | undefined {
  return PLAYBOOKS.find((p) => p.intent === intent)
}

/** One-line menu of available playbooks (returned when no intent is specified). */
export function playbookMenu(): { intent: PlaybookIntent; question: string }[] {
  return PLAYBOOKS.map((p) => ({ intent: p.intent, question: p.question }))
}

/**
 * Agent-readable rendering of one LEGACY playbook.
 *
 * The stored playbooks predate the ActionDecision and CampaignPlan boundaries. Their procedures,
 * decision rules and champion copy contain account-specific prescriptions, so exposing those fields
 * would create a second action-authority path around governed recommendations. Keep the underlying
 * records for audit/history, but expose only the evidence-tool map until the rules are rebuilt as
 * typed, account-scoped policy inputs.
 */
export function renderPlaybook(p: Playbook): string {
  const evidenceTools = [...new Set([
    ...p.required_evidence,
    ...p.procedure.flatMap((step) => step.tool ? [step.tool] : []),
  ])]
  const lines: string[] = []
  lines.push(`PLAYBOOK: ${p.intent}`)
  lines.push('')
  lines.push('STATUS: DIAGNOSTIC ONLY — this is a historical evidence map, not current action policy.')
  lines.push('ACTION GUIDANCE: WITHHELD. Read current governed recommendations before presenting any action.')
  lines.push('SETUP/CREATIVE GUIDANCE: WITHHELD until an approved, stored CampaignPlan is available.')
  lines.push('')
  lines.push('REQUIRED EVIDENCE TOOLS (outputs remain observations until governed separately):')
  for (const tool of evidenceTools) lines.push(`  • ${tool}`)
  lines.push('')
  lines.push('Historical procedures, decision rules, prohibitions and account benchmarks are intentionally withheld.')
  return lines.join('\n')
}

/**
 * Compatibility renderer for old callers. It deliberately contains no doctrine: daily/weekly report
 * prompts no longer consume this function, and any accidental future caller receives a fail-closed
 * diagnostic notice instead of legacy action rules.
 */
export function renderDoctrineDigest(intents: PlaybookIntent[]): string {
  const known = intents.filter((intent) => Boolean(getPlaybook(intent)))
  return [
    '## Legacy Playbook Notice — DIAGNOSTIC ONLY',
    'Historical playbook doctrine is withheld. It cannot originate, approve, or imply an action.',
    `Requested evidence maps: ${known.length > 0 ? known.join(', ') : 'none'}.`,
    'Use current governed recommendations for actions; setup and creative decisions additionally require an approved stored CampaignPlan.',
  ].join('\n')
}
