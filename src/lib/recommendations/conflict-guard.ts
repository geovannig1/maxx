// Conflict & revision guard (Ad Decision Ledger).
//
// Detects when a NEW setting decision contradicts a PREVIOUSLY RECORDED one for the same setting, so Maxx
// surfaces the switch instead of silently replacing it. This is NOT the no-oscillation gate: no-oscillation
// asks "is there enough evidence to reverse this reversal-class rec in this pass?"; the conflict guard asks
// "does this decision contradict what we already recorded for this exact setting?". They compose.
//
// Pure + deterministic (no I/O). Comparison is SEMANTIC, not string-equality, so "1d click" == "1-day click"
// and "LPV" == "landing page views".

/** Settings where a switch resets the learning phase / attribution basis — always high-stakes. */
const HIGH_STAKES_CATEGORIES: ReadonlySet<string> = new Set([
  'optimization_event',
  'conversion_event',
  'attribution_window',
  'evaluation_window',
])

/** Collapse an attribution/evaluation window value to a canonical token set, e.g. "7-day click / 1-day view"
 *  → "1d_view,7d_click". Handles "7-day", "7d", "1 day click". */
function normalizeWindow(value: string): string {
  const tokens: string[] = []
  const re = /(\d+)\s*-?\s*(?:day|d)\b\s*(clicks?|views?)?/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(value.toLowerCase())) !== null) {
    const n = m[1]
    const kind = m[2] ? (m[2].startsWith('click') ? '_click' : '_view') : ''
    tokens.push(`${n}d${kind}`)
  }
  if (tokens.length === 0) return generic(value)
  return [...new Set(tokens)].sort().join(',')
}

/** Map an optimization/conversion event value to a canonical event id. */
function normalizeEvent(value: string): string {
  const v = value.toLowerCase()
  if (/appointment|appt|booking|book\b/.test(v)) return 'appointment_confirmed'
  if (/landing\s*page\s*view|lpv|page\s*view/.test(v)) return 'landing_page_view'
  if (/purchase/.test(v)) return 'purchase'
  if (/add\s*to\s*cart|atc/.test(v)) return 'add_to_cart'
  if (/\blead/.test(v)) return 'lead'
  if (/view\s*content|vc\b/.test(v)) return 'view_content'
  return generic(value)
}

function generic(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').replace(/[.\s]+$/g, '').trim()
}

/** Category-aware normalization so synonyms compare equal. */
export function normalizeSettingValue(settingCategory: string, value: string | null | undefined): string {
  if (value == null) return ''
  if (settingCategory === 'attribution_window' || settingCategory === 'evaluation_window') return normalizeWindow(value)
  if (settingCategory === 'optimization_event' || settingCategory === 'conversion_event') return normalizeEvent(value)
  return generic(value)
}

export interface PriorSettingDecision {
  setting_category: string
  final_value: string | null
}

export interface ProposedSettingDecision {
  setting_category: string
  proposed_value: string | null
}

export interface ConflictAssessment {
  conflicts: boolean
  setting_category: string
  prior_value: string | null
  new_value: string | null
  change_summary: string | null // "1-day → 7-day" (raw values, human-readable)
  requires_approval: boolean // a conflicting switch is NEVER silent
  is_high_stakes: boolean // switching resets learning / attribution basis
}

/** Does the proposed value contradict the prior recorded value for this setting? */
export function evaluateConflict(prior: PriorSettingDecision, proposed: ProposedSettingDecision): ConflictAssessment {
  const category = proposed.setting_category
  const isHighStakes = HIGH_STAKES_CATEGORIES.has(category)
  const priorNorm = normalizeSettingValue(category, prior.final_value)
  const newNorm = normalizeSettingValue(category, proposed.proposed_value)

  // No prior value recorded ⇒ nothing to conflict with (first-time setup is not a conflict).
  const conflicts = priorNorm !== '' && newNorm !== '' && priorNorm !== newNorm

  return {
    conflicts,
    setting_category: category,
    prior_value: prior.final_value ?? null,
    new_value: proposed.proposed_value ?? null,
    change_summary: conflicts ? `${prior.final_value} → ${proposed.proposed_value}` : null,
    requires_approval: conflicts, // never silently replace a prior decision
    is_high_stakes: conflicts && isHighStakes,
  }
}

export interface RevisionRationale {
  why_better?: string | null
  risk_of_switching?: string | null
  risk_of_not_switching?: string | null
  deprecate_prior?: boolean
  prior_decision_id?: string | null
}

export interface RevisionGuidance {
  conflicts_with_prior: boolean
  prior_decision_id: string | null
  change_summary: string | null
  why_changed: string | null
  prior_deprecated: boolean // only true once the human approves the switch
  switch_risk: string | null
  risk_of_not_switching: string | null
  approval_required: boolean
  is_high_stakes: boolean
}

/** Structure what Maxx must SHOW for a conflicting revision. The guard flags/structures the switch; the
 *  why-it's-better text comes from the caller — it never fabricates a justification. `prior_deprecated`
 *  stays false until a human approves (nothing auto-flips). */
export function buildRevisionGuidance(
  assessment: ConflictAssessment,
  rationale: RevisionRationale = {}
): RevisionGuidance {
  return {
    conflicts_with_prior: assessment.conflicts,
    prior_decision_id: rationale.prior_decision_id ?? null,
    change_summary: assessment.change_summary,
    why_changed: rationale.why_better ?? null,
    prior_deprecated: assessment.conflicts ? rationale.deprecate_prior === true : false,
    switch_risk: rationale.risk_of_switching ?? null,
    risk_of_not_switching: rationale.risk_of_not_switching ?? null,
    approval_required: assessment.requires_approval,
    is_high_stakes: assessment.is_high_stakes,
  }
}
