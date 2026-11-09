import type { RecommendationEvidenceItem } from '@/lib/cockpit/contracts'
import { formatMoney } from '@/lib/utils/format-currency'

export const DECISION_QUEUE_VIEWS = [
  'needs_review',
  'tracking_repair',
  'monitoring',
  'awaiting_implementation',
  'outcome_review',
  'snoozed',
] as const

export type DecisionQueueView = typeof DECISION_QUEUE_VIEWS[number]
export const UNRESOLVED_CRITICAL_ALERT_FILTER = 'unresolved_critical_alerts' as const
export type DecisionQueueFilter = typeof UNRESOLVED_CRITICAL_ALERT_FILTER

export function isDecisionQueueFilter(value: string | undefined): value is DecisionQueueFilter {
  return value === UNRESOLVED_CRITICAL_ALERT_FILTER
}
export type DecisionAuthority = 'execution_eligible' | 'owner_review' | 'diagnostic_only'
export type DecisionLifecycle =
  | 'generated'
  | 'blocked'
  | 'scheduled'
  | 'ready'
  | 'owner_decision'
  | 'manual_action_recorded'
  | 'observation_window'
  | 'outcome_review'

export type DecisionControl =
  | 'agree'
  | 'acknowledge'
  | 'schedule'
  | 'dismiss'
  | 'snooze'
  | 'mark_implemented'
  | 'approve_learning'
  | 'reject_learning'

export interface DecisionQueueDecisionInput {
  user_decision: string
  decision_date: string
  action_taken: boolean
  action_taken_date: string | null
  follow_up_date: string | null
}

export interface DecisionQueueRecommendationInput {
  id: string
  recommendation_type: string
  target_entity_type: string
  target_entity_id: string | null
  target_entity_name: string | null
  observed_fact: string
  reason_for_action: string
  date_range_start: string | null
  date_range_end: string | null
  recommended_next_check_date: string | null
  risk_level: string
  confidence_score: number
  confidence_label: string
  generated_at: string
  expected_upside: string | null
  possible_downside: string | null
  minimum_data_needed: string | null
  action_authority_tier: DecisionAuthority
  action_decision_id: string | null
  /** Real MetricClaim IDs only. ActionDecision IDs belong in action_decision_id. */
  metric_claim_ids?: string[]
  /** Store-verified exact bindings to immutable MetricClaim snapshots; strings alone are not lineage. */
  metric_claim_lineage_verified?: boolean
  /** Immutable current-state snapshot attached to the durable ActionDecision. */
  current_state?: Record<string, unknown> | null
  /** Immutable proposed-state snapshot attached to the durable ActionDecision. */
  proposed_state?: Record<string, unknown> | null
  /** The policy version that produced the durable ActionDecision. */
  authority_version?: number | null
  /** The concrete optimization unit approved by the ActionDecision, when it differs from the rec target. */
  authority_target_level?: string | null
  authority_target_id?: string | null
  /** Non-numeric signal to observe at the next review, when the source published one. */
  target_language?: string | null
  /** Exact governed outcome contract eligibility, before an owner records implementation. */
  learning_eligibility?: boolean | null
  /** Resolved MetricClaim snapshots + placeholders for missing claim IDs. */
  evidence?: RecommendationEvidenceItem[]
  decision: DecisionQueueDecisionInput | null
}

export interface DecisionQueueAlertInput {
  id: string
  title: string
  message: string
  alert_type: string
  severity: string
  detected_at: string
  alert_date: string | null
  amount_at_risk: number | null
}

export interface DecisionQueueTaskInput {
  id: string
  title: string
  description: string | null
  recommendation: string | null
  priority: string
  status: string
  due_date: string | null
  created_at: string
  action_authority_tier: DecisionAuthority
  action_decision_id: string | null
}

export interface DecisionQueueOutcomeInput {
  id: string
  recommendation: string
  outcome: string
  outcome_note: string | null
  review_status: string | null
  recommended_on: string
  evaluate_after: string
  evaluated_at: string | null
  estimate_only: boolean | null
  learning_eligibility: boolean
  action_evidence: boolean
}

export interface DecisionQueueProjectionInput {
  recommendations: DecisionQueueRecommendationInput[]
  alerts: DecisionQueueAlertInput[]
  tasks: DecisionQueueTaskInput[]
  outcomes: DecisionQueueOutcomeInput[]
  today: string
}

