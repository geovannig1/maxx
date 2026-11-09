import { REC_THRESHOLDS } from '@/lib/recommendations/thresholds'
import { formatMoney, formatMoneyAmount } from '@/lib/utils/format-currency'

// Shared low-data classifier so every view tells the SAME story: "delivering but thin = warming up
// (calibration)" vs "nothing delivered = dormant/empty". Keyed off the same REC_THRESHOLDS the
// operating-mode detector uses, instead of ad-hoc per-page numbers.

export interface LowDataDecision {
  /** true → show a "still warming up" notice (data is present but below decision thresholds). */
  warming: boolean
  title: string
  message: string
  items: { label: string; have: string; need?: string }[]
}

export function assessLowData(opts: {
  spend: number
  bookings?: number | null
  windowDays: number
  entityPlural: string
}): LowDataDecision {
  const { spend, bookings, windowDays, entityPlural } = opts
  const minSpend = REC_THRESHOLDS.DORMANT_SPEND_30D // 20 — at/below this over the window ⇒ effectively dormant
  const minBookings = REC_THRESHOLDS.MIN_BOOKINGS_PERF_CLAIM // 3 — below this, no confident per-entity call

  if (!(spend > 0)) {
    // Nothing delivered — that's dormant/empty, not "warming up". Let the page's EmptyState explain it.
    return { warming: false, title: '', message: '', items: [] }
  }

  const thin = spend < minSpend || (bookings != null && bookings < minBookings)
  const items: { label: string; have: string; need?: string }[] = [
    { label: 'Spend', have: `${formatMoney(spend, { maximumFractionDigits: 0 })}`, need: `≥ ${formatMoneyAmount(minSpend)}` },
  ]
  if (bookings != null) items.push({ label: 'Bookings', have: String(bookings), need: `≥ ${minBookings} for confident calls` })

  return {
    warming: thin,
    title: 'Still warming up',
    message: `These ${entityPlural} are delivering, but the ${windowDays}-day window is still too thin for confident calls — this is calibration, not an error or a filter problem.`,
    items,
  }
}
