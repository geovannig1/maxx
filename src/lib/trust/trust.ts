// ── The Trust Engine ────────────────────────────────────────────────────────────────────────────
// The single, quantitative trust scorer for the whole app. Every confident-sounding number and every
// recommendation can be scored through THIS, so the dashboard speaks ONE trust vocabulary instead of
// the half-dozen independent "high/medium/low" judgments scattered across flags, learning, the
// trajectory predictor, the creative verdict, and the recommendation grounding gate.
//
// It does NOT invent new thresholds: it reuses REC_THRESHOLDS (the same numbers the grounding gate and
// operating-mode detector already use) so a metric's trust here agrees with a recommendation's
// confidence there. It is a pure function — deterministic, fully unit-tested — and every score carries
// its own explanation: the per-factor breakdown, the integrity ceilings that capped it, and the
// concrete GAPS that would lift it toward the bar. Nothing is a black box.
//
// The 95% "verified" bar is deliberately HARD to reach: a datum only clears it with strong volume,
// fresh data, a valid source of truth (the ledger, or an exact appointment-id join, or no revenue claim), real attribution (or no
// per-campaign claim), stability, and no integrity ceiling. Below the bar, the score still shows —
// labeled with exactly what's holding it back. That is the only honest way to claim "95% trust": a
// standard the data must clear, never a number painted on everything.

import { REC_THRESHOLDS } from '@/lib/recommendations/thresholds'
import { formatMoney, formatMoneyAmount } from '@/lib/utils/format-currency'
import { outcomeWords } from '@/config/outcome-nouns'

// What this business calls its outcomes (NEXT_PUBLIC_OUTCOME_NOUN).
const OW = outcomeWords()

/** The "safe to act on / state without caveat" threshold. A datum at or above this is `verified`. */
export const TRUST_BAR = 95

export type TrustLevel = 'verified' | 'high' | 'moderate' | 'low' | 'insufficient'

/** `ga4_actual` is retained under its historical name but now means GA CONFIRMATION-EVENT TELEMETRY —
 *  no appointment identity — and is scored accordingly. `exact_appointment_join` is the only GA-derived
 *  source that may back a money claim. */
/** ONE unambiguous vocabulary. No value may be relabelled as another — a review found `ga4_actual`
 *  being rendered as "ledger booked value", which renames the evidence instead of describing it. */
export type SourceOfTruth =
  /** outcome ledger business total: all sources (paid, organic, phone, manual). */
  | 'outcome_business_total'
  /** A ledger appointment joined to a paid GA session by EXACT appointment id over a fully covered
   *  window. The ONLY GA-derived source that may back a paid money figure. */
  | 'exact_paid_appointment_join'
  /** GA confirmation events: no appointment identity. Never bookings, revenue, CPA, ROAS or MER. */
  | 'ga4_confirmation_telemetry'
  | 'meta_modelled'
  | 'computed'

/** The raw evidence behind a number or a recommendation. Everything is optional — supply what's known;
 *  factors with no applicable evidence are marked N/A (weight 0) and don't drag the score. */
export interface TrustContext {
  // ── Volume / sample size ──
  spend?: number
  clicks?: number
  bookings?: number | null
  impressions?: number
  // ── Window & freshness ──
  windowDays?: number
  dataAgeHours?: number | null // null = unknown ⇒ treated as stale
  // ── Source of truth & attribution ──
  sourceOfTruth?: SourceOfTruth
  /** Does this datum/claim assert booking revenue or ROAS? Only then does source/attribution matter. */
  revenueClaim?: boolean
  /** A per-campaign ACTUAL-ROAS claim — needs real GA4 campaign attribution to be trusted. */
  perCampaignRoasClaim?: boolean
  /** Share of GA confirmation EVENTS tied to a named campaign (0..1). null = unknown. A telemetry
   *  coverage statistic — never evidence that a booking occurred. */
  attributionCoverage?: number | null
  // ── Stability ──
  exitedLearning?: boolean | null
  trendStable?: boolean | null
  conflictingSignal?: boolean
  // ── Cross-source agreement (reconciliation) ──
  /** |sourceA − sourceB| ÷ reference, as a percent (0 = perfect agreement). null = N/A. */
  reconVariancePct?: number | null
  // ── Account state & provenance ──
  dormant?: boolean
  /** How many concrete data sources back this (0 ⇒ unsourced). undefined = not asserted. */
  dataSourcesCount?: number
}