export interface DecisionQueueItemV2 {
  id: string
  source: 'recommendation' | 'alert' | 'task' | 'outcome'
  source_id: string
  title: string
  summary: string
  bucket: DecisionQueueView
  lifecycle: DecisionLifecycle
  authority: DecisionAuthority
  urgency: 'urgent' | 'high' | 'medium' | 'low'
  ready: boolean
  evidence_window: { start: string; end: string } | null
  review_date: string | null
  generated_at: string
  /** Only populated by a governed contribution model; legacy upside prose never reaches this field. */
  governedContribution: number | null
  /** A descriptive exposure, not a forecast. Null means it must not influence rank. */
  spendExposure: number | null
  evidenceCompleteness: 'complete' | 'partial' | 'unknown'
  evidenceMaturity: 'mature' | 'provisional' | 'unknown'
  /** Engine confidence for owner display only. Never read by compareItems or rank_reason. */
  confidence: { score: number; label: string } | null
  /** The existing data-sufficiency signal (also drives diagnostic lifecycle 'blocked' at
   * recommendationBucket). Surfaced for display; not a second sufficiency concept. */
  dataNeeded: string | null
  expiresAt: string | null
  rank_reason: string
  /** IDs in the MetricClaim namespace only; empty when this source has no atomized claim lineage. */
  claim_refs: string[]
  /** Resolved MetricClaim snapshots + placeholders for missing claim IDs. */
  evidence: RecommendationEvidenceItem[]
  /** Durable authority linkage. This is deliberately not a MetricClaim reference. */
  authority_decision_id: string | null
  authority_version: number | null
  optimization_unit: { level: string; id: string | null; name: string | null } | null
  current_state: Record<string, unknown> | null
  proposed_state: Record<string, unknown> | null
  validity: { state: 'valid' | 'quarantined'; review_date: string | null }
  owner_disposition: string | null
  outcome_eligible: boolean
  hypothesis: string | null
  expected_observation: string | null
  risk: string | null
  guardrail: string
  rollback: string
  controls: DecisionControl[]
  implementation: { recorded: boolean; recorded_at: string | null }
}

export type RecommendationDecisionDisposition = 'accepted' | 'acted_on' | 'snoozed' | 'needs_more_data' | 'rejected'

/** Agreement is owner intent. Only the separate implementation control records `acted_on`. */
export function recommendationDecisionForControl(control: DecisionControl): RecommendationDecisionDisposition {
  if (control === 'agree' || control === 'acknowledge') return 'accepted'
  if (control === 'mark_implemented') return 'acted_on'
  if (control === 'snooze') return 'snoozed'
  if (control === 'schedule') return 'needs_more_data'
  return 'rejected'
}

const MONEY_ACTIONS = new Set([
  'scale', 'scale_proposal', 'pause', 'reduce_budget', 'activate',
  'refresh_creative', 'change_optimization_event', 'change_audience', 'restructure',
])
const TRACKING_TYPES = new Set(['tracking_issue', 'attribution_issue', 'funnel_diagnosis'])
const OWNER_SURFACE_EXCLUDED_TERMS = /(?:outcome[_\s-]*(?:ledger|business|source)|recorded[_\s-]*outcome|collected[_\s-]*value|checkout|trackedcheckout|amount[_\s-]*paid|amountpaid|booked[_\s-]*value|bookedvalue|cancell?ation|refund|cash|profit|revenue|return(?:s|ed)?|roas|paid[_\s-]*association|paidassociation)/i
const URGENCY_RANK = { urgent: 4, high: 3, medium: 2, low: 1 } as const
const AUTHORITY_RANK: Record<DecisionAuthority, number> = {
  execution_eligible: 3,
  owner_review: 2,
  diagnostic_only: 1,
}

function urgency(value: string): DecisionQueueItemV2['urgency'] {
  if (value === 'urgent' || value === 'critical') return 'urgent'
  if (value === 'high') return 'high'
  if (value === 'low' || value === 'info') return 'low'
  return 'medium'
}

function isFuture(date: string | null, today: string): boolean {
  return date !== null && date > today
}

