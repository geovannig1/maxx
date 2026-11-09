import { roundMoney } from '@/lib/utils/format-currency'
import { accountCurrency, accountLocale } from '@/config/business-config'
import { outcomeWords } from '@/config/outcome-nouns'

// What this business calls its outcomes (NEXT_PUBLIC_OUTCOME_NOUN).
const OW = outcomeWords()
/**
 * The reconciliation ladder.
 *
 * An account's three views of "did the ads work" can disagree by an order of magnitude or more. For
 * example, Meta might claim 40 results lifetime while first-party attribution proves 5 bookings and
 * the business booked 200 value-bearing appointments over the same span. Any single blended "bookings" number would be a
 * lie in one direction or the other, so the page shows the whole descent and names what is lost at
 * each step. The gap between the planes IS the finding.
 *
 * TWO RULES THIS MODULE ENFORCES:
 *
 * 1. The first-party rungs are a genuine subset chain, and that is asserted, not assumed. A ladder
 *    whose rungs are not nested is a chart of unrelated numbers stacked to look like a funnel.
 * 2. Meta is NOT a rung. It is attributed to IMPRESSION date while the first-party rungs are on
 *    booking-created date, so a booking made on the 20th from an impression on the 5th lands in
 *    different buckets. Over a long window that mostly washes out; over month-to-date it does not.
 *    It travels as a parallel claim carrying its own basis.
 */

/** Which calendar a number is counted on. Mirrors `ClaimWindow['basis']` in the claim contract. */
export type LadderBasis = 'booking_created_date_et' | 'closed_account_days'

export interface LadderRung {
  key: string
  label: string
  count: number
  /** What is lost between the rung above and this one. `null` on the first rung. */
  dropReason: string | null
}

export interface LadderMoney {
  /** Scheduled/booked value. What the appointments were worth on paper. */
  bookedValue: number
  /**
   * Owner-confirmed checkout revenue. When `amount_paid` is missing for some appointments this is
   * the sum of what IS known — an observed lower bound. A missing amount is never read as $0.
   */
  collectedAmount: number
  collectedIsLowerBound: boolean
  amountPaidCoverage: { known: number; total: number }
}

export interface MetaParallelClaim {
  label: string
  basis: LadderBasis
  results: number
  viewThrough: number | null
  clickImplied: number | null
  /** Days in the window where Meta reported no view-through split, so the split is a floor. */
  viewThroughIsFloor: boolean
  /**
   * The same split in dollars. Counts alone are not enough: it is the VALUE split that decides
   * whether a ROAS figure describes click-earned revenue or impressions nobody clicked. In practice
   * the count share and the value share can differ by a couple of points — so
   * the two shares are close but are not the same number and must not be inferred from
   * each other. `null` when Meta reported no breakdown; never 0, which would assert a measured
   * zero (the same NULL-vs-0 distinction the `daily_insights.appointment_value_view_through` column comment documents).
   */
  valueAmount: number
  viewThroughValue: number | null
  clickImpliedValue: number | null
  note: string
}

export interface AttributionLadder {
  basis: LadderBasis
  rungs: LadderRung[]
  money: LadderMoney
  /** Non-value-bearing appointments, reported alongside — never called "tests". */
  zeroValueBookings: number
  /** Paid-linked bookings that cancelled; excluded from the rungs, never hidden. */
  cancelledPaidLinked: number
  meta: MetaParallelClaim
}

export interface LadderCounts {
  valueBearingBookings: number
  zeroValueBookings: number
  withPaidSignal: number
  withFbclid: number
  webhookLinked: number
  /**
   * Paid-linked bookings that were later cancelled. Excluded from the rungs, which count
   * value-bearing bookings only — but reported, because a paid booking that cancels is a media
   * fact, not a rounding error. For example, 2 of 5 linked bookings may have cancelled.
   */
  webhookLinkedCancelled: number
}

export interface LadderMoneyInput {
  bookedValue: number
  collectedAmount: number
  amountPaidKnown: number
  amountPaidTotal: number
}

export interface MetaInput {
  results: number
  viewThrough: number | null
  daysMissingViewThroughSplit: number
  /** Booking value for the window, and the 1d_view portion. `null` = no breakdown reported. */
  valueAmount: number
  viewThroughValue: number | null
}

/**
 * Copy is centralised here so the drop-off explanations cannot drift between the page, the report
 * and the assistant. Each string answers one question: why is this rung smaller than the last?
 */
const DROP_REASONS = {
  paidSignal: `${OW.One} recorded without a utm tag or fbclid on the landing URL — most arrive organically or by direct link.`,
  fbclid: 'Carried a utm tag but no fbclid, so Meta never stamped the click.',
  webhookLinked: `Had an fbclid but no signed webhook proving a client-initiated ${OW.one} inside the token window.`,
} as const

