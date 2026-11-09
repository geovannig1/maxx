import { assertsMoneyAuthority, clauseNegatesDirective } from './action-authority'
import { ACTION_DECISION_POLICY_FLOOR, resolveDisplayAuthority, type PersistedDecisionRef } from './legacy-cutover'

/** Alerts and audit tasks predate durable ActionDecision lineage. Their classification is structural:
 * diagnostic-only. Text may be retained in the database for audit, but no reader may infer authority
 * from it or render instruction-shaped legacy prose as a current recommendation. */
export const DIAGNOSTIC_ONLY_COPY =
  'DIAGNOSTIC ONLY — review the underlying measurements and current setup. This artifact has no governed ActionDecision and does not authorise a budget, delivery, targeting or creative change.'

const label = (value: unknown, fallback: string) => {
  const text = typeof value === 'string' ? value.trim().replace(/[_-]+/g, ' ') : ''
  return text || fallback
}

const ALERT_DIAGNOSTIC_CLASS: Record<string, string> = {
  spend_spike: 'delivery_signal',
  spend_drop: 'delivery_signal',
  budget_exhausted: 'delivery_signal',
  campaign_paused: 'delivery_signal',
  ctr_drop: 'auction_delivery_signal',
  cpm_spike: 'auction_delivery_signal',
  frequency_high: 'auction_delivery_signal',
  creative_fatigue: 'auction_delivery_signal',
  cpa_spike: 'modelled_outcome_signal',
  zero_leads: 'modelled_outcome_signal',
  champion_candidate: 'modelled_outcome_signal',
  wrong_optimization_event: 'configuration_observation',
  pixel_health: 'measurement_health_signal',
  data_drift: 'measurement_health_signal',
}

function alertDiagnosticClass(value: unknown): string {
  return ALERT_DIAGNOSTIC_CLASS[String(value ?? '')] ?? 'account_signal'
}

// LLM reports can invent structural instructions without using a budget verb. This is a rejection
// filter for UNTRUSTED narrative, not an authority inference mechanism: a match can only withhold text,
// never grant or raise a tier. False positives degrade to the deterministic report appendix.
// The verb is CAPTURED so the clause-anchored negation exemption (same contract as the money
// imperative matcher) can excuse "Do not switch the objective" while still catching "Switch the
// objective". Without it, sound analytical prose — "Never change the bid strategy", "Do not test
// a proxy event" — gets the whole answer withheld, which is what the q1/q4 eval failures showed.
const STRUCTURAL_DIRECTIVE = /(?:^|[.!?;:\n]\s*|[-*]\s+)(create|launch|switch|change|replace|refresh|duplicate|restructure|retarget|target|move|test)\b|\b(switch|change)\s+(?:the\s+)?(?:audience|objective|optimization event|bid strategy|targeting)\b/im

export function containsUngovernedActionLanguage(text: string): boolean {
  if (assertsMoneyAuthority(text)) return true
  const rx = new RegExp(STRUCTURAL_DIRECTIVE.source, 'gdim')
  for (let m = rx.exec(text); m; m = rx.exec(text)) {
    // Anchor on the captured verb, not the whole match: the match may begin with the clause
    // boundary itself, which would place the lookback in the PRECEDING clause.
    const idx = (m as RegExpExecArray & { indices?: Array<[number, number] | undefined> }).indices
    const verbAt = idx?.slice(1).find(Boolean)?.[0] ?? m.index
    if (clauseNegatesDirective(text, verbAt)) continue
    return true
  }
  return false
}

export const REPORT_DIAGNOSTIC_NOTICE =
  '> **Diagnostic narrative — no action authority.** This section explains observations only. ' +
  'Only the deterministic “Governed recommendations” section may present an owner-reviewed or ' +
  'execution-eligible change.'

export const CHAT_DIAGNOSTIC_NOTICE =
  'DIAGNOSTIC CHAT — this answer explains governed account observations; it does not authorise a budget, targeting, delivery, creative or campaign change. Maxx can draft copy, plans and change proposals, but only you approve a change, on the Changes page.'

/** LLM output is never an authority source. Unsafe output is discarded before persistence; safe output
 * remains explicitly diagnostic and is followed by a deterministic ActionDecision appendix. */
export function projectGeneratedReportNarrative(markdown: string): string {
  const text = markdown.trim()
  if (!text) return `${REPORT_DIAGNOSTIC_NOTICE}\n\n_Narrative unavailable._`
  if (containsUngovernedActionLanguage(text)) {
    return `${REPORT_DIAGNOSTIC_NOTICE}\n\n_Narrative withheld because it emitted action-shaped language outside the governed decision pipeline._`
  }
  return `${REPORT_DIAGNOSTIC_NOTICE}\n\n${text}`
}

/** The chat model sees tool output, including untrusted external observations. Prompt wording is not
 * a security boundary, so action-shaped model output is withheld deterministically. */
export function projectMaxxChatNarrative(markdown: string): string {
  const text = markdown.trim()
  if (!text) return `${CHAT_DIAGNOSTIC_NOTICE}\n\nI do not have enough governed account data to answer that yet.`
  if (containsUngovernedActionLanguage(text)) {
    return `${CHAT_DIAGNOSTIC_NOTICE}\n\nI withheld the generated answer because it contained action-shaped language without a current governed ActionDecision.`
  }
  return `${CHAT_DIAGNOSTIC_NOTICE}\n\n${text}`
}