function recommendationBucket(
  row: DecisionQueueRecommendationInput,
  today: string,
): Pick<DecisionQueueItemV2, 'bucket' | 'lifecycle' | 'ready' | 'controls'> {
  const decision = row.decision
  if (!hasDurableDecisionLineage(row)) {
    // This guard must run before lifecycle branches. Otherwise a legacy row can become accepted,
    // snoozed, or "implemented" without the immutable MetricClaim + ActionDecision pair required
    // to explain what the owner was agreeing to.
    return {
      bucket: 'tracking_repair', lifecycle: 'blocked', ready: false,
      controls: ['acknowledge', 'schedule', 'dismiss'],
    }
  }
  if (decision?.action_taken || decision?.user_decision === 'acted_on') {
    return { bucket: 'monitoring', lifecycle: 'observation_window', ready: false, controls: [] }
  }
  if (decision?.user_decision === 'accepted') {
    return {
      bucket: 'awaiting_implementation', lifecycle: 'owner_decision', ready: false,
      controls: ['mark_implemented', 'dismiss'],
    }
  }
  if (decision?.user_decision === 'snoozed' && (decision.follow_up_date === null || isFuture(decision.follow_up_date, today))) {
    return { bucket: 'snoozed', lifecycle: 'scheduled', ready: false, controls: ['agree', 'dismiss'] }
  }
  if (decision?.user_decision === 'needs_more_data') {
    return { bucket: 'monitoring', lifecycle: 'scheduled', ready: false, controls: ['agree', 'dismiss', 'snooze'] }
  }
  if (decision?.user_decision === 'rejected' || decision?.user_decision === 'ignored') {
    return { bucket: 'monitoring', lifecycle: 'blocked', ready: false, controls: [] }
  }
  if (row.action_authority_tier === 'diagnostic_only' || !MONEY_ACTIONS.has(row.recommendation_type)) {
    return {
      bucket: TRACKING_TYPES.has(row.recommendation_type) ? 'tracking_repair' : 'monitoring',
      lifecycle: row.minimum_data_needed ? 'blocked' : 'generated',
      ready: false,
      controls: ['acknowledge', 'schedule', 'dismiss'],
    }
  }
  return {
    bucket: 'needs_review', lifecycle: 'ready', ready: true,
    controls: ['agree', 'dismiss', 'snooze'],
  }
}

function hasDurableDecisionLineage(row: DecisionQueueRecommendationInput): boolean {
  const claims = row.metric_claim_ids ?? []
  return row.metric_claim_lineage_verified === true
    && !!row.action_decision_id
    && claims.length > 0
    && claims.every((id) => typeof id === 'string' && id.trim().length > 0 && id === id.trim())
    && new Set(claims).size === claims.length
}

function nonnumericSignal(value: string | null | undefined): string | null {
  const signal = value?.trim() ?? ''
  // This surface must not manufacture or restate a numeric performance forecast. Source language
  // that includes a number remains in the evidence detail, not in the owner-loop signal field.
  return signal && !/\d/.test(signal) ? signal : null
}

/**
 * ActionDecision snapshots can contain legacy commercial fields. Decisions is a Meta delivery
 * owner surface, so retain only scalar Meta-safe state rather than re-labelling those fields.
 */
function metaOwnerState(value: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (!value) return null
  const safeEntries = Object.entries(value).filter(([key, candidate]) => {
    if (OWNER_SURFACE_EXCLUDED_TERMS.test(key)) return false
    if (typeof candidate === 'string' && OWNER_SURFACE_EXCLUDED_TERMS.test(candidate)) return false
    return candidate === null
      || typeof candidate === 'string'
      || typeof candidate === 'number'
      || typeof candidate === 'boolean'
  })
  return safeEntries.length > 0 ? Object.fromEntries(safeEntries) : null
}

function metaOwnerCopy(value: string, fallback: string): string {
  return OWNER_SURFACE_EXCLUDED_TERMS.test(value) ? fallback : value
}

function rankReason(item: Omit<DecisionQueueItemV2, 'rank_reason'>): string {
  const contribution = item.governedContribution === null
    ? 'governed contribution unavailable'
    : `${formatMoney(item.governedContribution)} governed contribution`
  const exposure = item.spendExposure === null
    ? 'spend exposure unavailable'
    : `${formatMoney(item.spendExposure)} labeled exposure`
  return `${item.authority.replace(/_/g, ' ')} authority · ${item.urgency} urgency · ${contribution} · ${exposure} · ${item.evidenceCompleteness} evidence · ${item.evidenceMaturity} maturity · ${item.expiresAt ?? 'no expiry'} · stable id ${item.id}`
}

