import { REC_THRESHOLDS } from './thresholds'
import { checkNoOscillation, type NoOscillationInput } from './no-oscillation'
import { trackRecordAdjuster } from '@/lib/learning/model'
import { getTargetRange } from '@/lib/targets/target-ranges'
import {
  REVERSAL_CLASS,
  type RecommendationType,
  type EvidenceBasis,
  type GroundingCheck,
  type GroundingResult,
  type ConfidenceLabel,
  type RiskLevel,
} from './types'
import { formatMoney, formatMoneyAmount } from '@/lib/utils/format-currency'
import { outcomeWords } from '@/config/outcome-nouns'

// What this business calls its outcomes (NEXT_PUBLIC_OUTCOME_NOUN).
const OW = outcomeWords()

// The grounding gate. Ten questions, answered in CODE — not just asked of the LLM.
// The gate's job: never let an ungrounded recommendation be shown as confident or actionable.
//
// It returns a GroundingResult with:
//   - decision: allow | downgrade_to_hypothesis | hold | block
//   - a capped confidence_score (each failed check multiplies it down),
//   - the three mandatory safety warnings (low-data / estimate / attribution),
//   - the full check trace so the dashboard/report can explain WHY it was downgraded.

export interface GroundingInput {
  recommendation_type: RecommendationType

  // (1) enough data
  spend: number
  bookings: number | null // conversions/bookings in the window
  window_days: number

  // (2) freshness
  data_age_hours: number | null // null = unknown ⇒ treated as stale

  // (3) metric source validity
  data_sources_count: number // how many concrete sources back this (0 ⇒ unsourced)

  // (4) actual booking/revenue vs Meta estimate
  // Set true when the recommendation leans on Meta's appointment_value / pixel count AS revenue/ROAS.
  uses_meta_estimate_as_revenue: boolean

  // (5) sample size handled by (1) bookings + the perf-claim thresholds below

  // (6) time since last change; (9) reports learning state separately from sufficiency
  days_since_last_change: number | null
  exited_learning: boolean | null
  trend_stable: boolean | null

  // (7) conflicting signal
  conflicting_signal: boolean
  conflicting_signal_note?: string

  // (8) basis
  basis: EvidenceBasis

  // per-campaign actual-ROAS claims
  claims_per_campaign_roas?: boolean
  attributed_share?: number | null

  // account state
  account_dormant?: boolean

  // (10) risk if wrong
  reversible?: boolean // default true

  // Track record: this account's OWN win-rate for this play, used as a tempering ADJUSTER only.
  // Absent ⇒ no effect. `priorWinRate`/`k` come from resolvePrior in the caller (benchmark-aware,
  // account-wins) so a chronically-failing play here is down-weighted while a good/neutral one is not.
  track_record?: { wins: number; decisive: number; priorWinRate?: number; k?: number }
}

const HOLD_FOR: ReadonlySet<RecommendationType> = REVERSAL_CLASS // actionable, money-moving types

// Cut-waste actions can be grounded by the ABSENCE of conversions given enough spend — you don't need
// 3 bookings to conclude "this spent real money and booked nothing." (Positive-claim actions like
// scale/activate still require the booking sample; a CPA-quality verdict likewise.)
const WASTE_CUT_CLASS: ReadonlySet<RecommendationType> = new Set<RecommendationType>(['pause', 'reduce_budget'])

function labelFor(score: number): ConfidenceLabel {
  if (score >= 0.7) return 'high'
  if (score >= 0.45) return 'medium'
  if (score >= 0.2) return 'low'
  return 'insufficient'
}

