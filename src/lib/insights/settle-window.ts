export const ATTRIBUTION_SETTLE_DAYS = 7

// SETTLE STATE. Every reported number carries an implicit trust level that depends only on how
// old its dates are, and nothing said so out loud. A CPA over a window ending yesterday is a
// provisional figure; the same CPA over a window ending two weeks ago is final.
//
// Why 7: the daily sync re-pulls the trailing attribution window, so (grouping
// daily_insights.synced_at by date age) dates 1-7 days old are rewritten by every sync and are still
// mutable, while a date older than that stops being rewritten and never moves again. That boundary is
// this shared ATTRIBUTION_SETTLE_DAYS constant; learning/scoring re-exports it so the maturity rule
// and the sync re-pull window do not drift.
//
// Day 0 is not merely unsettled — the account row for today is usually absent until a sync writes
// it, which silently reads as "$0 spent" when unlabeled.


export type SettleState = 'settled' | 'settling'

export interface WindowSettle {
  state: SettleState
  /** How many days in the window are still inside the re-pull boundary and may restate. */
  unsettled_days: number
  /** The last date whose figures are final, clamped to the window end. */
  settled_through: string
  includes_today: boolean
  detail: string
}

const DAY_MS = 86_400_000
const toUtc = (iso: string) => Date.parse(`${iso}T00:00:00Z`)
const addDays = (iso: string, n: number) => new Date(toUtc(iso) + n * DAY_MS).toISOString().slice(0, 10)
const daysBetween = (from: string, to: string) => Math.round((toUtc(to) - toUtc(from)) / DAY_MS)

/**
 * Classify how much of a reporting window is still provisional.
 *
 * A date is settled once it is strictly OLDER than ATTRIBUTION_SETTLE_DAYS: at exactly 7 days old it
 * was still rewritten by today's sync, at 8 it was not.
 */
export function classifyWindowSettle(args: { from: string; to: string; today: string }): WindowSettle {
  const { from, to, today } = args
  // days_old 7 was still rewritten by today's sync; days_old 8 was not. The last FROZEN date is
  // therefore today-(SETTLE+1), and a date is settled only when strictly older than the boundary.
  const cutoff = addDays(today, -(ATTRIBUTION_SETTLE_DAYS + 1))
  const includes_today = to >= today

  const unsettledStart = from > cutoff ? from : addDays(cutoff, 1)
  const unsettled_days = to > cutoff ? daysBetween(unsettledStart, to) + 1 : 0

  if (unsettled_days === 0) {
    return {
      state: 'settled',
      unsettled_days: 0,
      settled_through: to < cutoff ? to : cutoff,
      includes_today,
      detail: `Window ${from}..${to} is fully settled — every date is older than the ${ATTRIBUTION_SETTLE_DAYS}-day re-pull boundary and is no longer rewritten.`,
    }
  }

  const settled_through = cutoff
  const todayNote = includes_today
    ? ' Today is included and is usually ABSENT rather than complete — a missing row means not yet synced, and is not a measurement.'
    : ''

  return {
    state: 'settling',
    unsettled_days,
    settled_through,
    includes_today,
    detail:
      `Window ${from}..${to} is still settling: ${unsettled_days} day(s) sit inside the ${ATTRIBUTION_SETTLE_DAYS}-day ` +
      `re-pull boundary and may still restate` +
      `; figures are final only through ${settled_through}` +
      `. Treat these numbers as provisional.${todayNote}`,
  }
}
