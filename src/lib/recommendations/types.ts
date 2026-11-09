// The structured Recommendation object. Every recommendation Maxx surfaces — in the daily/weekly
// report, the dashboard, or an MCP response — should be expressible as one of these so confidence,
// risk, evidence, and the safety warnings travel WITH the recommendation and can be enforced in code
// (see grounding-gate.ts), not just asked for in a prompt.

export type RecommendationType =
  | 'scale' // candidate increase; causal contribution authority is resolved separately
  | 'reduce_budget'
  | 'pause'
  | 'activate'
  | 'refresh_creative'
  | 'change_optimization_event' // e.g. AppointmentConfirmed ↔ LPV — the classic over-correction
  | 'change_audience'
  | 'restructure' // merge/split ad sets, change objective, CBO↔ABO
  | 'launch_test' // a TEST hypothesis, not a performance claim
  | 'keep' // explicit "leave it running, do not touch"
  | 'investigate' // dig in, not yet an action
  | 'hold' // not enough to act — gate downgraded an action to this
  | 'no_action'
  // Diagnostic / lifecycle taxonomy. Additive. Most are read/test/watch types (NOT
  // reversal-class); only the money-moving `scale_proposal` joins REVERSAL_CLASS below.
  | 'launch_setup' // how to set up a new campaign/launch
  | 'audience_test' // a proposed audience experiment (test basis)
  | 'creative_test' // a proposed creative experiment (test basis)
  | 'budget_watch' // watch budget/pacing — not an action yet
  | 'scale_proposal' // a proposal to scale (reversal-class; still approval-gated)
  | 'pause_watch' // watch for pause candidacy — not an action yet
  | 'funnel_diagnosis' // diagnose where the funnel is leaking
  | 'attribution_issue' // a first-class attribution problem (was only a warning string)
  | 'tracking_issue' // a first-class pixel/tracking problem
  | 'low_data_guidance' // what to do while data is thin
  | 'weekly_strategy' // the weekly strategic read
  | 'do_not_touch' // explicit "leave it — changing now would be premature" (≈ keep)

/** Reversal-class types: reversing/flipping/scaling/pausing/restructuring. Subject to no-oscillation. */
export const REVERSAL_CLASS: ReadonlySet<RecommendationType> = new Set<RecommendationType>([
  'scale',
  'reduce_budget',
  'pause',
  'activate',
  'change_optimization_event',
  'change_audience',
  'restructure',
  'scale_proposal', // money-moving proposal — gated like `scale`
])

export type TargetEntityType =
  | 'account'
  | 'campaign'
  | 'adset'
  | 'ad'
  | 'audience'
  | 'creative'
  | 'none'

export type RiskLevel = 'low' | 'medium' | 'high'

/** Where the recommendation's justification actually comes from. Drives whether it can be "confident". */
export type EvidenceBasis =
  | 'observed_performance' // this account's own measured results
  | 'external_best_practice' // platform guidance / expert consensus
  | 'test_hypothesis' // an untested idea framed as an experiment

export type ConfidenceLabel = 'high' | 'medium' | 'low' | 'insufficient'

export type DataSource =
  | 'meta_api'
  | 'ga4'
  | 'supabase'
  | 'flag_engine'
  | 'learned_pattern'
  | 'external_research'
  | 'competitor'
  | 'assumption'

export interface MetricValue {
  name: string
  value: number | null
  source: DataSource
  unit?: string // '$' | '%' | 'x' | 'count' …
}

export interface DateRange {
  start: string // YYYY-MM-DD (NY)
  end: string
}

/** Result of the no-oscillation check (also embedded in every Recommendation). */
export interface NoOscillationResult {
  is_reversal_class: boolean
  allowed: boolean
  reason: string
  blocking_factors: string[]
}

/** One of the 10 grounding-gate questions, evaluated. */
export interface GroundingCheck {
  id: number
  question: string
  status: 'pass' | 'fail' | 'na'
  note: string
}

export interface GroundingResult {
  passed: boolean // false ⇒ must NOT be shown as a confident, actionable recommendation
  decision: 'allow' | 'downgrade_to_hypothesis' | 'hold' | 'block'
  confidence_score: number // 0..1, already capped by any failed checks
  confidence_label: ConfidenceLabel
  risk_level: RiskLevel
  checks: GroundingCheck[]
  reasons: string[] // human-readable why it was downgraded/blocked
  warnings: {
    low_data: string | null
    estimate: string | null
    attribution: string | null
  }
}

/** Range-aware evaluation of the recommendation's primary metric (dynamic target ranges). */
export interface TargetEvaluationSummary {
  metric: string
  value: number | null
  status: 'excellent' | 'healthy' | 'watch' | 'critical' | 'needs_data' | 'estimate_only' | 'no_target' | 'unknown'
  band: string | null
  confidence: 'high' | 'medium' | 'low'
  language: string // human, range-aware sentence ("CPA $71.20 is in the watch range — not a failure …")
}

/** The canonical structured recommendation. Field names match the sprint spec exactly. */
export interface Recommendation {
  recommendation_type: RecommendationType
  target_entity_type: TargetEntityType
  target_entity_id: string | null
  target_entity_name: string | null
  observed_fact: string
  metric_values: MetricValue[]
  date_range: DateRange | null
  data_sources: DataSource[]
  confidence_score: number // 0..1
  confidence_label: ConfidenceLabel
  risk_level: RiskLevel
  evidence_summary: string
  reason_for_action: string
  what_could_make_this_wrong: string[]
  approval_required: boolean
  action_allowed_now: boolean // false until a human approves AND write mode is on (or it's a read-only suggestion)
  low_data_warning: string | null
  estimate_warning: string | null
  attribution_warning: string | null
  no_oscillation_check: NoOscillationResult
  recommended_next_check_date: string | null
  // Range-aware status of the primary metric vs its configurable target range (null if none attached).
  target_evaluation: TargetEvaluationSummary | null
  // Gate metadata kept on the object so the dashboard/report can show *why* it was downgraded.
  grounding: GroundingResult
  // ── Additive fields (optional so existing producers compile; populated as producers adopt them) ──
  /** 0..1 GA4 attribution coverage behind any per-entity revenue/ROAS claim (null = unknown). */
  attribution_confidence?: number | null
  /** Citations for any external best-practice/test knowledge that INSPIRED this (never a fact source). */
  external_knowledge_used?: string[] | null
  /** Reference to the prior learned outcome/pattern that informed this (adjuster, not driver). */
  prior_learning_used?: string | null
  /** Plain-language expected upside if the recommendation is right. */
  expected_upside?: string | null
  /** Plain-language downside if it's wrong (complements risk_level). */
  possible_downside?: string | null
  /** Explicit "need X more (spend/bookings/days) before this is decisive". */
  minimum_data_needed?: string | null
  /** True only when the intervention has a governed causal incremental-contribution outcome contract. */
  learning_eligibility?: boolean
  /** Immutable IDs of atomized MetricClaim snapshots. Empty means the recommendation is quarantined. */
  metric_claim_ids?: string[]
}
