import { getTargetRange } from '@/lib/targets/target-ranges'
import { SPEND_FLOORS } from '@/config/spend-floors'

// Central, GROUNDED thresholds for the recommendation grounding gate and operating-mode detector.
//
// Every value here is either (a) a labeled business ASSUMPTION (target CPA / AOV — see
// MAXX_INSTRUCTIONS, these are not measured facts) or (b) an external best-practice number with a
// cited rationale. Keeping them in one file means the gate, the modes, the flag engine, and the docs
// all reference the SAME numbers instead of drifting apart.
//
// Sources for the learning-phase numbers (re-verified 2026-08-02 against primary Meta sources):
// • ~50 optimization events per ad set per 7 days to exit the learning phase — META-PUBLISHED
//   (facebook.com/business/help/112167992830700 + /269269737396981), still current.
// • ~5× the target CPA in daily budget per ad set — an INDUSTRY HEURISTIC, NOT a Meta-published rule.
//   Meta's own learning-limited guidance is qualitative (small audience / low budget / infrequent event /
//   auction overlap) and publishes NO budget-to-CPA ratio; the 5× figure is an agency rule of thumb
//   amplified by SEO content. Keep it as a useful heuristic, but every surface that renders it must
//   label it "industry heuristic", never "Meta's guidance".

export const REC_THRESHOLDS = {
  // ── Business targets (ASSUMPTIONS — always label as such, never as measured facts) ──
  //
  // GETTERS, NOT VALUES. These read the LIVE band on every access.
  //
  // They used to be `METRIC_RANGES.cpa.healthy` / `.watch` — the frozen defaults — evaluated once
  // when this module was first imported, which is before `applyTargetOverrides` has run. So an
  // owner-approved band change was silently ignored by every consumer of REC_THRESHOLDS: the
  // Settings page would save it, `getTargetRange` would return it, and the gate, the operating-mode
  // detector, the flag engine and the health route would all keep grading against the frozen defaults forever.
  //
  // That is worse than not supporting overrides at all, because everyone believes the approval took.
  // `target-ranges.ts:143` states the intended contract in as many words: an edit "re-bands the
  // whole app without changing any call sites". This restores it. Property-access syntax is
  // unchanged, so no consumer needed editing — the bug was evaluation TIME, not shape.
  // null until the owner sets a CPA target: there is no built-in amount.
  get TARGET_CPA(): number | null { return getTargetRange('cpa').healthy }, // target cost per confirmed booking
  get MAX_CPA(): number | null { return getTargetRange('cpa').watch }, // above this = losing money after overhead

  // ── Data sufficiency (how much before we'll make a confident, actionable claim) ──
  // In-window spend before a performance claim, in the account currency: NEXT_PUBLIC_MIN_SPEND_TO_JUDGE
  // (default 20), shared with the flag engine's too-early floor.
  get MIN_SPEND_TO_JUDGE(): number { return SPEND_FLOORS.judge },
  MIN_WINDOW_DAYS_REVERSAL: 3, // AppointmentConfirmed lags (7d-click); 1 bad day ≠ evidence to cut
  MIN_WINDOW_DAYS_SCALE: 7, // scaling/keeping needs a fuller week of stability
  // Count precision uses Poisson relative standard error (1/sqrt(n)): four events are still only a
  // 50%-RSE directional floor; sixteen reach 25%-RSE. Neither threshold proves causality or supplies
  // action authority — exact paid lineage, maturity, comparison and governance remain separate.
  MIN_BOOKINGS_PERF_CLAIM: 4,
  MIN_BOOKINGS_STRONG_CLAIM: 16,

  // ── Learning phase (provenance differs per number — see header) ──
  LEARNING_EXIT_EVENTS_PER_WEEK: 50, // Meta-published
  LEARNING_EXIT_BUDGET_MULTIPLE: 5, // ~5× target CPA/day per ad set — INDUSTRY HEURISTIC, not Meta-published

  // ── Data freshness ──
  MAX_DATA_AGE_HOURS: 26, // matches the dashboard's stale-data banner threshold

  // ── No-oscillation (don't reverse a change before it can have worked) ──
  MIN_DAYS_SINCE_LAST_CHANGE: 7, // conservative diagnostic floor; a CampaignPlan owns real maturity

  // ── Attribution (per-campaign ACTUAL ROAS only when GA4 attribution is real) ──
  MIN_ATTRIBUTED_SHARE: 0.5, // below this, per-campaign GA4 ROAS is unreliable — do not state it

  // ── Account activity (pre-launch / dormancy) ──
  get DORMANT_SPEND_30D(): number { return SPEND_FLOORS.judge }, // ≤ this over 30d ⇒ effectively dormant / pre-launch
  /** ZERO-OUTCOME tiers, expressed as multiples of the ACTIVE MAX_CPA so they move with the target
   *  rather than being a hardcoded amount (a maximum CPA of 100 gives 200 and 300). No tier without a target:
   *  deliberately no spend-floor fallback, since MIN_SPEND_TO_JUDGE says when data is enough to look,
   *  not how much spend without outcomes is too much for this business.
   *  Review: spend has reached 2x the worst acceptable cost per booking with nothing to show.
   *  Stop:   3x — continuing is the risk, not acting. */
  ZERO_OUTCOME_REVIEW_CPA_MULTIPLE: 2,
  ZERO_OUTCOME_STOP_CPA_MULTIPLE: 3,
  /** A cut needs a MATURED attribution window, not just spend: bookings arrive after the click. */
  MIN_MATURED_DAYS_FOR_CUT: 14,
  /** Length of the lagged evaluation period. Kept SHORT for responsiveness while the LAG stays 14:
   *  an unmeasured assumption should not be shortened for speed, but the period it measures can be. */
  LAGGED_PERIOD_DAYS: 14,
  DORMANT_DAYS_NO_DELIVERY: 7, // no delivering ad for this many days ⇒ dormant
} as const

export type RecThresholds = typeof REC_THRESHOLDS

/** Daily budget per ad set to realistically exit the learning phase, given a target CPA — the ~5×-CPA
 *  INDUSTRY HEURISTIC (not a Meta-published rule; label it as a heuristic wherever rendered).
 *  Default reads the ACTIVE target (defaults + Performance-Targets override). */
export function learningExitDailyBudget(targetCpa: number | null = getTargetRange('cpa').healthy): number | null {
  return targetCpa === null ? null : targetCpa * REC_THRESHOLDS.LEARNING_EXIT_BUDGET_MULTIPLE
}
