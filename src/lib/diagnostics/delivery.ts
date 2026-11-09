import type { DeliveryDay } from '@/lib/insights/first-delivery'
import { REC_THRESHOLDS } from '@/lib/recommendations/thresholds'
import {
  unavailableDeliverySubStatusEvidence,
  type DeliverySubStatusEvidence,
} from '@/lib/platforms/meta/delivery-sub-status'
import { formatMoneyAmount, roundMoney } from '@/lib/utils/format-currency'

// PER-AD-SET DELIVERY SIGNALS — the narration layer Meta's own chat leads with ("2 outcomes, needs 48
// more to exit learning", "your audience is narrow", "spending up to 175% of your daily budget on some
// days"), computed deterministically from synced data so Maxx can say the same things WITH sources.
//
// Three hard labeling rules, enforced by construction here:
//  1. `learning_conversions` is Meta's ATTRIBUTION-SCOPED learning counter — it resets on significant
//     edits (that's why `last_sig_edit` rides along). It is never window results, and never a GA
//     confirmation-event count.
//  2. Audience-size verdicts are an INFERENCE from the synced targeting spec; optional MAU bounds come
//     from the delivery_estimate edge and are labeled as such — NEVER Ads Manager's internal
//     audience-size bucket (a different estimator we cannot read).
//  3. The budget-constrained flag is a labeled heuristic over daily spend ÷ daily budget.
//
// Pure + I/O-free: fully unit-testable; the impure gatherer in launch-performance.ts feeds it.

export interface AdsetDeliverySignalsInput {
  /** Exact Meta ad-set id when the gatherer observed it. */
  id?: string
  name: string
  /** Meta learning_stage_info.status: LEARNING | LEARNING_LIMITED | SUCCESS | null. */
  learningStage: string | null
  /** Meta learning_stage_info.conversions (attribution-scoped; resets on significant edits). */
  learningConversions: number | null
  /** ISO timestamp of the last significant edit (the counter resets from this moment). */
  lastSigEditTs: string | null
  dailyBudget: number | null
  /** Inclusive lower bound of the fetched spend window. Required to prove that spend fully covers
   *  the learning counter period when the last significant edit predates the normal report window. */
  dataWindowStart?: string | null
  /** Daily spend series for the window (any order; zero-spend days allowed). */
  days: DeliveryDay[]
  /** Synced Meta targeting spec (adsets.targeting jsonb). Null when not synced. */
  targeting: Record<string, unknown> | null
  /** adsets.targeting_optimization_types — the sibling ad-set field reporting what Meta ACTUALLY
   *  relaxed, e.g. [{key:'lookalike',value:1}]. Outranks the configured spec when present.
   *  Null/undefined = Meta reported nothing, which is NOT the same as "relaxed nothing". */
  targetingRelaxation?: Array<{ key: string; value: number }> | null
  /** Current persisted result of Meta's optional delivery_sub_status read. */
  deliverySubStatus?: DeliverySubStatusEvidence
  /** Optional delivery_estimate MAU bounds (from fetch-delivery-estimate). */
  mauBounds?: { lower: number; upper: number } | null
}

export const MAU_BOUNDS_LABEL =
  "delivery_estimate MAU bounds — NOT Ads Manager's audience-size bucket"

export interface AdsetDeliverySignals {
  /** Exact Meta ad-set id when available; never synthesized from the display name. */
  id?: string
  name: string
  /** Raw Meta stage: LEARNING | LEARNING_LIMITED | SUCCESS | null. */
  learning_phase: string | null
  /** Meta's learning counter — attribution-scoped, resets on significant edits. Null when unknown. */
  learning_conversions: number | null
  /** max(0, 50 − counter): optimization events still needed to exit learning. Null when counter unknown
   *  or already exited (SUCCESS). */
  results_to_exit: number | null
  /** ISO timestamp the counter resets from — always narrate the counter WITH this context. */
  last_sig_edit: string | null
  narrow_audience: {
    /** true = inferred narrow; false = inferred broad/expanded; null = targeting not synced. */
    narrow: boolean | null
    /** Where the verdict comes from (always an inference, never Ads Manager's bucket). */
    basis: string
    mau_bounds?: { lower: number; upper: number; label: string }
  }
  budget_constrained: {
    /** Heuristic: median delivering-day spend ≥ 95% of daily budget (spending at/over cap most days). */
    flag: boolean
    /** Highest single-day spend as % of daily budget (the "up to 175% on some days" stat). */
    max_day_overshoot_pct: number | null
    median_day_pct: number | null
  }
  /** Can this ad set reach the ~50 events/week learning exit at its current budget, or is waiting
   *  arithmetically futile? `results_to_exit` alone implies waiting suffices; often it does not. */
  learning_exit_feasibility: {
    /** Spend since the last significant edit ÷ Meta's learning counter. Null when no events yet. */
    cost_per_optimization_event: number | null
    /** (daily budget × 7) ÷ cost per event. */
    events_per_week_at_current_budget: number | null
    /** (50 × cost per event) ÷ 7 — what the budget would have to be. */
    required_daily_budget_for_exit: number | null
    /** Null = unknowable or not applicable (already exited). Never guessed. */
    reachable_at_current_budget: boolean | null
    basis: string
  }
  /** Meta's published Learning-Limited causes that plausibly apply [meta_official: learning-limited-causes]. */
  cause_hints: string[]
  /** Exact Meta evidence. Omission and unavailability remain distinct. */
  delivery_sub_status: DeliverySubStatusEvidence
}