export interface TrustFactor {
  key: string
  label: string
  score: number // 0..1 sub-score
  weight: number // 0 ⇒ N/A (excluded from the weighted average)
  detail: string
}

export interface TrustCeiling {
  reason: string
  cap: number // 0..1 — the maximum the score was held to
}

export interface TrustScore {
  score: number // 0..100, rounded
  level: TrustLevel
  meetsBar: boolean // score ≥ TRUST_BAR
  factors: TrustFactor[]
  ceilings: TrustCeiling[] // integrity caps that actually limited the score (highest-impact first)
  gaps: string[] // concrete lifts that would move it toward the bar
  headline: string
}

// ── Helpers ──────────────────────────────────────────────────────────────────────────────────────

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n
}

/** Piecewise-linear ramp through sorted [x, y] points. Flat outside the endpoints. */
function ramp(x: number, points: ReadonlyArray<readonly [number, number]>): number {
  if (x <= points[0][0]) return points[0][1]
  const last = points[points.length - 1]
  if (x >= last[0]) return last[1]
  for (let i = 1; i < points.length; i++) {
    const [x1, y1] = points[i]
    if (x <= x1) {
      const [x0, y0] = points[i - 1]
      const t = (x - x0) / (x1 - x0)
      return y0 + t * (y1 - y0)
    }
  }
  return last[1]
}

const { MIN_SPEND_TO_JUDGE, MIN_BOOKINGS_PERF_CLAIM, MIN_BOOKINGS_STRONG_CLAIM, MIN_WINDOW_DAYS_SCALE, MAX_DATA_AGE_HOURS, MIN_ATTRIBUTED_SHARE } = REC_THRESHOLDS

export function trustLevelFor(score: number): TrustLevel {
  if (score >= TRUST_BAR) return 'verified'
  if (score >= 80) return 'high'
  if (score >= 60) return 'moderate'
  if (score >= 35) return 'low'
  return 'insufficient'
}

// ── The scorer ───────────────────────────────────────────────────────────────────────────────────