function projectRecommendation(row: DecisionQueueRecommendationInput, today: string): DecisionQueueItemV2 {
  const state = recommendationBucket(row, today)
  const base: Omit<DecisionQueueItemV2, 'rank_reason'> = {
    id: `recommendation:${row.id}`,
    source: 'recommendation',
    source_id: row.id,
    title: `${row.recommendation_type.replace(/_/g, ' ')} · ${row.target_entity_name ?? 'Account'}`,
    summary: metaOwnerCopy(row.reason_for_action || row.observed_fact, 'Review the Meta delivery evidence before making a manual change.'),
    ...state,
    authority: row.action_authority_tier,
    urgency: urgency(row.risk_level),
    evidence_window: row.date_range_start && row.date_range_end
      ? { start: row.date_range_start, end: row.date_range_end }
      : null,
    review_date: row.recommended_next_check_date,
    generated_at: row.generated_at,
    governedContribution: null,
    spendExposure: null,
    evidenceCompleteness: row.metric_claim_lineage_verified ? 'complete' : 'unknown',
    evidenceMaturity: 'unknown',
    confidence: { score: row.confidence_score, label: row.confidence_label },
    dataNeeded: row.minimum_data_needed
      ? metaOwnerCopy(row.minimum_data_needed, 'More evidence is required before this can be acted on.')
      : null,
    expiresAt: row.recommended_next_check_date,
    claim_refs: [...(row.metric_claim_ids ?? [])],
    evidence: row.evidence ?? [],
    authority_decision_id: row.action_decision_id,
    authority_version: row.authority_version ?? null,
    optimization_unit: {
      level: row.authority_target_level ?? row.target_entity_type,
      id: row.authority_target_id ?? row.target_entity_id,
      name: row.authority_target_level && row.authority_target_level !== row.target_entity_type
        ? null
        : row.target_entity_name,
    },
    current_state: metaOwnerState(row.current_state),
    proposed_state: metaOwnerState(row.proposed_state),
    validity: {
      state: hasDurableDecisionLineage(row) ? 'valid' : 'quarantined',
      review_date: row.recommended_next_check_date,
    },
    owner_disposition: row.decision?.user_decision ?? null,
    outcome_eligible: !!row.learning_eligibility && !!row.decision?.action_taken,
    hypothesis: metaOwnerCopy(row.reason_for_action, 'Review the Meta delivery evidence before making a manual change.'),
    // Legacy expected_upside was authored before calibrated-impact governance. Never promote it into
    // the V2 action surface; the owner gets the review date and a signal can be added only by a
    // separately governed calibrated model.
    expected_observation: nonnumericSignal(row.target_language),
    risk: row.possible_downside ? metaOwnerCopy(row.possible_downside, 'Review the Meta delivery guardrail before manual implementation.') : null,
    guardrail: 'No live change is made by Maxx. Confirm the current Meta state before manual implementation.',
    rollback: 'If the observed signal regresses, restore the prior Meta state and record the manual reversal.',
    implementation: {
      recorded: !!row.decision?.action_taken,
      recorded_at: row.decision?.action_taken_date ?? null,
    },
  }
  return { ...base, rank_reason: rankReason(base) }
}

function projectAlert(row: DecisionQueueAlertInput): DecisionQueueItemV2 {
  const tracking = /track|attribution|measurement|pixel|capi|booking|identity/i.test(`${row.alert_type} ${row.title}`)
  const base: Omit<DecisionQueueItemV2, 'rank_reason'> = {
    id: `alert:${row.id}`,
    source: 'alert',
    source_id: row.id,
    title: row.title,
    summary: row.message,
    bucket: tracking ? 'tracking_repair' : 'needs_review',
    lifecycle: 'blocked',
    authority: 'diagnostic_only',
    urgency: urgency(row.severity),
    ready: false,
    evidence_window: row.alert_date ? { start: row.alert_date, end: row.alert_date } : null,
    review_date: null,
    generated_at: row.detected_at,
    governedContribution: null,
    spendExposure: row.amount_at_risk,
    evidenceCompleteness: 'unknown',
    evidenceMaturity: 'unknown',
    confidence: null,
    dataNeeded: null,
    expiresAt: null,
    claim_refs: [],
    evidence: [],
    authority_decision_id: null,
    authority_version: null,
    optimization_unit: null,
    current_state: null,
    proposed_state: null,
    validity: { state: 'valid', review_date: null },
    owner_disposition: null,
    outcome_eligible: false,
    hypothesis: null,
    expected_observation: null,
    risk: row.amount_at_risk === null ? null : `${formatMoney(row.amount_at_risk)} labeled exposure`,
    guardrail: 'Notification only. Acknowledging this alert does not authorize or execute an ad change.',
    rollback: 'Not applicable — this item has no mutation authority.',
    controls: ['acknowledge'],
    implementation: { recorded: false, recorded_at: null },
  }
  return { ...base, rank_reason: `${rankReason(base)} · notification-only` }
}