function reportPolicyVersion(value: unknown): number | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const n = (value as Record<string, unknown>).action_authority_policy_version
  return typeof n === 'number' && Number.isInteger(n) ? n : null
}

export const CURRENT_REPORT_MONEY_BASIS_VERSION = 1

function reportMoneyBasisVersion(row: Record<string, unknown>): number | null {
  const n = row.money_basis_version
  return typeof n === 'number' && Number.isInteger(n) ? n : null
}

/** Existing reports predate durable authority lineage. They are diagnostic by structure and their LLM
 * prose is not replayed as current advice. New reports prove the projection path in report_json. */
export function projectStoredReport<T extends Record<string, unknown>>(row: T): T {
  const version = reportPolicyVersion(row.report_json)
  const actionAuthorityCurrent = version !== null && version >= ACTION_DECISION_POLICY_FLOOR
  const moneyBasisCurrent = reportMoneyBasisVersion(row) === CURRENT_REPORT_MONEY_BASIS_VERSION
  if (actionAuthorityCurrent && moneyBasisCurrent) return row
  return {
    ...row,
    // Old prose can contain obsolete booked-value/revenue/ROAS language even when its action-policy
    // stamp is current. KPIs remain available to explicitly labelled legacy renderers, but prose is
    // removed rather than replayed under a new money meaning.
    summary_text: null,
    full_report_md: null,
    narrative_withheld_reason: moneyBasisCurrent ? 'legacy_action_authority' : 'legacy_money_basis',
  } as T
}

export function projectDiagnosticAlert<T extends Record<string, unknown>>(row: T): T & {
  action_authority_tier: 'diagnostic_only'
} {
  const diagnosticClass = alertDiagnosticClass(row.alert_type)
  return {
    ...row,
    alert_type: diagnosticClass,
    title: `Diagnostic alert: ${label(diagnosticClass, 'account signal')}`,
    message: `${DIAGNOSTIC_ONLY_COPY} Legacy detector prose is withheld; inspect the named metric, baseline, source and current setup before drawing a conclusion.`,
    recommended_actions: null,
    why_it_matters: null,
    amount_at_risk: null,
    action_label: null,
    action_url: null,
    action_authority_tier: 'diagnostic_only',
  }
}

export function projectDiagnosticTask<T extends Record<string, unknown>>(row: T): Omit<T, 'title' | 'description' | 'recommendation'> & {
  title: string
  description: string
  recommendation: string
  action_authority_tier: 'diagnostic_only'
  action_authority_legacy: true
} {
  const { title: _title, description: _description, recommendation: _recommendation, ...auditFields } = row
  void _title
  void _description
  void _recommendation
  return {
    ...auditFields,
    title: 'Review legacy diagnostic task',
    description: DIAGNOSTIC_ONLY_COPY,
    recommendation: DIAGNOSTIC_ONLY_COPY,
    action_authority_tier: 'diagnostic_only',
    action_authority_legacy: true,
  }
}

function embeddedDecision(value: unknown): PersistedDecisionRef | null {
  const candidate = Array.isArray(value) ? value[0] : value
  if (!candidate || typeof candidate !== 'object') return null
  const row = candidate as Record<string, unknown>
  if (!['execution_eligible', 'owner_review', 'diagnostic_only'].includes(String(row.authority_tier))) return null
  return {
    authority_tier: row.authority_tier as PersistedDecisionRef['authority_tier'],
    policy_version: typeof row.policy_version === 'number' ? row.policy_version : null,
    authority_reason: typeof row.authority_reason === 'string' ? row.authority_reason : null,
    owner_copy: typeof row.owner_copy === 'string' ? row.owner_copy : null,
  }
}

/** Audit tasks are actionable only when their row carries a joined, current-policy ActionDecision.
 * Legacy/manual/LLM tasks remain visible as history but resolve diagnostic by structure. */
export function projectTaskSurface<T extends Record<string, unknown>>(row: T) {
  const decision = embeddedDecision(row.action_decision)
  if (!decision) return projectDiagnosticTask(row)
  const resolved = resolveDisplayAuthority(decision, row.recommendation as string | null)
  return {
    ...row,
    recommendation: resolved.copy,
    action_authority_tier: resolved.tier,
    action_authority_legacy: resolved.legacy,
    action_authority_prose_warning: resolved.prosePhraseWarning,
  }
}

/** Only current-policy tasks with an explicit ActionDecision may appear in live task surfaces.
 * Historical, stale-policy and diagnostic-only tasks remain audit records; they are not current work. */
export function projectCurrentActionableTasks<T extends Record<string, unknown>>(rows: T[]) {
  return rows
    .map((row) => projectTaskSurface(row))
    .filter((task) => task.action_authority_legacy === false
      && (task.action_authority_tier === 'owner_review' || task.action_authority_tier === 'execution_eligible'))
}

/** Flags have no ActionDecision writer. Their historical action/watch prose is therefore diagnostic,
 * regardless of wording, across every API, page, and MCP reader. */
export function projectFlagSurface<T extends Record<string, unknown>>(row: T) {
  const action = resolveDisplayAuthority(null, row.recommended_action as string | null)
  const watch = resolveDisplayAuthority(null, row.watch_next as string | null)
  return {
    ...row,
    recommended_action: action.copy,
    watch_next: watch.copy,
    action_authority_tier: 'diagnostic_only_legacy' as const,
    ...(action.prosePhraseWarning || watch.prosePhraseWarning
      ? { action_authority_prose_warning: true as const }
      : {}),
  }
}