export function computeTrust(ctx: TrustContext): TrustScore {
  const factors: TrustFactor[] = []
  const ceilings: TrustCeiling[] = []
  const gaps: string[] = []

  const bookings = ctx.bookings ?? 0
  const spend = ctx.spend ?? 0
  const clicks = ctx.clicks ?? 0
  const impressions = ctx.impressions ?? 0
  const windowDays = ctx.windowDays ?? 0
  const revenueClaim = ctx.revenueClaim === true || ctx.perCampaignRoasClaim === true

  // (1) Volume — the dominant factor. Bookings drive a conversion/revenue claim; otherwise click/
  //     impression volume drives an engagement reading. Spend is a floor gate either way.
  const bookingVol = ramp(bookings, [[0, 0], [MIN_BOOKINGS_PERF_CLAIM, 0.6], [MIN_BOOKINGS_STRONG_CLAIM, 0.85], [10, 1]])
  const clickVol = ramp(clicks, [[0, 0], [50, 0.5], [100, 0.75], [500, 1]])
  // A conversion/revenue claim leans on bookings; an engagement reading takes the stronger of the two
  // (you can trust a CTR on volume of clicks even with no bookings).
  let volume = revenueClaim || bookings > 0 ? Math.max(bookingVol, revenueClaim ? 0 : clickVol) : clickVol
  if (spend < MIN_SPEND_TO_JUDGE) volume = Math.min(volume, 0.4)
  const observedOutcome =
    ctx.sourceOfTruth === 'ga4_confirmation_telemetry' ? 'GA confirmation event'
    : ctx.sourceOfTruth === 'meta_modelled' ? `Meta-modelled ${OW.one} event`
    : 'booking'
  const volDetail = revenueClaim || bookings > 0
    ? `${bookings} ${observedOutcome}${bookings === 1 ? '' : 's'} on ${formatMoney(spend, { maximumFractionDigits: 0 })} spend`
    : `${clicks} clicks / ${impressions.toLocaleString()} impr on ${formatMoney(spend, { maximumFractionDigits: 0 })} spend`
  factors.push({ key: 'volume', label: 'Data volume', score: clamp01(volume), weight: 3, detail: volDetail })

  // (2) Window length.
  const windowScore = ramp(windowDays, [[0, 0], [3, 0.6], [7, 0.9], [14, 1]])
  factors.push({ key: 'window', label: 'Window length', score: windowScore, weight: 1, detail: `${windowDays} day${windowDays === 1 ? '' : 's'} of data` })

  // (3) Freshness.
  const age = ctx.dataAgeHours
  const freshScore = age == null ? 0.4 : ramp(age, [[0, 1], [MAX_DATA_AGE_HOURS, 1], [48, 0.7], [72, 0.5], [168, 0.3]])
  factors.push({ key: 'freshness', label: 'Data freshness', score: freshScore, weight: 1, detail: age == null ? 'data age unknown' : `${age.toFixed(0)}h old` })

  // (4) Source of truth — only weighted when a revenue/outcome claim is being made (engagement metrics
  //     legitimately come from Meta, so don't penalise them here).
  if (revenueClaim) {
    const src = ctx.sourceOfTruth ?? 'meta_modelled'
    // `ga4_actual` scored a FULL 1 — identical to the outcome ledger — so a diagnostic could
    // certify GA telemetry as "Verified (100%) — safe to act on without caveat". GA confirmation
    // events carry no appointment identity: they may double-count a booking, include canceled
    // appointments, and report a comp at its nominal price. Only the LEDGER is business truth, and
    // only an EXACT appointment-id join can turn GA into a paid outcome. GA telemetry is now scored
    // BELOW a Meta modelled estimate for a revenue claim, because it looks more precise than it is.
    const srcScore = src === 'outcome_business_total' ? 1 : src === 'exact_paid_appointment_join' ? 1 : src === 'computed' ? 0.85 : src === 'meta_modelled' ? 0.6 : 0.5
    const srcDetail =
      src === 'outcome_business_total' ? 'Outcome ledger — canonical business truth'
      : src === 'exact_paid_appointment_join' ? `ledger ${OW.one} joined by exact ${OW.one} id`
      : src === 'computed' ? 'computed/derived'
      : src === 'meta_modelled' ? 'Meta pixel estimate (modelled)'
      : `GA confirmation-event TELEMETRY — no ${OW.one} identity; not ${OW.many} and not revenue`
    factors.push({ key: 'source', label: 'Source of truth', score: srcScore, weight: 2, detail: srcDetail })
  } else {
    factors.push({ key: 'source', label: 'Source of truth', score: 1, weight: 0, detail: 'engagement metric — Meta is the legitimate source (N/A)' })
  }

  // (5) Attribution — only when a per-campaign/revenue claim depends on GA4 attribution coverage. The
  //     total outcome ledger revenue is measured directly (not attribution-derived), so it is N/A there.
  if (revenueClaim && (ctx.sourceOfTruth ?? 'meta_modelled') !== 'outcome_business_total') {
    const cov = ctx.attributionCoverage
    const attrScore = cov == null ? 0.3 : ramp(cov, [[0, 0], [MIN_ATTRIBUTED_SHARE, 0.7], [0.8, 0.95], [1, 1]])
    factors.push({ key: 'attribution', label: 'Attribution coverage', score: attrScore, weight: 2, detail: cov == null ? 'attribution unknown' : `${(cov * 100).toFixed(0)}% of GA confirmation events tied to a campaign` })
  } else {
    factors.push({ key: 'attribution', label: 'Attribution coverage', score: 1, weight: 0, detail: revenueClaim ? 'Outcome ledger total — measured directly, attribution N/A' : 'no revenue/per-campaign claim (N/A)' })
  }

  // (6) Stability — trend and conflicting signals. Learning is reported separately from evidence
  // trust because delivery exploration neither validates nor invalidates a business outcome.
  let stability = 1
  const stabilityNotes: string[] = []
  if (ctx.conflictingSignal) { stability *= 0.5; stabilityNotes.push('conflicting signal') }
  if (ctx.trendStable === false) { stability *= 0.85; stabilityNotes.push('unstable trend') }
  const learningContext = ctx.exitedLearning === true ? 'exited learning' : ctx.exitedLearning === false ? 'in learning' : 'learning state unknown'
  factors.push({ key: 'stability', label: 'Stability', score: clamp01(stability), weight: 1, detail: `${stabilityNotes.length ? stabilityNotes.join(', ') : 'stable, no conflicting signal'}; ${learningContext} (delivery context only)` })

  // (7) Cross-source agreement (reconciliation) — only when a variance is known.
  if (ctx.reconVariancePct != null && isFinite(ctx.reconVariancePct)) {
    const v = Math.abs(ctx.reconVariancePct)
    const agreeScore = ramp(v, [[0, 1], [5, 0.9], [10, 0.7], [20, 0.5], [40, 0.2]])
    factors.push({ key: 'agreement', label: 'Cross-source agreement', score: agreeScore, weight: 1, detail: `${v.toFixed(1)}% variance across sources` })
  } else {
    factors.push({ key: 'agreement', label: 'Cross-source agreement', score: 1, weight: 0, detail: 'no cross-source check available (N/A)' })
  }

  // ── Weighted average over applicable factors ──
  const applicable = factors.filter((f) => f.weight > 0)
  const wsum = applicable.reduce((s, f) => s + f.weight, 0)
  const base = wsum > 0 ? applicable.reduce((s, f) => s + f.weight * f.score, 0) / wsum : 0

  // ── Integrity ceilings (hard caps — mirror the grounding gate so trust agrees with it) ──
  function cap(cond: boolean, reason: string, c: number) {
    if (cond) ceilings.push({ reason, cap: c })
  }
  cap(ctx.dormant === true, 'Account is dormant / pre-launch — no recent delivery to trust.', 0.25)
  cap(ctx.dataSourcesCount === 0, 'No concrete data source cited (unsourced).', 0.3)
  cap(revenueClaim && (ctx.sourceOfTruth ?? 'meta_modelled') === 'meta_modelled', `Revenue/ROAS leans on Meta MODELLED attribution, which can under- or over-attribute relative to business truth. The outcome ledger is the business truth; a paid figure needs an exact ${OW.one}-id join.`, 0.6)
  // A revenue claim resting on GA telemetry is capped HARD: it can never read as verified, because the
  // underlying events cannot be deduplicated, cancel-checked or valued.
  cap(revenueClaim && (ctx.sourceOfTruth ?? 'meta_modelled') === 'ga4_confirmation_telemetry', `Revenue/ROAS rests on GA CONFIRMATION-EVENT TELEMETRY with no ${OW.one} identity — it cannot be deduplicated against the ledger, checked against cancel state, or valued. This is not a money figure.`, 0.45)
  cap(ctx.perCampaignRoasClaim === true && (ctx.attributionCoverage ?? 0) < MIN_ATTRIBUTED_SHARE, `Per-campaign ROAS: only ${((ctx.attributionCoverage ?? 0) * 100).toFixed(0)}% attribution coverage (< ${(MIN_ATTRIBUTED_SHARE * 100).toFixed(0)}%).`, 0.4)
  cap(spend < MIN_SPEND_TO_JUDGE, `Only ${formatMoney(spend, { maximumFractionDigits: 0 })} spend (< ${formatMoneyAmount(MIN_SPEND_TO_JUDGE)} to judge).`, 0.5)
  cap(revenueClaim && ctx.bookings != null && ctx.bookings < MIN_BOOKINGS_PERF_CLAIM, `Only ${bookings} ${OW.many} (< ${MIN_BOOKINGS_PERF_CLAIM} for a confident verdict).`, 0.6)
  cap(age == null || (age != null && age > MAX_DATA_AGE_HOURS), age == null ? 'Data age unknown — re-sync before trusting.' : `Data is ${age.toFixed(0)}h old (> ${MAX_DATA_AGE_HOURS}h) — re-sync.`, 0.7)
  // Thin OR unknown window: 0/unset must not be MORE trusted than a known-short window of 1–2 days.
  cap(windowDays < 3, windowDays <= 0 ? 'Window length unknown — not enough to confirm a trend.' : `Only ${windowDays}d of data — one or two days is not a trend.`, 0.6)
  // Engagement-only data (no revenue/outcome to corroborate it) cannot clear the "verified" bar — a
  // delivery signal like CTR can be strong, but "safe to act WITHOUT caveat" requires an outcome.
  cap(!revenueClaim && bookings === 0, `Engagement-only metric — no ${OW.one}/revenue outcome corroborates it; a delivery signal alone can't be "verified".`, 0.9)

  ceilings.sort((a, b) => a.cap - b.cap)
  let score01 = base
  for (const c of ceilings) score01 = Math.min(score01, c.cap)
  score01 = clamp01(score01)
  const score = Math.round(score01 * 100)
  const level = trustLevelFor(score)

  // ── Gaps: what would lift it toward the bar (concrete, grounded) ──
  if (level !== 'verified') {
    if (ctx.dormant) gaps.push('Account needs to start delivering (currently dormant/pre-launch).')
    if (spend < MIN_SPEND_TO_JUDGE) gaps.push(`Spend more than ${formatMoneyAmount(MIN_SPEND_TO_JUDGE)} in-window (have ${formatMoney(spend, { maximumFractionDigits: 0 })}).`)
    if (revenueClaim && bookings < MIN_BOOKINGS_STRONG_CLAIM) gaps.push(`Reach ≥ ${MIN_BOOKINGS_STRONG_CLAIM} ${OW.many} (have ${bookings}).`)
    if (windowDays > 0 && windowDays < MIN_WINDOW_DAYS_SCALE) gaps.push(`Let it run to ≥ ${MIN_WINDOW_DAYS_SCALE} days (have ${windowDays}).`)
    if (age == null) gaps.push('Re-sync so data age is known and fresh.')
    else if (age > MAX_DATA_AGE_HOURS) gaps.push(`Re-sync — data is ${age.toFixed(0)}h old.`)
    if (revenueClaim && (ctx.sourceOfTruth ?? 'meta_modelled') === 'meta_modelled') gaps.push('Use the recorded collected value from the outcome ledger, not the Meta pixel estimate; keep scheduled booked value separate.')
    if (revenueClaim && (ctx.sourceOfTruth ?? 'meta_modelled') === 'ga4_confirmation_telemetry') gaps.push(`Join GA events to the outcome ledger by ${OW.one} id — GA telemetry alone cannot support a money claim.`)
    if (ctx.perCampaignRoasClaim && (ctx.attributionCoverage ?? 0) < MIN_ATTRIBUTED_SHARE) gaps.push(`Lift campaign attribution coverage to ≥ ${(MIN_ATTRIBUTED_SHARE * 100).toFixed(0)}% (fix UTMs).`)
    if (ctx.conflictingSignal) gaps.push('Resolve the conflicting signal across sources.')
    if (ctx.reconVariancePct != null && Math.abs(ctx.reconVariancePct) > 10) gaps.push(`Close the ${Math.abs(ctx.reconVariancePct).toFixed(0)}% gap between sources.`)
  }

  const headline = buildHeadline(score, level, ceilings, gaps)
  return { score, level, meetsBar: score >= TRUST_BAR, factors, ceilings, gaps, headline }
}

function buildHeadline(score: number, level: TrustLevel, ceilings: TrustCeiling[], gaps: string[]): string {
  const pct = `${score}%`
  if (level === 'verified') return `Verified (${pct}) — safe to act on without caveat.`
  const limiter = ceilings[0]?.reason ?? gaps[0] ?? 'not enough corroborating data yet'
  if (level === 'high') return `High trust (${pct}) — solid, with a caveat: ${limiter}`
  if (level === 'moderate') return `Moderate (${pct}) — directional only. ${limiter}`
  if (level === 'low') return `Low (${pct}) — treat as a weak signal. ${limiter}`
  return `Insufficient (${pct}) — not enough to trust. ${limiter}`
}
