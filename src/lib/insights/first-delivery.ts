// TRUE launch date, derived from first ACTUAL spend — NOT the ad set's `start_time` (which is the
// creation timestamp and can predate real delivery by days). This exists because reading `start_time`
// as "launch" is a real, repeated mistake: an ad set created June 29 but first delivering July 6 is
// 4 days into learning, not 10. Every "N days in / in-the-learning-window" read must key off THIS.
//
// Pure + I/O-free so it can be unit-tested and reused anywhere a daily-spend series is available
// (the recommendation pipeline already loads {date, spend} points in generate.ts).

/** One day of delivery for an entity, sliced from daily_insights. */
export interface DeliveryDay {
  /** YYYY-MM-DD (NY) date. */
  date: string
  /** Ad spend that day. */
  spend: number
}

export interface FirstDeliveryResult {
  /** Earliest date with spend > 0. null when the entity has never actually delivered. */
  firstSpendDate: string | null
  /** Whole CALENDAR days from first spend to `today`, inclusive (Jul 6 → Jul 9 = 4). 0 when never delivered. */
  daysDelivering: number
  /** Count of DISTINCT days that actually had spend > 0 (may be < daysDelivering if delivery had gaps). */
  deliveringDayCount: number
  /** True while daysDelivering is inside Meta's ~7-day learning window — results are not yet judgeable. */
  inLearningWindow: boolean
}

/** Meta's learning phase runs up to ~7 days (or until enough optimization events). Within this window,
 *  conversion RESULTS are not a fair basis for judgement — only delivery health is. */
export const LEARNING_WINDOW_DAYS = 7

function utcDay(dateStr: string): number {
  return new Date(dateStr + 'T00:00:00Z').getTime()
}

/**
 * Derive the true first-spend date and how long the entity has actually been delivering.
 * `days` may be in any order and may contain zero-spend days (they're ignored for the launch date).
 */
export function deriveFirstDelivery(days: DeliveryDay[], today: string): FirstDeliveryResult {
  const delivering = days.filter((d) => Number(d.spend) > 0 && /^\d{4}-\d{2}-\d{2}$/.test(d.date))
  if (delivering.length === 0) {
    return { firstSpendDate: null, daysDelivering: 0, deliveringDayCount: 0, inLearningWindow: false }
  }

  const firstSpendDate = delivering.reduce((min, d) => (d.date < min ? d.date : min), delivering[0].date)
  const distinctDays = new Set(delivering.map((d) => d.date)).size

  const first = utcDay(firstSpendDate)
  const now = utcDay(today)
  const daysDelivering =
    Number.isFinite(first) && Number.isFinite(now) && now >= first
      ? Math.floor((now - first) / 86_400_000) + 1 // inclusive: same-day = 1
      : distinctDays

  return {
    firstSpendDate,
    daysDelivering,
    deliveringDayCount: distinctDays,
    inLearningWindow: daysDelivering <= LEARNING_WINDOW_DAYS,
  }
}