function projectTask(row: DecisionQueueTaskInput): DecisionQueueItemV2 {
  const tracking = /track|attribution|pixel|capi|booking|identity/i.test(`${row.title} ${row.description ?? ''}`)
  const waiting = row.status === 'in_progress'
  const diagnostic = row.action_authority_tier === 'diagnostic_only'
  const base: Omit<DecisionQueueItemV2, 'rank_reason'> = {
    id: `task:${row.id}`,
    source: 'task',
    source_id: row.id,
    title: row.title,
    summary: row.recommendation ?? row.description ?? 'Manual owner task.',
    bucket: tracking ? 'tracking_repair' : diagnostic || waiting ? 'monitoring' : 'awaiting_implementation',
    // An in-progress task is awaiting the owner's separately recorded implementation. It is not
    // evidence that a Meta change happened, so it must never enter the implementation lifecycle.
    lifecycle: diagnostic ? (tracking ? 'blocked' : 'generated') : 'owner_decision',
    authority: row.action_authority_tier,
    urgency: urgency(row.priority),
    ready: false,
    evidence_window: null,
    review_date: row.due_date,
    generated_at: row.created_at,
    governedContribution: null,
    spendExposure: null,
    evidenceCompleteness: 'unknown',
    evidenceMaturity: 'unknown',
    confidence: null,
    dataNeeded: null,
    expiresAt: row.due_date,
    claim_refs: [],
    evidence: [],
    authority_decision_id: row.action_decision_id,
    authority_version: null,
    optimization_unit: null,
    current_state: null,
    proposed_state: null,
    validity: { state: row.action_decision_id ? 'valid' : 'quarantined', review_date: row.due_date },
    owner_disposition: null,
    outcome_eligible: false,
    hypothesis: row.description,
    expected_observation: null,
    risk: null,
    guardrail: 'This task is a manual workflow record. Its authority is inherited from its persisted ActionDecision.',
    rollback: 'Record the prior state before any external implementation.',
    controls: diagnostic
      ? ['acknowledge', 'schedule', 'dismiss']
      : waiting ? ['mark_implemented', 'dismiss'] : ['schedule', 'dismiss'],
    implementation: { recorded: false, recorded_at: null },
  }
  return { ...base, rank_reason: rankReason(base) }
}

function projectOutcome(row: DecisionQueueOutcomeInput): DecisionQueueItemV2 {
  const decisive = !row.estimate_only
    && row.learning_eligibility
    && row.action_evidence
    && (row.outcome === 'worked' || row.outcome === 'failed')
  const pending = (row.review_status ?? 'pending') === 'pending'
  const base: Omit<DecisionQueueItemV2, 'rank_reason'> = {
    id: `outcome:${row.id}`,
    source: 'outcome',
    source_id: row.id,
    title: `${row.outcome.replace(/_/g, ' ')} · outcome review`,
    summary: row.outcome_note ?? row.recommendation,
    bucket: pending && decisive ? 'outcome_review' : 'monitoring',
    lifecycle: pending && decisive ? 'outcome_review' : 'observation_window',
    authority: 'diagnostic_only',
    urgency: row.outcome === 'failed' ? 'high' : 'medium',
    ready: false,
    evidence_window: { start: row.recommended_on, end: row.evaluate_after },
    review_date: row.evaluate_after,
    generated_at: row.evaluated_at ?? row.evaluate_after,
    governedContribution: null,
    spendExposure: null,
    evidenceCompleteness: row.learning_eligibility && row.action_evidence ? 'complete' : 'partial',
    evidenceMaturity: row.evaluated_at ? 'mature' : 'provisional',
    confidence: null,
    dataNeeded: null,
    expiresAt: row.evaluate_after,
    claim_refs: [],
    evidence: [],
    authority_decision_id: null,
    authority_version: null,
    optimization_unit: null,
    current_state: null,
    proposed_state: null,
    validity: { state: 'valid', review_date: row.evaluate_after },
    owner_disposition: null,
    outcome_eligible: row.learning_eligibility && row.action_evidence,
    hypothesis: row.recommendation,
    expected_observation: null,
    risk: null,
    guardrail: decisive
      ? 'Reviewing an outcome changes learning eligibility only; it cannot change live delivery.'
      : 'Learning review withheld: a declared eligible outcome contract and separately recorded action evidence are both required.',
    rollback: 'A reviewed outcome can be rejected later from the learning review surface.',
    controls: pending && decisive ? ['approve_learning', 'reject_learning'] : [],
    implementation: { recorded: false, recorded_at: null },
  }
  return { ...base, rank_reason: rankReason(base) }
}

