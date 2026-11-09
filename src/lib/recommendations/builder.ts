import { runGroundingGate, type GroundingInput } from './grounding-gate'
import { checkNoOscillation } from './no-oscillation'
import { REC_THRESHOLDS } from './thresholds'
import { getMetricStatus, getTargetLanguage, type MetricKey } from '@/lib/targets/target-ranges'
import {
  type Recommendation,
  type RecommendationType,
  type TargetEntityType,
  type EvidenceBasis,
  type MetricValue,
  type DataSource,
  type DateRange,
  type TargetEvaluationSummary,
} from './types'
import { formatMoney, formatMoneyAmount } from '@/lib/utils/format-currency'
import { outcomeWords } from '@/config/outcome-nouns'

// What this business calls its outcomes (NEXT_PUBLIC_OUTCOME_NOUN).
const OW = outcomeWords()

// buildRecommendation() is the ONLY sanctioned way to produce a Recommendation. It runs the grounding
// gate + no-oscillation check and fills all the safety fields from the result, so a recommendation can
// never claim more confidence than its evidence supports. If the gate blocks/holds an action, the
// recommendation_type is rewritten to 'hold' (or 'investigate') and action_allowed_now is forced false.

export interface BuildRecommendationInput {
  recommendation_type: RecommendationType
  target_entity_type: TargetEntityType
  target_entity_id?: string | null
  target_entity_name?: string | null
  observed_fact: string
  reason_for_action: string
  metric_values?: MetricValue[]
  date_range?: DateRange | null
  basis: EvidenceBasis

  // evidence for the gate
  spend: number
  bookings: number | null
  window_days: number
  data_age_hours?: number | null
  uses_meta_estimate_as_revenue?: boolean
  days_since_last_change?: number | null
  exited_learning?: boolean | null
  trend_stable?: boolean | null
  conflicting_signal?: boolean
  conflicting_signal_note?: string
  claims_per_campaign_roas?: boolean
  attributed_share?: number | null
  account_dormant?: boolean
  reversible?: boolean

  /** Primary metric to evaluate against its configurable target range. */
  primary_metric?: { metric: MetricKey; value: number | null }
  /** Extra "what could make this wrong" notes beyond what the gate derives. */
  extra_caveats?: string[]
  /** Days from now to re-check; defaults based on window. */
  next_check_in_days?: number
  /** NY "today" for next-check date math; pass nyToday() from callers. */
  today?: string

  /** This account's OWN track record for this play (adjuster only; passed straight to the gate). */
  track_record?: { wins: number; decisive: number; priorWinRate?: number; k?: number }
  /** Governed external knowledge (live expert_insights) that INSPIRED this — cited, never a fact source.
   *  Attaching it does NOT raise confidence; it adds citations + a "treat as a test" caveat. */
  external_knowledge?: { id: string; claim: string; source: string; confidence?: string | null }[]
}

// Plain-language upside/downside per action type (populates the honesty fields; read-only types get null).
const UPSIDE_DOWNSIDE: Partial<Record<RecommendationType, { up: string; down: string }>> = {
  scale: { up: 'May create more causal incremental contribution dollars if marginal contribution remains positive.', down: `Marginal contribution can turn negative even while ${OW.many}, CPA or platform ROAS look healthy.` },
  scale_proposal: { up: 'May create more causal incremental contribution dollars if marginal contribution remains positive.', down: `Marginal contribution can turn negative even while ${OW.many}, CPA or platform ROAS look healthy.` },
  reduce_budget: { up: 'May stop causally measured negative contribution from compounding.', down: 'May forgo incremental contribution if the measured loss is noise or no longer describes the current setup.' },
  pause: { up: 'Stops further spend on a unit with a causally measured, mature contribution loss.', down: 'May forgo incremental contribution if the loss is not durable or the setup changed.' },
  activate: { up: 'May restore causal incremental contribution from a currently inactive unit.', down: 'The prior contribution result may not transport to the reactivated setup or auction.' },
  refresh_creative: { up: 'May improve delivery quality and create a testable path to more contribution.', down: 'A new asset can weaken delivery; its financial effect remains unproven without a causal contribution comparison.' },
  change_optimization_event: { up: 'May give Meta a more reliable downstream delivery signal.', down: 'Can reset learning or optimize toward a proxy that does not create incremental contribution.' },
  change_audience: { up: 'May improve delivery to people more likely to create incremental contribution.', down: 'Can abandon useful reach and reset learning without proving a contribution gain.' },
  restructure: { up: 'May concentrate delivery signal and make a governed experiment easier to interpret.', down: 'Can disrupt delivery and erase comparability without proving a contribution gain.' },
}

