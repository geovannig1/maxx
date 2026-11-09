// Cron time-budget guard. The nightly pipeline (src/app/api/cron/daily-sync/route.ts) runs
// under a single Vercel function with maxDuration=300s. Two LLM-heavy enrichment steps — the Monday
// signals fetcher and competitor-ad analysis — can consume the whole budget, starving the CRITICAL
// "brain" steps ordered after them (champion watch, drift guardrail, learning, recommendations, weekly
// report, monitoring). This guard lets the pipeline SKIP optional enrichment once the run is close to
// the cap, so the critical tail always gets to run. Pure + injectable clock for tests.

/** Vercel function ceiling for the cron route (must match `maxDuration` in the route). */
export const CRON_MAX_MS = 300_000

/** Wall-clock kept in reserve for the CRITICAL brain tail (champion watch, drift, learning,
 *  recommendations, the Monday weekly-report LLM narrative, monitoring). Once fewer than this many ms
 *  remain, optional LLM-heavy enrichment is skipped rather than risk the tail. */
export const CRON_CRITICAL_RESERVE_MS = 90_000

/** True when too little of the function budget remains to safely start another OPTIONAL enrichment step.
 *  Critical steps never call this — they always run. */
export function budgetExceeded(
  startedAtMs: number,
  nowMs: number,
  reserveMs: number = CRON_CRITICAL_RESERVE_MS,
  capMs: number = CRON_MAX_MS,
): boolean {
  return nowMs - startedAtMs > capMs - reserveMs
}

/** The rejection `withTimeout` produces, so a caller can tell "we stopped waiting" from a real failure. */
export class OperationTimeoutError extends Error {
  constructor(label: string, ms: number) {
    super(`${label} timed out after ${ms}ms`)
    this.name = 'OperationTimeoutError'
  }
}

/** Race a promise against a timeout. On timeout the returned promise REJECTS (callers already treat an
 *  LLM error as non-fatal), so a single slow provider call can't stall the whole cron. The underlying
 *  promise is abandoned, not cancelled — acceptable: we only need to stop waiting. */
export function withTimeout<T>(promise: Promise<T>, ms: number, label = 'operation'): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new OperationTimeoutError(label, ms)), ms)
    promise.then(
      (v) => { clearTimeout(timer); resolve(v) },
      (e) => { clearTimeout(timer); reject(e) },
    )
  })
}