export function buildAttributionLadder(args: {
  counts: LadderCounts
  money: LadderMoneyInput
  meta: MetaInput
}): AttributionLadder {
  const { counts, money, meta } = args

  const rungs: LadderRung[] = [
    { key: 'value_bearing', label: `Value-bearing ${OW.many}`, count: counts.valueBearingBookings, dropReason: null },
    { key: 'paid_signal', label: 'Carried a paid signal', count: counts.withPaidSignal, dropReason: DROP_REASONS.paidSignal },
    { key: 'fbclid', label: 'Carried an fbclid', count: counts.withFbclid, dropReason: DROP_REASONS.fbclid },
    { key: 'webhook_linked', label: 'Linked to a paid touch', count: counts.webhookLinked, dropReason: DROP_REASONS.webhookLinked },
  ]

  // A ladder that is not nested is not a ladder. Fail loudly rather than render a funnel that
  // silently implies containment the data does not have.
  for (let i = 1; i < rungs.length; i += 1) {
    if (rungs[i].count > rungs[i - 1].count) {
      throw new Error(
        `Attribution ladder is not nested: "${rungs[i].label}" (${rungs[i].count}) exceeds ` +
        `"${rungs[i - 1].label}" (${rungs[i - 1].count}).`,
      )
    }
  }
  for (const rung of rungs) {
    if (!Number.isInteger(rung.count) || rung.count < 0) {
      throw new Error(`Attribution ladder rung "${rung.label}" must be a non-negative integer.`)
    }
  }

  if (money.amountPaidKnown > money.amountPaidTotal) {
    throw new Error('amount_paid coverage cannot exceed the appointments it covers.')
  }

  const viewThrough = meta.viewThrough
  const clickImplied = viewThrough === null ? null : meta.results - viewThrough
  if (clickImplied !== null && clickImplied < 0) {
    throw new Error('Meta view-through results cannot exceed total results.')
  }

  // Same convention in dollars: null propagates, and an incoherent split throws rather than
  // rendering a negative click-implied figure that would read as a measurement.
  const viewThroughValue = meta.viewThroughValue
  const clickImpliedValue =
    viewThroughValue === null ? null : roundMoney((meta.valueAmount - viewThroughValue))
  if (clickImpliedValue !== null && clickImpliedValue < 0) {
    throw new Error('Meta view-through value cannot exceed total value.')
  }

  return {
    basis: 'booking_created_date_et',
    rungs,
    zeroValueBookings: counts.zeroValueBookings,
    cancelledPaidLinked: counts.webhookLinkedCancelled,
    money: {
      bookedValue: money.bookedValue,
      collectedAmount: money.collectedAmount,
      collectedIsLowerBound: money.amountPaidKnown < money.amountPaidTotal,
      amountPaidCoverage: { known: money.amountPaidKnown, total: money.amountPaidTotal },
    },
    meta: {
      label: 'Meta-claimed results',
      basis: 'closed_account_days',
      results: meta.results,
      viewThrough,
      clickImplied,
      viewThroughIsFloor: meta.daysMissingViewThroughSplit > 0,
      valueAmount: roundMoney(meta.valueAmount),
      viewThroughValue,
      clickImpliedValue,
      note: `Counted on impression date, not ${OW.one} date — a parallel claim, not a subset of the rungs above.`,
    },
  }
}

/** Sentence for the money line, obeying the ledger's lower-bound rule. */
export function describeMoney(money: LadderMoney): string {
  const booked = money.bookedValue.toLocaleString(accountLocale(), { style: 'currency', currency: accountCurrency() })
  const collected = money.collectedAmount.toLocaleString(accountLocale(), { style: 'currency', currency: accountCurrency() })
  const { known, total } = money.amountPaidCoverage
  if (money.collectedIsLowerBound) {
    return `${booked} booked · ${collected} collected, an observed lower bound ` +
      `(checkout amount recorded for ${known} of ${total} ${OW.many}).`
  }
  return `${booked} booked · ${collected} collected (checkout amount recorded for all ${total} ${OW.many}).`
}

/** Sentence for the Meta line, never asserting a split Meta did not fully report. */
export function describeMetaClaim(meta: MetaParallelClaim): string {
  if (meta.viewThrough === null) return `${meta.results} results. Meta reported no view-through split.`
  const floor = meta.viewThroughIsFloor ? ' at least ' : ' '
  return `${meta.results} results —${floor}${meta.viewThrough} view-through, ` +
    `${meta.clickImplied} click-implied.`
}

/**
 * Sentence for the money split. Separate from describeMetaClaim rather than appended to it, because
 * the count split and the value split can be reported to different completeness — Meta can break
 * out results by window on a day it does not break out value — and one sentence carrying two
 * different confidence levels is the "aggregate hides its composition" failure this repo's
 * verification law now names explicitly.
 */
export function describeMetaValueSplit(meta: MetaParallelClaim): string | null {
  const usd = (n: number) => n.toLocaleString(accountLocale(), { style: 'currency', currency: accountCurrency() })
  if (meta.valueAmount <= 0) return null
  if (meta.viewThroughValue === null) {
    return `${usd(meta.valueAmount)} of ${OW.one} value. Meta reported no view-through split for value.`
  }
  const share = Math.round((meta.viewThroughValue / meta.valueAmount) * 100)
  return `${usd(meta.valueAmount)} of ${OW.one} value — ${usd(meta.viewThroughValue)} (${share}%) ` +
    `view-through, ${usd(meta.clickImpliedValue ?? 0)} click-implied. A ROAS built on the total ` +
    `describes both; only the click-implied half was earned from a click.`
}
