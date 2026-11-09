import { REC_THRESHOLDS } from '@/lib/recommendations/thresholds'

// The missing deterministic test: is the ad set's OPTIMIZATION EVENT firing often enough for Meta to
// ever exit the learning phase? Meta needs ~50 optimization events per ad set per 7 days
// (REC_THRESHOLDS.LEARNING_EXIT_EVENTS_PER_WEEK). If the event fires far below that SITE-WIDE — i.e. even
// if a single ad set captured 100% of it, it still couldn't reach 50/wk — then "wait for learning" is
// not the fix: the setup is structurally starved of signal. This is the number Maxx never computed; the
// "AppointmentConfirmed fires ~11/wk vs ~50/wk needed" call lived only in LLM prose.
//
// Pure + I/O-free. The caller supplies the event's actual weekly firing rate (from the pixel/dataset
// stats) and how many active ad sets share that optimization event.

export type SignalVerdict = 'sufficient' | 'marginal' | 'structurally_starved'

export interface OptimizationSignalInput {
  /** Actual SITE-WIDE firings/week of the optimization event (all sources — the generous ceiling, since
   *  only a fraction is ad-attributable). */
  eventPerWeek: number
  /** How many ACTIVE ad sets optimize for this same event (they share the site-wide volume). */
  activeAdsetsOnEvent: number
  /** Events/week per ad set needed to exit learning. Defaults to the central threshold (50). */
  threshold?: number
}

export interface OptimizationSignalResult {
  actualPerWeek: number
  activeAdsetsOnEvent: number
  /** Per-ad-set exit threshold (default 50). */
  perAdsetThreshold: number
  /** Total events/week the whole active cohort needs (threshold × active ad sets). */
  needPerWeek: number
  /** actualPerWeek ÷ needPerWeek (cohort-level). */
  ratio: number
  /** Events/week still missing to feed the whole cohort (0 when sufficient). */
  headroomPerWeek: number
  verdict: SignalVerdict
  /** Plain-English, number-carrying explanation. */
  detail: string
}

/**
 * Classify optimization-signal sufficiency.
 *   structurally_starved — event < threshold: NOT EVEN ONE ad set can exit, even capturing 100% of the
 *                          site-wide volume. Time alone cannot fix this; it needs a signal/budget/event change.
 *   marginal            — event ≥ threshold (one ad set could exit) but < the whole cohort's need
 *                          (threshold × active ad sets): consolidating signal onto fewer ad sets could work.
 *   sufficient          — event ≥ the whole cohort's need.
 */
export function classifyOptimizationSignal(input: OptimizationSignalInput): OptimizationSignalResult {
  const perAdsetThreshold = input.threshold ?? REC_THRESHOLDS.LEARNING_EXIT_EVENTS_PER_WEEK
  const actualPerWeek = Math.max(0, input.eventPerWeek)
  const activeAdsetsOnEvent = Math.max(1, Math.round(input.activeAdsetsOnEvent))
  const needPerWeek = perAdsetThreshold * activeAdsetsOnEvent
  const ratio = needPerWeek > 0 ? actualPerWeek / needPerWeek : 0
  const headroomPerWeek = Math.max(0, needPerWeek - actualPerWeek)

  let verdict: SignalVerdict
  if (actualPerWeek < perAdsetThreshold) verdict = 'structurally_starved'
  else if (actualPerWeek < needPerWeek) verdict = 'marginal'
  else verdict = 'sufficient'

  const round = (n: number) => Math.round(n)
  let detail: string
  if (verdict === 'structurally_starved') {
    detail =
      `The optimization event fires ~${round(actualPerWeek)}/week site-wide — below the ~${perAdsetThreshold}/week a SINGLE ad set ` +
      `needs to exit learning. Even if one ad set captured every firing it could not exit; ${activeAdsetsOnEvent} active ad set(s) ` +
      `split it further. This is structural, not "give it time".`
  } else if (verdict === 'marginal') {
    detail =
      `The optimization event fires ~${round(actualPerWeek)}/week site-wide — enough for one ad set (~${perAdsetThreshold}/week) but ` +
      `short of the ~${needPerWeek}/week the ${activeAdsetsOnEvent} active ad sets need together. Consolidating signal could get one out of learning.`
  } else {
    detail =
      `The optimization event fires ~${round(actualPerWeek)}/week site-wide — at or above the ~${needPerWeek}/week the ` +
      `${activeAdsetsOnEvent} active ad set(s) need to exit learning.`
  }

  return { actualPerWeek, activeAdsetsOnEvent, perAdsetThreshold, needPerWeek, ratio, headroomPerWeek, verdict, detail }
}
