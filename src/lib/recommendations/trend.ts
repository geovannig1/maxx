// N1 — reversal-class grounding fields, computed PURELY from already-synced data (no I/O; unit-tested).
//
// These feed the no-oscillation gate (no-oscillation.ts) + the grounding gate so that a WELL-GROUNDED
// scale/pause can keep its type instead of collapsing to `hold`. Every function is conservative: when
// the evidence is too thin to judge it returns `null` (= unknown ⇒ the gate keeps blocking), never a
// false `true`.

/** One delivering day for an entity, sliced from its daily_insights rows. */
export interface DailyPoint {
  spend: number
  /** cost_per_booking for the day; null when the entity had no bookings that day. */
  cpa: number | null
}

/** Coefficient of variation (σ/μ). Infinity when the mean is non-positive (treated as unstable). */
function coefficientOfVariation(vals: number[]): number {
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length
  if (mean <= 0) return Infinity
  const variance = vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length
  return Math.sqrt(variance) / mean
}

/** Above this coefficient of variation the day-to-day series is "wild" — not stable enough to reverse on. */
export const TREND_MAX_CV = 0.5
/** Minimum delivering days before we'll judge stability at all (below this ⇒ unknown). */
export const TREND_MIN_DELIVERING_DAYS = 3
/** Converting days needed to judge CPA stability (the winner case) before falling back to spend stability. */
export const TREND_MIN_CONVERTING_DAYS = 3

/**
 * Is the entity's recent trend stable (no wild day-to-day swings)?
 *   - Too few delivering days ⇒ `null` (unknown → stays blocked).
 *   - Enough converting days ⇒ judge stability on the daily CPA series (the winner/scale case).
 *   - Few/no conversions ⇒ judge on daily SPEND: steadily spending while steadily NOT converting is a
 *     stable loser (safe to pause); erratic delivery is not.
 */
export function computeTrendStable(
  days: DailyPoint[],
  opts?: { minDeliveringDays?: number; minConvertingDays?: number; maxCv?: number }
): boolean | null {
  const minDelivering = opts?.minDeliveringDays ?? TREND_MIN_DELIVERING_DAYS
  const minConverting = opts?.minConvertingDays ?? TREND_MIN_CONVERTING_DAYS
  const maxCv = opts?.maxCv ?? TREND_MAX_CV

  const delivering = days.filter((d) => d.spend > 0)
  if (delivering.length < minDelivering) return null // too thin to judge → unknown → gate keeps blocking

  const cpas = delivering.map((d) => d.cpa).filter((c): c is number => c != null && c > 0 && Number.isFinite(c))
  if (cpas.length >= minConverting) return coefficientOfVariation(cpas) <= maxCv

  return coefficientOfVariation(delivering.map((d) => d.spend)) <= maxCv
}

/** Whole days between a change's timestamp and NY-today. null when there is no known prior change. */
export function daysSinceChange(changedAtISO: string | null | undefined, today: string): number | null {
  if (!changedAtISO) return null
  const changed = new Date(changedAtISO).getTime()
  const now = new Date(today + 'T00:00:00Z').getTime()
  if (!Number.isFinite(changed) || !Number.isFinite(now)) return null
  return Math.max(0, Math.floor((now - changed) / 86_400_000))
}

/**
 * Map Meta's learning_stage_info.status to `exited_learning`.
 *   SUCCESS ⇒ true (exited) · LEARNING / LEARNING_LIMITED ⇒ false (still learning) · anything else ⇒ null.
 * Null (unknown) is conservative: the gate keeps the learning-phase confidence penalty.
 */
export function deriveExitedLearning(stage: string | null | undefined): boolean | null {
  if (!stage) return null
  const s = stage.toUpperCase()
  if (s === 'SUCCESS') return true
  if (s === 'LEARNING' || s === 'LEARNING_LIMITED') return false
  return null
}