function compareItems(a: DecisionQueueItemV2, b: DecisionQueueItemV2): number {
  const authority = AUTHORITY_RANK[b.authority] - AUTHORITY_RANK[a.authority]
  if (authority !== 0) return authority
  const urgent = URGENCY_RANK[b.urgency] - URGENCY_RANK[a.urgency]
  if (urgent !== 0) return urgent
  if (a.ready !== b.ready) return a.ready ? -1 : 1
  const numericDescending = (left: number | null, right: number | null): number => {
    if (left === null && right === null) return 0
    if (left === null) return 1
    if (right === null) return -1
    return right - left
  }
  const contribution = numericDescending(a.governedContribution, b.governedContribution)
  if (contribution !== 0) return contribution
  const exposure = numericDescending(a.spendExposure, b.spendExposure)
  if (exposure !== 0) return exposure
  const completeness = ({ complete: 2, partial: 1, unknown: 0 } as const)[b.evidenceCompleteness]
    - ({ complete: 2, partial: 1, unknown: 0 } as const)[a.evidenceCompleteness]
  if (completeness !== 0) return completeness
  const maturity = ({ mature: 2, provisional: 1, unknown: 0 } as const)[b.evidenceMaturity]
    - ({ mature: 2, provisional: 1, unknown: 0 } as const)[a.evidenceMaturity]
  if (maturity !== 0) return maturity
  const expiry = (a.expiresAt ?? '9999-12-31').localeCompare(b.expiresAt ?? '9999-12-31')
  return expiry !== 0 ? expiry : a.id.localeCompare(b.id)
}

export function buildDecisionQueue(input: DecisionQueueProjectionInput): DecisionQueueItemV2[] {
  return [
    ...input.recommendations.map((row) => projectRecommendation(row, input.today)),
    ...input.alerts.map(projectAlert),
    ...input.tasks.filter((row) => row.status === 'open' || row.status === 'in_progress').map(projectTask),
    ...input.outcomes.map(projectOutcome),
  ].sort(compareItems)
}

export function visibleDecisionQueue(
  items: DecisionQueueItemV2[],
  view: DecisionQueueView,
  filter?: DecisionQueueFilter,
): { items: DecisionQueueItemV2[]; deferred_ready_count: number } {
  const matches = filter === UNRESOLVED_CRITICAL_ALERT_FILTER
    ? items.filter((item) => item.source === 'alert' && item.urgency === 'urgent')
    : items.filter((item) => item.bucket === view)
  if (filter || view !== 'needs_review') return { items: matches, deferred_ready_count: 0 }
  const ready = matches.filter((item) => item.ready)
  const diagnostics = matches.filter((item) => !item.ready)
  return {
    items: [...ready.slice(0, 3), ...diagnostics],
    deferred_ready_count: Math.max(0, ready.length - 3),
  }
}

/** Stable owner-loop links for Today. The queue is already deterministically ranked; this selector
 * excludes passive monitoring/history and preserves that ordering. */
export function decisionIdsForCockpit(
  items: DecisionQueueItemV2[],
  limit = 3,
): { decisionIds: string[]; primaryDecisionId: string | null } {
  const decisionIds = items
    .filter((item) => item.controls.length > 0 && item.bucket !== 'monitoring' && item.bucket !== 'snoozed')
    .slice(0, limit)
    .map((item) => item.source_id)
  return { decisionIds, primaryDecisionId: decisionIds[0] ?? null }
}