const round1 = (n: number) => Math.round(n * 10) / 10
const round2 = (n: number) => Math.round(n * 100) / 100

/** Is the ~50-events/week learning exit arithmetically reachable at this budget?
 *
 *  `results_to_exit` says "48 more", which reads as "keep waiting". Whether waiting can ever work is
 *  a different question, and it is the one that matters at low volume: at ~$70 per optimization
 *  event (an example cost), a $50/day ad set produces ~5 events/week against ~50 needed.
 *
 *  Cost per event is scoped to spend SINCE THE LAST SIGNIFICANT EDIT because that is exactly the
 *  period Meta's learning counter covers — it resets on edits. Charging window spend against a
 *  counter that reset mid-window would overstate cost per event and understate feasibility. */
function assessLearningExitFeasibility(
  input: AdsetDeliverySignalsInput,
  exited: boolean,
): AdsetDeliverySignals['learning_exit_feasibility'] {
  const none = {
    cost_per_optimization_event: null,
    events_per_week_at_current_budget: null,
    required_daily_budget_for_exit: null,
    reachable_at_current_budget: null,
  }
  if (exited) return { ...none, basis: 'not applicable — already exited learning' }

  const events = input.learningConversions
  if (events == null) return { ...none, basis: 'unknown — Meta reported no learning counter' }
  if (events <= 0) {
    return { ...none, basis: 'unknown — no optimization events recorded since the last significant edit' }
  }

  // Scope spend to the counter's reset. Unknown reset ⇒ whole window, said out loud.
  const editDay = input.lastSigEditTs ? input.lastSigEditTs.slice(0, 10) : null
  if (editDay && input.dataWindowStart && editDay < input.dataWindowStart) {
    return {
      ...none,
      basis:
        `unknown — spend coverage is incomplete: the learning counter starts on ${editDay}, ` +
        `before the fetched window starts on ${input.dataWindowStart}`,
    }
  }
  const scoped = editDay ? input.days.filter((d) => d.date >= editDay) : input.days
  const scopedSpend = scoped.reduce((sum, d) => sum + d.spend, 0)
  const scopeNote = editDay
    ? 'spend since the last significant edit (the counter resets there)'
    : 'spend over the whole window — no significant-edit timestamp, so the counter period is unverified'

  if (scopedSpend <= 0) return { ...none, basis: `unknown — no ${scopeNote}` }

  const costPerEvent = roundMoney(scopedSpend / events)
  const target = REC_THRESHOLDS.LEARNING_EXIT_EVENTS_PER_WEEK
  const requiredDaily = roundMoney((target * costPerEvent) / 7)

  if (input.dailyBudget == null || input.dailyBudget <= 0) {
    return {
      cost_per_optimization_event: costPerEvent,
      events_per_week_at_current_budget: null,
      required_daily_budget_for_exit: requiredDaily,
      reachable_at_current_budget: null,
      basis: `${formatMoneyAmount(costPerEvent)}/event from ${scopeNote}; no daily budget on this ad set (CBO?), so reachability is unknown`,
    }
  }

  const eventsPerWeek = round2((input.dailyBudget * 7) / costPerEvent)
  return {
    cost_per_optimization_event: costPerEvent,
    events_per_week_at_current_budget: eventsPerWeek,
    required_daily_budget_for_exit: requiredDaily,
    reachable_at_current_budget: eventsPerWeek >= target,
    basis:
      `${formatMoneyAmount(costPerEvent)}/event from ${scopeNote}; at ${formatMoneyAmount(input.dailyBudget)}/day that is ` +
      `~${eventsPerWeek} events/week against ~${target} needed, so exit would require ~${formatMoneyAmount(requiredDaily)}/day`,
  }
}

