import type { CockpitRange } from './evidence'

/**
 * Which window a metric may honestly be compared over, and what it is compared against.
 *
 * THE FAILURE THIS EXISTS TO PREVENT. `classifyWindowSettle` puts the attribution boundary 7 days
 * back, so a window ending today has roughly a week of dates Meta is still rewriting. Comparing that
 * settling current period against a fully settled prior period manufactures a decline out of
 * unconverged attribution — and it would carry the SERVER's authority rather than the model's, which
 * is strictly worse, because there is nobody left to blame for it.
 *
 * MATURITY IS PER CLAIM, NOT PER WINDOW. `meta.spend` is stamped `settled` unconditionally
 * (`builder.ts`) because money is not re-attributed; conversion-bearing claims run through the settle
 * classifier and are `settling` for the same window. A single global comparable window would either
 * truncate spend for no reason or compare conversions across a boundary they have not crossed. So the
 * comparable window is derived from the CLAIM's own maturity.
 *
 * Both sides are the same length by construction, which is what makes rate-shaped metrics —
 * frequency in particular — comparable at all.
 */

/**
 * The kill switch for prior-period trends.
 *
 * DEFAULT ON, disabled by setting `MAXX_COCKPIT_TRENDS=off`. Opt-OUT rather than opt-in because the
 * feature is shipped: a flag that must be set to keep working is a flag someone forgets in an
 * environment nobody is watching.
 *
 * Why one was needed. Trends could only be removed by a deploy, and the nearest thing to "off" —
 * omitting comparison evidence — was WORSE than either state: the twelve `*_change` claims were
 * emitted regardless, so every metric cell grew a permanent "No prior-period comparison" line and
 * the extra window reads still fired. Off must mean the pre-trend surface exactly: 14 claims, one
 * delivery read, no trend line anywhere.
 */
export function cockpitTrendsEnabled(): boolean {
  return process.env.MAXX_COCKPIT_TRENDS !== 'off'
}

const DAY_MS = 86_400_000
const toUtc = (iso: string) => Date.parse(`${iso}T00:00:00.000Z`)
const addDays = (iso: string, n: number) => new Date(toUtc(iso) + n * DAY_MS).toISOString().slice(0, 10)

/** Inclusive day count. `2026-08-01..2026-08-01` is one day, not zero. */
export function inclusiveDays(start: string, end: string): number {
  return Math.round((toUtc(end) - toUtc(start)) / DAY_MS) + 1
}

export interface ComparableWindows {
  /** The portion of the requested window this claim may be compared over. */
  current: CockpitRange
  /** The equal-length window ending the day before `current.start`. */
  prior: CockpitRange
}

/**
 * The comparable pair for a claim, or null when there is nothing honest to compare.
 *
 * `matureThrough` is the last date whose figures are final. A `settled` claim is comparable over the
 * whole requested window; a `settling` one only up to that date. `partial` and `not_applicable`
 * return null — today's accruing spend has no equal-length prior period, and a claim that declares
 * its maturity inapplicable is asserting that the question does not arise.
 */
export function comparableWindows(
  range: CockpitRange,
  maturity: { state: 'settled' | 'settling' | 'partial' | 'not_applicable', matureThrough: string | null },
): ComparableWindows | null {
  if (maturity.state === 'partial' || maturity.state === 'not_applicable') return null
  // The STATED boundary governs, whatever the state says. Reading `range.end` for a settled claim
  // trusts the label over the date it carries, and the two can disagree: `settled` with a
  // `matureThrough` earlier than the requested end is a claim saying it is final only through that
  // date, and comparing past it is the manufactured-decline bug wearing a different label. `settled`
  // with no boundary stated is the one case where the requested end is the honest answer.
  //
  // Hardening rather than a live fix, said plainly: `classifyWindowSettle` clamps `settled_through`
  // to the window end on its settled branch, and `spendClaim` stamps `range.end` directly, so no
  // claim in the system disagrees with its own label today. Per-metric trends add a great many claims that
  // could.
  const declared = maturity.state === 'settled'
    ? maturity.matureThrough ?? range.end
    : maturity.matureThrough
  // A `settling` claim with no `matureThrough` states that nothing in the window is final.
  if (declared === null) return null
  const end = declared
  // Nothing in the requested window has settled: the comparable window would start after it ends.
  if (end < range.start) return null
  // A boundary can only shorten the window, never extend it past what was asked for.
  const clampedEnd = end > range.end ? range.end : end
  const days = inclusiveDays(range.start, clampedEnd)
  const priorEnd = addDays(range.start, -1)
  const priorStart = addDays(priorEnd, -(days - 1))
  return {
    current: { ...range, end: clampedEnd },
    prior: { ...range, start: priorStart, end: priorEnd },
  }
}
