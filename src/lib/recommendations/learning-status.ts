import { outcomeWords } from '@/config/outcome-nouns'
import { isCausalContributionMetric } from '@/lib/economics/causal-metric'

// What this business calls its outcomes (NEXT_PUBLIC_OUTCOME_NOUN).
const OW = outcomeWords()
// Learning-status chip logic (recommendation visibility). PURE + tested. Maps a stored
// recommendation (or a scored outcome) to a single honest chip that tells the owner what the item means
// for LEARNING — never overstating. This is display logic only; it changes no scoring and enables no
// action (write mode stays OFF).
//
// Two contexts:
//  • learningStatus(rec)      — an OPEN recommendation: what can/can't be learned from it and why.
//  • outcomeLearningLabel(o)   — a SCORED outcome on the review surface: its classification + whether the
//                                owner has approved it as a trusted learning (the review gate).

export type LearningState =
  | 'external_inspiration'
  | 'hypothesis'
  | 'attribution_unclear'
  | 'not_enough_data'
  | 'eligible'
  | 'inconclusive'
  | 'learned'
  | 'pending_review'
  | 'no_outcome_yet'

export type LearningTone = 'neutral' | 'info' | 'warn' | 'good'

export interface LearningStatus {
  state: LearningState
  label: string
  tone: LearningTone
  tooltip: string
}

/** Narrow field subset (decoupled from the full row so it is trivially testable). */
export interface LearningStatusInput {
  gate_decision?: string | null
  learning_eligibility?: boolean | null
  attribution_confidence?: number | null
  attribution_warning?: string | null
  low_data_warning?: string | null
  confidence_label?: string | null
  external_knowledge_used?: string[] | null
}

const ATTRIBUTION_FLOOR = 0.5 // mirrors MIN_ATTRIBUTED_SHARE — below this, per-entity revenue is estimate-only

/** Chip for an OPEN recommendation. Precedence is most-limiting first, so the chip never overstates. */
export function learningStatus(r: LearningStatusInput): LearningStatus {
  const hasExternal = !!(r.external_knowledge_used && r.external_knowledge_used.length)
  const demoted = r.gate_decision === 'downgrade_to_hypothesis'
  const attributionUnclear =
    !!r.attribution_warning || (r.attribution_confidence != null && r.attribution_confidence < ATTRIBUTION_FLOOR)
  const thin = !!r.low_data_warning || r.confidence_label === 'insufficient'

  if (hasExternal && demoted) {
    return { state: 'external_inspiration', label: 'External inspiration only', tone: 'info',
      tooltip: 'Informed by external best practice / expert signals — a labeled test idea, never proof or an account fact.' }
  }
  if (demoted) {
    return { state: 'hypothesis', label: 'Hypothesis only', tone: 'info',
      tooltip: 'The gate downgraded this to a labeled hypothesis — it must be tested, not asserted.' }
  }
  if (attributionUnclear) {
    return { state: 'attribution_unclear', label: 'Attribution unclear', tone: 'warn',
      tooltip: 'GA4 attribution behind this is below 50% — any revenue/ROAS is estimate-only, and its outcome will be estimate-only for learning.' }
  }
  if (thin) {
    return { state: 'not_enough_data', label: 'Not enough data', tone: 'warn',
      tooltip: `Below the spend/${OW.many}/window bar — not decisive yet; its outcome cannot be learned from until there is more data.` }
  }
  if (r.learning_eligibility === true) {
    return { state: 'eligible', label: 'Eligible for learning', tone: 'good',
      tooltip: 'This intervention has a governed causal incremental-contribution outcome contract; once acted on, measured, and approved by you, it can become a trusted commercial learning.' }
  }
  return { state: 'no_outcome_yet', label: 'No outcome data yet', tone: 'neutral',
    tooltip: 'A grounded read/keep with no scored outcome — not a learning candidate on its own.' }
}

export interface OutcomeLabelInput {
  outcome?: string | null // worked | failed | inconclusive | null
  review_status?: string | null // pending | approved | rejected
  estimate_only?: boolean | null
  metric_name?: string | null
}

/** Chip for a SCORED outcome on the review surface. Encodes the human review gate: a worked/failed
 *  outcome is only a "Learned pattern" once the owner APPROVES it — until then it is pending review and
 *  does NOT feed trusted win-rates or the track record. */
export function outcomeLearningLabel(o: OutcomeLabelInput): LearningStatus {
  if (o.review_status === 'rejected') {
    return { state: 'no_outcome_yet', label: 'Rejected — not learned', tone: 'neutral',
      tooltip: 'You rejected this as a learning; it is excluded from win-rates and the track record.' }
  }
  if ((o.outcome === 'worked' || o.outcome === 'failed')
      && !isCausalContributionMetric(o.metric_name)) {
    return { state: 'attribution_unclear', label: 'Diagnostic only', tone: 'warn',
      tooltip: 'This result was not measured as causal incremental contribution dollars, so it cannot become a commercial learning.' }
  }
  if (o.estimate_only) {
    return { state: 'attribution_unclear', label: 'Attribution unclear', tone: 'warn',
      tooltip: 'Estimate-only (GA4 attribution < 50%) — excluded from trusted win-rates even if approved.' }
  }
  if (o.outcome === 'inconclusive') {
    return { state: 'inconclusive', label: 'Inconclusive', tone: 'warn',
      tooltip: 'Data too weak to call worked or failed — never counted as a win or a loss.' }
  }
  if (o.outcome === 'worked' || o.outcome === 'failed') {
    if (o.review_status === 'approved') {
      return { state: 'learned', label: 'Learned pattern', tone: 'good',
        tooltip: 'You approved this outcome — it counts toward trusted win-rates and the track-record adjuster.' }
    }
    return { state: 'pending_review', label: `${o.outcome} · pending review`, tone: 'info',
      tooltip: 'Scored, but awaiting your approval before it becomes a trusted learning.' }
  }
  return { state: 'no_outcome_yet', label: 'No outcome yet', tone: 'neutral', tooltip: 'Not yet scored.' }
}
