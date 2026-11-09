// Upgraded learning-model primitives — pure, deterministic, unit-tested. These address the structural
// weaknesses of the current learning half (see the stress-test plan §3):
//   no shrinkage  → shrinkRate / shrinkMean (small samples pulled toward a prior)
//   no recency    → recencyWeight (exponential half-life)
//   noisy bar     → decisiveCpaVsTarget (variance-aware: a 2-booking CPA can't flip a verdict)
//   loop never closes deterministically → trackRecordMultiplier (history floors/caps a score)
//   no benchmark separation → BenchmarkPrior + resolvePrior (cross-niche data is a WEAK, LABELED
//        prior only; Aroma360 / HotelCollection plug in here, NEVER summed into account history)
//
// WIRING STATUS (corrected by the full-scale audit — the old note here was stale):
//   WIRED into live behavior: estimate↔actual reconciliation (scoreFlag), decisiveCpaVsTarget (outcome scorers
//     plus the final paid-cohort directional policy), trackRecordAdjuster [tuned form, in grounding-gate.ts,
//     tempers DOWN only], resolvePrior/BenchmarkPrior (knowledge.ts).
//   WIRED: recencyWeight → tallyTrackRecord
//     (old lessons fade, half-life 17d); shrinkMean → patterns.judge() (segment CPAs shrunk toward
//     the CHAMPION prior — account history, src/lib/economics/champion.ts — so 1-booking extremes can't
//     earn confident verdicts).
//   NOT wired: the raw trackRecordMultiplier (superseded by trackRecordAdjuster).

/** Exponential recency weight: 1.0 at age 0, 0.5 at one half-life, → 0 as age grows. */
export function recencyWeight(ageDays: number, halfLifeDays = 17): number {
  if (!isFinite(ageDays) || ageDays <= 0) return 1
  if (halfLifeDays <= 0) return 0
  return Math.pow(0.5, ageDays / halfLifeDays)
}

/** Shrink an observed rate (successes/trials) toward a prior using a pseudo-count k (Beta-Binomial).
 *  Small `trials` ⇒ posterior stays near the prior; large `trials` ⇒ posterior approaches observed. */
export function shrinkRate(successes: number, trials: number, priorRate: number, k = 5): number {
  if (trials <= 0) return priorRate
  return (successes + k * priorRate) / (trials + k)
}

/** Shrink an observed mean (e.g. CPA) toward a prior mean, weighted by sample size n vs strength k. */
export function shrinkMean(observed: number, n: number, priorMean: number, k = 3): number {
  if (n <= 0) return priorMean
  return (n * observed + k * priorMean) / (n + k)
}

/** ~90% Poisson interval for an observed count (e.g. bookings), via a continuity-corrected normal
 *  approximation. Used to bound CPA so a tiny sample can't be called decisive. */
export function poissonCountCI(count: number): { lo: number; hi: number } {
  const sd = Math.sqrt(Math.max(count, 1))
  return { lo: Math.max(0, count - 1.645 * sd), hi: count + 1.645 * sd }
}

/** Is an observed CPA DECISIVELY better/worse than a target — accounting for booking-count noise?
 *  Returns 'better' only if even the pessimistic CPA beats target, 'worse' only if even the optimistic
 *  CPA misses it, else 'inconclusive'. Fixes the "2 bookings flips worked↔failed" problem. */
export function decisiveCpaVsTarget(spend: number, bookings: number, target: number): 'better' | 'worse' | 'inconclusive' {
  if (bookings <= 0 || spend <= 0 || target <= 0) return 'inconclusive'
  const { lo, hi } = poissonCountCI(bookings)
  if (lo <= 0) return 'inconclusive' // CI includes zero bookings → CPA unbounded above
  const cpaBest = spend / hi // most bookings ⇒ lowest CPA
  const cpaWorst = spend / lo // fewest bookings ⇒ highest CPA
  if (cpaWorst < target) return 'better'
  if (cpaBest > target) return 'worse'
  return 'inconclusive'
}

/** A LABELED external-benchmark prior from a DIFFERENT business/niche (e.g. Aroma360, HotelCollection).
 *  Carried separately and only ever consumed by resolvePrior as a weak prior — never blended into
 *  Example Studio's own learned history. */
export interface BenchmarkPrior {
  source: 'benchmark'
  niche: string
  cpa: number
  winRate: number
  /** Pseudo-count strength. Keep LOW — a different niche is weak evidence, not an equal input. */
  strength: number
}

/** Resolve which prior to shrink toward. The account's OWN history wins; a benchmark is only a fallback
 *  and at a discounted strength (cross-niche data never carries account-equal weight). */
export function resolvePrior(
  accountPrior: number | null | undefined,
  benchmark: BenchmarkPrior | null | undefined,
  field: 'cpa' | 'winRate',
): { mean: number; k: number; source: 'account' | 'benchmark' | 'neutral' } {
  if (accountPrior != null && isFinite(accountPrior)) return { mean: accountPrior, k: 3, source: 'account' }
  if (benchmark) return { mean: field === 'cpa' ? benchmark.cpa : benchmark.winRate, k: Math.min(benchmark.strength, 2), source: 'benchmark' }
  return { mean: field === 'winRate' ? 0.5 : 0, k: 1, source: 'neutral' }
}

/** Track-record multiplier in [floor, 1]: scale a recommendation's confidence/score by its historical
 *  win-rate, shrunk so a thin record can't dominate. A rec type that has repeatedly failed on THIS
 *  account is down-weighted; one that consistently works is not penalized. Lets "history is one input"
 *  be literally true in code while best-practice still leads. */
export function trackRecordMultiplier(
  wins: number,
  decisive: number,
  opts: { floor?: number; priorWinRate?: number; k?: number } = {},
): number {
  const floor = opts.floor ?? 0.5
  const prior = opts.priorWinRate ?? 0.5
  const k = opts.k ?? 4
  const shrunk = shrinkRate(wins, decisive, prior, k) // 0..1, pulled toward 0.5 when thin
  return floor + (1 - floor) * shrunk
}

/** Gate-facing, TUNED form of the track record: history is an ADJUSTER, never the driver (owner
 *  directive). Returns exactly 1.0 when this account's shrunk win-rate for a play is at/above the prior
 *  (neutral-or-better) — a good or neutral record is NEVER penalized — and tempers DOWN toward `floor`
 *  only for a genuinely below-neutral record (a play that keeps failing here). Thin records shrink
 *  toward the prior, so a couple of losses can't crush a well-grounded call. This is the fix for the
 *  raw multiplier's over-suppression (it deflated even winning/neutral records); `resolvePrior` supplies
 *  the prior so a registered cross-niche benchmark can set the neutral point when there's no account
 *  history (account always wins; benchmark discounted). No record ⇒ 1.0 ⇒ no change. */
export function trackRecordAdjuster(
  wins: number,
  decisive: number,
  opts: { priorWinRate?: number; k?: number; floor?: number } = {},
): number {
  const prior = opts.priorWinRate ?? 0.5
  const k = opts.k ?? 4
  const floor = opts.floor ?? 0.5
  if (decisive <= 0) return 1
  const shrunk = shrinkRate(wins, decisive, prior, k) // 0..1, thin records pulled toward the prior
  if (shrunk >= prior) return 1 // neutral-or-better ⇒ no penalty
  return floor + (1 - floor) * (shrunk / prior) // below neutral ⇒ temper toward the floor
}