export function runGroundingGate(input: GroundingInput): GroundingResult {
  const checks: GroundingCheck[] = []
  const reasons: string[] = []
  let score = 1.0
  let hardBlock = false
  let downgradeToHypothesis = false

  const isAction = HOLD_FOR.has(input.recommendation_type)
  const reversible = input.reversible !== false
  const minWindow = input.recommendation_type === 'scale' ? REC_THRESHOLDS.MIN_WINDOW_DAYS_SCALE : REC_THRESHOLDS.MIN_WINDOW_DAYS_REVERSAL

  const warnings = { low_data: null as string | null, estimate: null as string | null, attribution: null as string | null }

  // (1) Enough data?
  const enoughSpend = input.spend >= REC_THRESHOLDS.MIN_SPEND_TO_JUDGE
  const enoughWindow = input.window_days >= minWindow
  if (enoughSpend && enoughWindow) {
    checks.push({ id: 1, question: 'Is there enough data?', status: 'pass', note: `${formatMoney(input.spend, { maximumFractionDigits: 0 })} over ${input.window_days}d.` })
  } else {
    // NAME THE HALF THAT IS SHORT. `enoughSpend && enoughWindow` is an AND, so this branch runs when
    // EITHER is short -- and the message then blamed both, which is how an owner could read
    // "Only $1343 over 1d — below the bar" on a unit whose spend cleared the $20 floor sixty times.
    //
    // The same conflation was fixed in `builder.ts` (`minimum_data_needed`) and NOT here, which made
    // it worse rather than better: `minimum_data_needed` renders inside the collapsed "Evidence &
    // why" expander, while this warning renders in the always-visible well -- and once a money
    // decision clears to owner_review, `recommendation-authority.ts` DISCARDS `minimum_data_needed`
    // and keeps this one. The corrected sentence was being thrown away and the false one kept, on
    // exactly the recommendations this branch exists to unlock.
    const short = [
      !enoughSpend ? `≥ ${formatMoneyAmount(REC_THRESHOLDS.MIN_SPEND_TO_JUDGE)} spend (only ${formatMoney(input.spend, { maximumFractionDigits: 0 })} so far)` : null,
      !enoughWindow ? `≥ ${minWindow} days (only ${input.window_days} so far)` : null,
    ].filter((line): line is string => line !== null)
    checks.push({ id: 1, question: 'Is there enough data?', status: 'fail', note: `${formatMoney(input.spend, { maximumFractionDigits: 0 })} over ${input.window_days}d — still needs ${short.join(' and ')}.` })
    warnings.low_data = `Still needs ${short.join(' and ')} before performance can be judged.`
    score *= 0.35
    reasons.push('Insufficient spend/window.')
    if (isAction) hardBlock = true
  }

  // (2) Is the data fresh?
  if (input.data_age_hours !== null && input.data_age_hours <= REC_THRESHOLDS.MAX_DATA_AGE_HOURS) {
    checks.push({ id: 2, question: 'Is the data fresh?', status: 'pass', note: `${input.data_age_hours.toFixed(0)}h old.` })
  } else {
    checks.push({ id: 2, question: 'Is the data fresh?', status: 'fail', note: input.data_age_hours === null ? 'Data age unknown.' : `${input.data_age_hours.toFixed(0)}h old (> ${REC_THRESHOLDS.MAX_DATA_AGE_HOURS}h).` })
    warnings.low_data = (warnings.low_data ? warnings.low_data + ' ' : '') + 'Data is stale — re-sync before acting.'
    score *= 0.7
    reasons.push('Stale or unknown-age data.')
  }

  // (3) Is the metric source valid?
  if (input.data_sources_count > 0) {
    checks.push({ id: 3, question: 'Is the metric source valid?', status: 'pass', note: `${input.data_sources_count} concrete source(s).` })
  } else {
    checks.push({ id: 3, question: 'Is the metric source valid?', status: 'fail', note: 'No concrete data source cited.' })
    score *= 0.3
    reasons.push('Unsourced claim.')
    if (isAction) hardBlock = true
  }

  // (4) Ledger/exact paid evidence vs Meta estimate?
  if (input.uses_meta_estimate_as_revenue) {
    checks.push({ id: 4, question: 'Actual booked value, or Meta estimate?', status: 'fail', note: `Leans on Meta appointment_value/pixel as value — modelled attribution can under- or over-attribute. Outcome source is the business record; a paid value requires the complete exact ${OW.one}-id join.` })
    warnings.estimate = `Value/ROAS here is MODELLED attribution, not a paid business result. Use the outcome source for total booked value and the complete exact ${OW.one}-id join for any paid subset.`
    score = Math.min(score, 0.6) // can never be "high" on a Meta-estimate revenue claim
    reasons.push(`Revenue basis is a Meta MODELLED estimate, not outcome ledger booked value nor an exact ${OW.one}-id join.`)
  } else {
    checks.push({ id: 4, question: 'Ledger booked value / exact paid outcome, or Meta estimate?', status: 'pass', note: 'Not asserting Meta modelled value as ledger booked value or an exact paid outcome.' })
  }

  // (5) Is the sample size large enough?
  const b = input.bookings ?? 0
  // A cut-waste action grounded by strong non-conversion: 0 bookings AFTER spending ≥ 2× target CPA over
  // a sufficient window is itself the evidence to cut. Mirrors the flag engine's loser rule; the money is
  // real even though the booking count is zero. Without an owner CPA target there is no 2x line.
  const targetCpa = getTargetRange('cpa').healthy
  const strongNonConversion =
    b === 0 && targetCpa !== null &&
    input.spend >= targetCpa * 2 &&
    input.window_days >= REC_THRESHOLDS.MIN_WINDOW_DAYS_REVERSAL
  if (b >= REC_THRESHOLDS.MIN_BOOKINGS_STRONG_CLAIM) {
    checks.push({ id: 5, question: 'Is the sample size large enough?', status: 'pass', note: `${b} ${OW.many}.` })
  } else if (b >= REC_THRESHOLDS.MIN_BOOKINGS_PERF_CLAIM) {
    checks.push({ id: 5, question: 'Is the sample size large enough?', status: 'pass', note: `${b} ${OW.many} (enough for a directional verdict, not a strong one).` })
    score = Math.min(score, 0.6)
  } else if (WASTE_CUT_CLASS.has(input.recommendation_type) && strongNonConversion) {
    // Non-conversion IS the evidence — don't hard-block a waste-cut for lack of bookings.
    checks.push({ id: 5, question: 'Is the sample size large enough?', status: 'pass', note: `0 ${OW.many} on ${formatMoney(input.spend, { maximumFractionDigits: 0 })} over ${input.window_days}d — non-conversion itself is the evidence to cut waste (spent ≥ 2× target CPA with nothing booked).` })
    score = Math.min(score, 0.6) // a cut on absence-of-conversions is a medium-confidence call, never "high"
  } else {
    checks.push({ id: 5, question: 'Is the sample size large enough?', status: 'fail', note: `${b} ${OW.many} (need ≥ ${REC_THRESHOLDS.MIN_BOOKINGS_PERF_CLAIM} for a confident per-entity verdict).` })
    warnings.low_data = (warnings.low_data ? warnings.low_data + ' ' : '') + `Only ${b} ${OW.many} — too few for a confident performance verdict.`
    score *= 0.5
    reasons.push('Sample size below the per-entity performance bar.')
    if (isAction) hardBlock = true
  }

  // (6) Enough time since the last change?  +  no-oscillation
  const osc = checkNoOscillation({
    recommendation_type: input.recommendation_type,
    window_days: input.window_days,
    spend: input.spend,
    bookings: input.bookings,
    days_since_last_change: input.days_since_last_change,
    exited_learning: input.exited_learning,
    trend_stable: input.trend_stable,
    basis: input.basis,
  } satisfies NoOscillationInput)
  if (!osc.is_reversal_class) {
    checks.push({ id: 6, question: 'Enough time since the last change (no oscillation)?', status: 'na', note: 'Not a reversal/scale/restructure.' })
  } else if (osc.allowed) {
    checks.push({ id: 6, question: 'Enough time since the last change (no oscillation)?', status: 'pass', note: 'Reversal is grounded and not oscillatory.' })
  } else {
    checks.push({ id: 6, question: 'Enough time since the last change (no oscillation)?', status: 'fail', note: osc.blocking_factors.join(' ') })
    score *= 0.25
    reasons.push('No-oscillation rule violated.')
    hardBlock = true
  }

  // (7) Is there a conflicting signal?
  if (input.conflicting_signal) {
    checks.push({ id: 7, question: 'Is there a conflicting signal?', status: 'fail', note: input.conflicting_signal_note ?? `Signals disagree (e.g. Meta vs GA4, CTR vs ${OW.many}).` })
    score *= 0.6
    reasons.push('Conflicting signal present.')
  } else {
    checks.push({ id: 7, question: 'Is there a conflicting signal?', status: 'pass', note: 'No conflicting signal flagged.' })
  }

  // (8) Basis: observed performance, external best practice, or test hypothesis?
  if (input.basis === 'observed_performance') {
    checks.push({ id: 8, question: 'Observed performance, best practice, or hypothesis?', status: 'pass', note: 'Grounded in this account’s observed performance.' })
  } else if (input.basis === 'test_hypothesis') {
    checks.push({ id: 8, question: 'Observed performance, best practice, or hypothesis?', status: 'pass', note: 'Framed as a TEST hypothesis (correctly not asserted as proven).' })
    if (isAction) downgradeToHypothesis = true
    score = Math.min(score, 0.5)
  } else {
    checks.push({ id: 8, question: 'Observed performance, best practice, or hypothesis?', status: 'fail', note: 'Based on external best practice, not this account — must be reframed as a test, not asserted.' })
    if (isAction) downgradeToHypothesis = true
    score = Math.min(score, 0.45)
    reasons.push('Action justified only by external best practice.')
  }

  // (9) Learning is a delivery-system state, not measurement maturity or decision sufficiency.
  checks.push({
    id: 9,
    question: 'What is the Meta learning state?',
    status: 'na',
    note:
      input.exited_learning === true
        ? 'Exited learning; this does not prove business impact.'
        : input.exited_learning === false
          ? 'In learning; this describes delivery exploration and does not by itself veto an observation.'
          : 'Learning state unknown; evidence sufficiency is evaluated independently.',
  })

  // (10) What is the risk if wrong?
  let risk: RiskLevel
  if (input.recommendation_type === 'activate' || input.recommendation_type === 'scale' || input.recommendation_type === 'change_optimization_event' || input.recommendation_type === 'restructure' || !reversible) {
    risk = 'high'
  } else if (input.recommendation_type === 'pause' || input.recommendation_type === 'reduce_budget' || input.recommendation_type === 'change_audience') {
    risk = 'medium'
  } else {
    risk = 'low'
  }
  checks.push({ id: 10, question: 'What is the risk if wrong?', status: 'pass', note: `Risk if wrong: ${risk}${reversible ? ' (reversible)' : ' (HARD to reverse)'}.` })
  if (risk === 'high') score = Math.min(score, 0.85)

  // Per-campaign ACTUAL ROAS guard (attribution warning).
  if (input.claims_per_campaign_roas) {
    const share = input.attributed_share ?? 0
    if (share < REC_THRESHOLDS.MIN_ATTRIBUTED_SHARE) {
      warnings.attribution = `Per-campaign ROAS is UNAVAILABLE — only ${(share * 100).toFixed(0)}% of GA confirmation events are attributed to a named campaign (need ≥ ${(REC_THRESHOLDS.MIN_ATTRIBUTED_SHARE * 100).toFixed(0)}%). Fix UTMs before trusting it.`
      score = Math.min(score, 0.4)
      reasons.push('Per-campaign attribution coverage too low for an actual-ROAS claim.')
      if (isAction) hardBlock = true
    }
  }

  // Dormant account: don't diagnose performance, redirect to launch readiness.
  if (input.account_dormant && isAction) {
    checks.push({ id: 11, question: 'Is the account dormant (pre-launch)?', status: 'fail', note: 'Account is dormant — focus on launch readiness, not performance changes.' })
    reasons.push('Account dormant — performance actions are not yet meaningful.')
    hardBlock = true
    warnings.low_data = (warnings.low_data ? warnings.low_data + ' ' : '') + 'Account is dormant/pre-launch — no recent delivery to act on.'
  }

  // Track-record adjuster: TEMPER the score by this play's own history on this account. History is
  // an ADJUSTER, never the driver — a good/neutral record is not penalized (adj = 1); only a genuinely
  // below-neutral record tempers down (floored at 0.5 so it can't crush a well-grounded call). Absent ⇒
  // no change (all existing gate behavior is preserved).
  if (input.track_record && input.track_record.decisive > 0) {
    const adj = trackRecordAdjuster(input.track_record.wins, input.track_record.decisive, {
      priorWinRate: input.track_record.priorWinRate,
      k: input.track_record.k,
    })
    if (adj < 1) {
      score *= adj
      reasons.push(`Tempered by this play's own track record on this account (${input.track_record.wins}/${input.track_record.decisive} decisive wins).`)
    }
  }

  score = Math.max(0, Math.min(1, score))
  const confidence_label = labelFor(score)

  let decision: GroundingResult['decision']
  let passed: boolean
  if (hardBlock) {
    decision = isAction ? 'hold' : 'block'
    passed = false
  } else if (downgradeToHypothesis) {
    decision = 'downgrade_to_hypothesis'
    passed = false // not a confident actionable claim; it's a labeled test
  } else {
    decision = 'allow'
    passed = true
  }

  return {
    passed,
    decision,
    confidence_score: Math.round(score * 100) / 100,
    confidence_label,
    risk_level: risk,
    checks,
    reasons,
    warnings,
  }
}