function dataSourcesFrom(metrics: MetricValue[], basis: EvidenceBasis): DataSource[] {
  const set = new Set<DataSource>(metrics.map((m) => m.source))
  if (basis === 'external_best_practice') set.add('external_research')
  if (set.size === 0) set.add('assumption')
  return [...set]
}

function addDaysStr(today: string, n: number): string {
  const d = new Date(today + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

export function buildRecommendation(input: BuildRecommendationInput): Recommendation {
  const metric_values = input.metric_values ?? []
  const data_sources = dataSourcesFrom(metric_values, input.basis)

  const groundingInput: GroundingInput = {
    recommendation_type: input.recommendation_type,
    spend: input.spend,
    bookings: input.bookings,
    window_days: input.window_days,
    data_age_hours: input.data_age_hours ?? null,
    data_sources_count: data_sources.filter((s) => s !== 'assumption').length,
    uses_meta_estimate_as_revenue: input.uses_meta_estimate_as_revenue ?? false,
    days_since_last_change: input.days_since_last_change ?? null,
    exited_learning: input.exited_learning ?? null,
    trend_stable: input.trend_stable ?? null,
    conflicting_signal: input.conflicting_signal ?? false,
    conflicting_signal_note: input.conflicting_signal_note,
    basis: input.basis,
    claims_per_campaign_roas: input.claims_per_campaign_roas,
    attributed_share: input.attributed_share ?? null,
    account_dormant: input.account_dormant ?? false,
    reversible: input.reversible,
    track_record: input.track_record,
  }

  const grounding = runGroundingGate(groundingInput)
  const osc = checkNoOscillation({
    recommendation_type: input.recommendation_type,
    window_days: input.window_days,
    spend: input.spend,
    bookings: input.bookings,
    days_since_last_change: input.days_since_last_change ?? null,
    exited_learning: input.exited_learning ?? null,
    trend_stable: input.trend_stable ?? null,
    basis: input.basis,
  })

  // If the gate held/blocked an action, the surfaced type becomes 'hold' (or 'investigate' for a
  // non-action) so nothing downstream treats it as an actionable, confident call.
  let surfacedType = input.recommendation_type
  if (grounding.decision === 'hold') surfacedType = 'hold'
  else if (grounding.decision === 'block') surfacedType = 'investigate'

  const what_could_make_this_wrong: string[] = [
    ...grounding.reasons,
    ...(osc.is_reversal_class && !osc.allowed ? osc.blocking_factors : []),
    ...(input.extra_caveats ?? []),
  ]
  // External knowledge is INSPIRATION, never proof — attaching it adds a caveat, not confidence.
  if (input.external_knowledge?.length) {
    what_could_make_this_wrong.push("Informed by external best practice / expert signals (not this account's proven result) — treat those as test ideas, not proof.")
  }
  if (what_could_make_this_wrong.length === 0) {
    what_could_make_this_wrong.push('A larger sample or a fresher sync could change the picture; re-check on the date below.')
  }

  // Reading-only assistant: nothing is allowed to act live now. An action becomes "allowed" only when
  // it (a) passed the gate AND (b) would still require human approval + write mode downstream.
  const isActionType = surfacedType !== 'hold' && surfacedType !== 'investigate' && surfacedType !== 'keep' && surfacedType !== 'no_action'
  const approval_required = isActionType
  const action_allowed_now = false // a recommendation alone never grants execution authority

  const next_check_in_days = input.next_check_in_days ?? (input.window_days >= 7 ? 7 : 3)
  const recommended_next_check_date = input.today ? addDaysStr(input.today, next_check_in_days) : null

  // Range-aware evaluation of the primary metric vs its configurable target range.
  let target_evaluation: TargetEvaluationSummary | null = null
  if (input.primary_metric) {
    const ev = getMetricStatus(input.primary_metric.metric, input.primary_metric.value, {
      spend: input.spend,
      bookings: input.bookings ?? undefined,
      windowDays: input.window_days,
      attributionCoverage: input.attributed_share ?? null,
      dormant: input.account_dormant ?? false,
    })
    target_evaluation = {
      metric: ev.metric,
      value: ev.value,
      status: ev.status,
      band: ev.band,
      confidence: ev.confidence,
      language: getTargetLanguage(ev.metric, ev),
    }
  }

  const evidence_summary = metric_values.length
    ? metric_values.map((m) => `${m.name}=${m.value === null ? 'n/a' : (m.unit === '$' && typeof m.value === 'number' ? formatMoney(m.value) : typeof m.value === 'number' ? +m.value.toFixed(2) : m.value)}${m.unit && m.unit !== '$' ? m.unit : ''} (${m.source})`).join(', ')
    : `No metric values attached; basis=${input.basis}.`

  // ── Honesty fields — populated here so they travel WITH the recommendation ──
  const ud = UPSIDE_DOWNSIDE[surfacedType] ?? UPSIDE_DOWNSIDE[input.recommendation_type]
  const thin = grounding.confidence_label === 'low' || grounding.confidence_label === 'insufficient' || grounding.warnings.low_data !== null
  const minWindow = input.recommendation_type === 'scale' || input.recommendation_type === 'scale_proposal'
    ? REC_THRESHOLDS.MIN_WINDOW_DAYS_SCALE
    : REC_THRESHOLDS.MIN_WINDOW_DAYS_REVERSAL
  // NAME THE FLOOR THAT IS ACTUALLY SHORT, not all three.
  //
  // `thin` is an OR over three unrelated conditions, and this sentence then asserted that all three
  // floors were unmet. So "≥ $20 spend ... not met" could render directly beside "$1,342.80 spent"
  // -- the spend floor cleared FIFTY TIMES over -- on the primary "what should I do" surface: a fixed
  // string asserting conditions it never checked one by one. Every input needed to check them is
  // right here.
  const observedBookings = input.bookings
  const shortfalls = [
    input.spend < REC_THRESHOLDS.MIN_SPEND_TO_JUDGE
      ? `≥ ${formatMoneyAmount(REC_THRESHOLDS.MIN_SPEND_TO_JUDGE)} spend (only ${formatMoney(input.spend)} so far)` : null,
    observedBookings === null
      ? `≥ ${REC_THRESHOLDS.MIN_BOOKINGS_PERF_CLAIM} outcomes (outcomes are not being counted for this unit)`
      : observedBookings < REC_THRESHOLDS.MIN_BOOKINGS_PERF_CLAIM
        ? `≥ ${REC_THRESHOLDS.MIN_BOOKINGS_PERF_CLAIM} outcomes (only ${observedBookings} so far)` : null,
    input.window_days < minWindow
      ? `≥ ${minWindow} days (only ${input.window_days} so far)` : null,
  ].filter((line): line is string => line !== null)
  const stillRequired = 'Even when met, these are not decisive on their own: exact paid lineage, a '
    + 'definition that did not change mid-window, stated uncertainty, a like-for-like comparison and '
    + 'an approved campaign plan are all still required.'
  const minimum_data_needed = thin
    ? shortfalls.length > 0
      ? `Still needed: ${shortfalls.join('; ')}. ${stillRequired}`
      // Every floor cleared and confidence is still low, so say THAT rather than blaming the floors.
      // `confidence_label` is the LABEL, so falling back to it printed "confidence is low for another
      // reason (low)" -- a sentence that promises a reason and then restates the symptom.
      // `grounding.reasons` holds the actual cause (e.g. "Conflicting signal present.") and is in scope.
      : `The diagnostic floors are all met; confidence is low for another reason (${grounding.warnings.low_data ?? grounding.reasons[0] ?? `confidence label ${grounding.confidence_label}`}). ${stillRequired}`
    : null
  // Grounded Meta/ledger observations are still not a causal outcome contract. No current builder
  // input carries processor settlement, governed costs, treatment assignment and a declared future
  // causal-contribution metric together, so recommendations fail closed for commercial learning.
  const learning_eligibility = false
  const external_knowledge_used = input.external_knowledge?.length
    ? input.external_knowledge.map((k) => `${k.source}: ${k.claim}`)
    : null
  const prior_learning_used = input.track_record && input.track_record.decisive > 0
    ? `${input.track_record.wins}/${input.track_record.decisive} decisive wins for this play on this account (own track record)`
    : null

  return {
    recommendation_type: surfacedType,
    target_entity_type: input.target_entity_type,
    target_entity_id: input.target_entity_id ?? null,
    target_entity_name: input.target_entity_name ?? null,
    observed_fact: input.observed_fact,
    metric_values,
    date_range: input.date_range ?? null,
    data_sources,
    confidence_score: grounding.confidence_score,
    confidence_label: grounding.confidence_label,
    risk_level: grounding.risk_level,
    evidence_summary,
    reason_for_action: input.reason_for_action,
    what_could_make_this_wrong,
    approval_required,
    action_allowed_now,
    low_data_warning: grounding.warnings.low_data,
    estimate_warning: grounding.warnings.estimate,
    attribution_warning: grounding.warnings.attribution,
    no_oscillation_check: osc,
    recommended_next_check_date,
    target_evaluation,
    grounding,
    // ── Honesty fields ──
    attribution_confidence: input.attributed_share ?? null,
    external_knowledge_used,
    prior_learning_used,
    expected_upside: ud?.up ?? null,
    possible_downside: ud?.down ?? null,
    minimum_data_needed,
    learning_eligibility,
  }
}

/** Human/agent-readable rendering of a structured recommendation (for reports & MCP responses). */
export function formatRecommendation(r: Recommendation): string {
  const lines: string[] = []
  const target = r.target_entity_name ?? r.target_entity_id ?? r.target_entity_type
  lines.push(`[${r.recommendation_type.toUpperCase()}] ${target}`)
  lines.push(`  Observed: ${r.observed_fact}`)
  lines.push(`  Why: ${r.reason_for_action}`)
  lines.push(`  Evidence: ${r.evidence_summary}${r.date_range ? ` (${r.date_range.start}…${r.date_range.end})` : ''}`)
  if (r.target_evaluation) lines.push(`  Diagnostic reference: ${r.target_evaluation.language}`)
  lines.push(`  Confidence: ${r.confidence_label} (${r.confidence_score}) · Risk if wrong: ${r.risk_level}`)
  if (r.low_data_warning) lines.push(`  ⚠ LOW DATA: ${r.low_data_warning}`)
  if (r.estimate_warning) lines.push(`  ⚠ ESTIMATE: ${r.estimate_warning}`)
  if (r.attribution_warning) lines.push(`  ⚠ ATTRIBUTION: ${r.attribution_warning}`)
  if (r.no_oscillation_check.is_reversal_class && !r.no_oscillation_check.allowed) {
    lines.push(`  ⛔ NO-OSCILLATION: ${r.no_oscillation_check.blocking_factors.join(' ')}`)
  }
  lines.push(`  What could make this wrong: ${r.what_could_make_this_wrong.join(' ')}`)
  lines.push(`  Approval required: ${r.approval_required ? 'YES' : 'no'} · Action allowed now: ${r.action_allowed_now ? 'yes' : 'NO (read-only / write mode off)'}`)
  if (r.recommended_next_check_date) lines.push(`  Re-check on: ${r.recommended_next_check_date}`)
  return lines.join('\n')
}
