/**
 * Collation rules for metric tables.
 *
 * A metric Meta never returned is UNKNOWN, not zero. Every entity table (ads, ad sets,
 * campaigns, segments) collapsed the two with `?? 0`, which has two consequences:
 *
 *   1. Sorting by a rate column put unmeasured rows at whichever end zero belongs to —
 *      so "sort by CPA, ascending" ranked every unmeasured ad as the cheapest in the
 *      account, in a table whose entire purpose is ranking.
 *   2. Totals summed rows with no delivery data as measured zeros, silently understating
 *      the account and presenting the result as complete.
 *
 * These helpers exist so the rule is stated once instead of re-derived per page.
 */

/**
 * Reads one metric column as a number, or `null` when it is unknown — either because the
 * row carries no metrics at all, or because the column itself is null (every derived rate
 * — cpa, cpl, roas, ctr, hook_rate — is nullable by design).
 */
export function metricSortValue(
  metrics: object | null | undefined,
  key: string,
): number | null {
  if (!metrics) return null
  // `object` rather than Record<string, unknown> so the metric interfaces (which have no
  // index signature) pass without every call site casting. The typeof guard is what makes
  // the read safe: a missing key and a null column both fall through to null.
  const value = (metrics as Record<string, unknown>)[key]
  return typeof value === 'number' ? value : null
}

/**
 * Comparator for a sortable column whose values may be unknown.
 *
 * Unknown is not a position on the scale, so it collates LAST in both directions rather
 * than flipping between best and worst as the operator toggles the arrow. Sorting must
 * never be able to present "we don't know" as a winner.
 */
export function compareUnknownLast(
  a: number | string | null,
  b: number | string | null,
  direction: 'asc' | 'desc',
): number {
  if (a === null && b === null) return 0
  if (a === null) return 1
  if (b === null) return -1
  if (a === b) return 0
  return (a < b ? -1 : 1) * (direction === 'asc' ? 1 : -1)
}

/** A total over rows where some rows had nothing to contribute. */
export interface MeasuredSum {
  /** Sum of the rows that carried a metrics object. */
  total: number
  /** How many rows contributed nothing because they carry no metrics at all. */
  unmeasured: number
}

/**
 * Sums one numeric column across rows, counting rows with no metrics rather than adding a
 * zero for them. Callers must surface `unmeasured` when it is non-zero: a total summed over
 * an incomplete set is not the account total, and must not be rendered as though it were.
 */
export function sumMeasured<T>(
  rows: readonly T[],
  getMetrics: (row: T) => object | null | undefined,
  key: string,
): MeasuredSum {
  let total = 0
  let unmeasured = 0
  for (const row of rows) {
    const value = metricSortValue(getMetrics(row), key)
    if (value === null) unmeasured++
    else total += value
  }
  return { total, unmeasured }
}