function median(sorted: number[]): number {
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

/** Narrow-audience INFERENCE from the synced targeting spec: a custom-audience (retargeting) pool with
 *  no lookalike/expansion is a small pool by construction. Never claims Ads Manager's internal bucket.
 *
 *  Every check below reads a VALUE. This previously regex-matched key NAMES over
 *  JSON.stringify(targeting), which silently broke the whole inference: Meta returns
 *  `targeting_automation` on every modern ad set regardless of whether expansion is on, so the
 *  substring always matched, `narrow: true` became unreachable against real payloads, and the
 *  "Small audience" learning-limited cause could never fire. Presence of a key says nothing —
 *  only its value does. */
function inferNarrowAudience(
  targeting: Record<string, unknown> | null,
  relaxation?: Array<{ key: string; value: number }> | null,
): { narrow: boolean | null; basis: string } {
  if (!targeting) return { narrow: null, basis: 'unknown — targeting not synced' }

  // 1. AUTHORITATIVE — what Meta reports it ACTUALLY relaxed outranks what was configured. A value
  //    of 0 means "relaxed nothing" and must not broaden the verdict.
  const relaxed = (relaxation ?? []).filter((r) => r && r.value > 0).map((r) => r.key)
  if (relaxed.length > 0) {
    return {
      narrow: false,
      basis: `Meta relaxed: ${relaxed.join(', ')} — observed delivery, overrides the configured spec`,
    }
  }

  const custom = targeting['custom_audiences']
  const audiences = Array.isArray(custom) ? custom : []
  if (audiences.length === 0) {
    return { narrow: false, basis: 'targeting-inference: broad/interest targeting (no custom audiences)' }
  }

  // 2. Modern spec: targeting_automation.advantage_audience is 0 or 1 — the key rides along either way.
  const automation = targeting['targeting_automation']
  const advantageOn =
    typeof automation === 'object' &&
    automation !== null &&
    (automation as Record<string, unknown>)['advantage_audience'] === 1
  if (advantageOn) {
    return { narrow: false, basis: 'targeting-inference: custom audiences with Advantage+ audience expansion ON' }
  }

  // 3. Legacy spec: older ad sets carry targeting_optimization: "expansion_all" instead of the above.
  const legacy = targeting['targeting_optimization']
  if (typeof legacy === 'string' && legacy !== '' && legacy !== 'none') {
    return { narrow: false, basis: `targeting-inference: legacy expansion (targeting_optimization="${legacy}")` }
  }

  // 4. A lookalike in the pool genuinely broadens it — but this matches an OWNER-AUTHORED audience
  //    name, so it is labeled as such and never presented as a Meta relaxation signal.
  const hasLookalike = audiences.some((a) => {
    const name = (a as Record<string, unknown> | null)?.['name']
    return typeof name === 'string' && /lookalike/i.test(name)
  })
  if (hasLookalike) {
    return { narrow: false, basis: 'targeting-inference: pool includes a lookalike audience (matched on audience name)' }
  }

  return { narrow: true, basis: 'targeting-inference: custom-audience retargeting pool, no expansion' }
}

/** PURE: assemble the per-ad-set delivery signals Meta's chat narrates — with honest labels. */
export function buildAdsetDeliverySignals(input: AdsetDeliverySignalsInput): AdsetDeliverySignals {
  const exitTarget = REC_THRESHOLDS.LEARNING_EXIT_EVENTS_PER_WEEK
  const exited = input.learningStage === 'SUCCESS'
  const results_to_exit =
    input.learningConversions == null || exited ? null : Math.max(0, exitTarget - input.learningConversions)

  // ── Budget overshoot: delivering days only (zero-spend days say nothing about the cap) ──
  let budget_constrained: AdsetDeliverySignals['budget_constrained'] = {
    flag: false,
    max_day_overshoot_pct: null,
    median_day_pct: null,
  }
  if (input.dailyBudget && input.dailyBudget > 0) {
    const pcts = input.days
      .filter((d) => d.spend > 0)
      .map((d) => (d.spend / input.dailyBudget!) * 100)
      .sort((a, b) => a - b)
    if (pcts.length > 0) {
      const med = median(pcts)
      budget_constrained = {
        flag: med >= 95,
        max_day_overshoot_pct: round1(pcts[pcts.length - 1]),
        median_day_pct: round1(med),
      }
    }
  }

  const learning_exit_feasibility = assessLearningExitFeasibility(input, exited)

  const narrowBase = inferNarrowAudience(input.targeting, input.targetingRelaxation)
  const narrow_audience: AdsetDeliverySignals['narrow_audience'] = input.mauBounds
    ? { ...narrowBase, mau_bounds: { lower: input.mauBounds.lower, upper: input.mauBounds.upper, label: MAU_BOUNDS_LABEL } }
    : narrowBase

  // ── Cause hints: Meta's published Learning-Limited causes that the data here makes plausible ──
  const cause_hints: string[] = []
  if (input.learningStage === 'LEARNING' || input.learningStage === 'LEARNING_LIMITED') {
    if (narrow_audience.narrow === true) {
      cause_hints.push('Small audience: custom-audience retargeting pool [meta_official: learning-limited-causes]')
    }
    if (results_to_exit != null && results_to_exit > 0 && input.dailyBudget != null) {
      cause_hints.push(
        `Low budget / infrequent optimization event: ${input.learningConversions} of ~${exitTarget} events counted since the last significant edit [meta_official: learning-limited-causes]`,
      )
    }
    if (budget_constrained.flag) {
      cause_hints.push('Budget-constrained delivery: spending at/over the daily budget most delivering days (heuristic)')
    }
  }

  return {
    ...(input.id ? { id: input.id } : {}),
    name: input.name,
    learning_phase: input.learningStage,
    learning_conversions: input.learningConversions,
    results_to_exit,
    last_sig_edit: input.lastSigEditTs,
    narrow_audience,
    budget_constrained,
    learning_exit_feasibility,
    cause_hints,
    delivery_sub_status: input.deliverySubStatus ?? unavailableDeliverySubStatusEvidence(),
  }
}
