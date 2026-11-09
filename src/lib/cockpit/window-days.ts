import type { WindowDayState } from '@/lib/cockpit/series-contract'

/**
 * Deciding what an ABSENT day means.
 *
 * Meta returns no insight row both for a day with no delivery and for a day that was never
 * fetched. The silence is identical; the meanings are opposite. Absence alone therefore proves
 * nothing, and this module never infers from it.
 *
 * The proof is sync coverage: if a SUCCESSFUL sync asked Meta for a date range containing the day
 * and no row came back, Meta has affirmatively reported no delivery. Without such a sync the day
 * is simply unknown, and says so.
 *
 * This is deliberately fail-closed — an unproven day degrades to `missing_not_synced`, never to a
 * confident zero.
 */

const DAY_MS = 86_400_000
const toUtc = (iso: string) => Date.parse(`${iso}T00:00:00Z`)
const addDays = (iso: string, n: number) => new Date(toUtc(iso) + n * DAY_MS).toISOString().slice(0, 10)

export interface DailyValueRow {
  /** `YYYY-MM-DD`, the account-day the value belongs to. */
  date: string
  value: number
}

/** A sync attempt and the date range it asked Meta for. Only successful attempts prove anything. */
export interface SyncAttempt {
  dateRangeStart: string | null
  dateRangeEnd: string | null
  status: string
}

export interface ClassifiedDay {
  date: string
  value: number | null
  state: WindowDayState
}

export function enumerateDays(start: string, end: string): string[] {
  if (start > end) return []
  const days: string[] = []
  for (let day = start; day <= end; day = addDays(day, 1)) days.push(day)
  return days
}

/**
 * Collapse successful sync attempts into the set of days Meta was actually asked about.
 * A failed or partial attempt proves nothing and is discarded.
 */
export function provenCoveredDays(attempts: readonly SyncAttempt[]): ReadonlySet<string> {
  const covered = new Set<string>()
  for (const attempt of attempts) {
    if (attempt.status !== 'success') continue
    if (!attempt.dateRangeStart || !attempt.dateRangeEnd) continue
    for (const day of enumerateDays(attempt.dateRangeStart, attempt.dateRangeEnd)) covered.add(day)
  }
  return covered
}

export function classifyWindowDays(args: {
  window: { start: string; end: string }
  rows: readonly DailyValueRow[]
  attempts: readonly SyncAttempt[]
}): ClassifiedDay[] {
  const measured = new Map<string, number>()
  for (const row of args.rows) {
    // Duplicate days would double-count; the caller aggregates before handing rows over, so a
    // repeat here is a bug worth failing loudly on rather than silently summing.
    if (measured.has(row.date)) throw new Error(`Duplicate day in series rows: ${row.date}`)
    measured.set(row.date, row.value)
  }
  const covered = provenCoveredDays(args.attempts)

  return enumerateDays(args.window.start, args.window.end).map((date) => {
    if (measured.has(date)) return { date, value: measured.get(date)!, state: 'measured' as const }
    if (covered.has(date)) return { date, value: null, state: 'missing_no_delivery' as const }
    return { date, value: null, state: 'missing_not_synced' as const }
  })
}

export function summariseCoverage(days: readonly ClassifiedDay[]) {
  return {
    totalDays: days.length,
    measuredDays: days.filter((d) => d.state === 'measured').length,
    noDeliveryDays: days.filter((d) => d.state === 'missing_no_delivery').length,
    notSyncedDays: days.filter((d) => d.state === 'missing_not_synced').length,
  }
}

/** Contiguous runs of a single state — what the chart draws as a dormant band. */
export function runsOfState(days: readonly ClassifiedDay[], state: WindowDayState) {
  const runs: Array<{ start: string; end: string; length: number }> = []
  let current: { start: string; end: string; length: number } | null = null
  for (const day of days) {
    if (day.state === state) {
      if (current) { current.end = day.date; current.length += 1 }
      else current = { start: day.date, end: day.date, length: 1 }
    } else if (current) { runs.push(current); current = null }
  }
  if (current) runs.push(current)
  return runs
}
