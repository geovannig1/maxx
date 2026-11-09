// Period-over-period comparison helpers. The prior period is the equal-length window immediately
// before the selected one (last 30d → the 30d before that), so "vs prior" deltas are apples-to-apples.

export interface DeltaResult {
  value: number // signed percent change
  direction: 'up' | 'down' | 'flat'
}

const MS_PER_DAY = 86_400_000

function parseUTC(d: string): number {
  return Date.parse(`${d}T00:00:00Z`)
}

function toISO(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

/** Inclusive day count of a [from, to] window. */
export function rangeLengthDays(from: string, to: string): number {
  return Math.max(1, Math.round((parseUTC(to) - parseUTC(from)) / MS_PER_DAY) + 1)
}

/** The equal-length window ending the day before `from`. */
export function priorPeriod(from: string, to: string): { from: string; to: string } {
  const len = rangeLengthDays(from, to)
  const prevToMs = parseUTC(from) - MS_PER_DAY
  const prevFromMs = prevToMs - (len - 1) * MS_PER_DAY
  return { from: toISO(prevFromMs), to: toISO(prevToMs) }
}

/**
 * Percent change of `current` vs `previous`.
 *   lowerIsBetter=false → a rise is 'up' (green in KpiCard). Use for leads, revenue, CTR, ROAS…
 *   lowerIsBetter=true  → a rise is 'down' (red). Use for CPL, CPC, CPM, CPA, frequency, bounce…
 * Returns undefined when a delta can't be computed (missing data or no prior baseline).
 */
export function computeDelta(
  current: number | null | undefined,
  previous: number | null | undefined,
  lowerIsBetter = false
): DeltaResult | undefined {
  if (current == null || previous == null || !isFinite(current) || !isFinite(previous) || previous === 0) {
    return undefined
  }
  const pct = ((current - previous) / previous) * 100
  if (Math.abs(pct) < 0.5) return { value: 0, direction: 'flat' }
  const rose = pct > 0
  const direction: 'up' | 'down' = lowerIsBetter ? (rose ? 'down' : 'up') : (rose ? 'up' : 'down')
  return { value: pct, direction }
}

/** A short "vs prior 7d / 30d / month" label for a window length. */
export function comparisonLabel(from: string, to: string): string {
  const len = rangeLengthDays(from, to)
  if (len === 7) return 'vs prior 7d'
  if (len === 30 || len === 31) return 'vs prior month'
  if (len === 1) return 'vs prior day'
  return `vs prior ${len}d`
}
