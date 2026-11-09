import type { MetricClaim } from '@/lib/cockpit/contracts'
import type { ReportMetric, ReportingData, ReportingRange } from './contracts'
import { accountCurrency, accountLocale, accountTimezone } from '@/config/business-config'
import { formatMoney, roundMoney } from '@/lib/utils/format-currency'

type Source = 'business' | 'meta'
type SummaryKey = 'booked_value' | 'paid_bookings' | 'recorded_booked_hours' | 'spend'
const UNIT_BY_KEY: Record<SummaryKey, MetricClaim['unit']> = {
  booked_value: 'money',
  paid_bookings: 'count',
  recorded_booked_hours: 'hours',
  spend: 'money',
}
export interface OverviewRatio {
  value: number | null
  qualifications: string[]
  reason: string | null
}
export const overviewNumbersClose = (left: number, right: number) => Math.abs(left - right) <= Math.max(1, Math.abs(left), Math.abs(right)) * 1e-10

/** Read existing source claims for presentation; never manufacture a blended source claim. */
export function overviewSummaryInput(data: ReportingData, source: Source, key: SummaryKey,
  metric: ReportMetric | undefined, prior = false, date?: string): MetricClaim | null {
  const claim = prior ? metric?.previous : metric?.current, section = data[source]
  const range: ReportingRange = date ? { from: date, to: date } : prior ? data.context.comparison : data.context.range
  if (!metric || !claim || !section.data || section.state === 'unavailable' || data.context.currency !== accountCurrency()
    || data.context.timezone !== accountTimezone() || metric.key !== key || metric.event !== null
    || claim.metricKey !== `${source === 'business' ? 'outcomes' : 'meta'}.${key}`
    || claim.unit !== UNIT_BY_KEY[key] || claim.availability.state !== 'available'
    || typeof claim.value !== 'number' || !Number.isFinite(claim.value) || claim.value < 0
    || key === 'paid_bookings' && !Number.isSafeInteger(claim.value)
    || claim.coverage.state !== 'complete' || claim.maturity.state === 'partial'
    || claim.window.start !== range.from || claim.window.end !== range.to || claim.window.timezone !== data.context.timezone
    || claim.window.basis !== (source === 'business' ? 'booking_created_date_et' : 'impression_date_et')
    || claim.attributionScope !== (source === 'business' ? 'all_sources' : 'none')) return null
  const entityId = date && source === 'business' ? `${data.context.account.id}:day:${date}`.slice(0, 160) : data.context.account.id
  if (claim.entity.level !== (source === 'business' ? 'business' : 'account') || claim.entity.id !== entityId
    || claim.source.system !== (source === 'business' ? 'outcomes' : 'meta')
    || claim.source.role !== (source === 'business' ? 'business_truth' : 'delivery_truth')
    || claim.source.evidencePlane !== (source === 'business' ? 'outcome_business' : 'meta_delivery')) return null
  const asOf = Date.parse(claim.asOf), sectionAsOf = Date.parse(section.asOf ?? ''), cutoff = Date.parse(data.context.asOf)
  if (![asOf, sectionAsOf, cutoff].every(Number.isFinite) || asOf !== sectionAsOf || asOf > cutoff
    || claim.freshness.observedAt && Date.parse(claim.freshness.observedAt) !== asOf) return null
  return claim
}

export function overviewInputQualifications(claims: MetricClaim[]): string[] {
  return [...new Set(claims.flatMap(claim => [claim.freshness.state === 'stale' ? 'Stale source evidence'
    : claim.freshness.state !== 'fresh' ? 'Freshness unverified' : '',
  claim.maturity.state === 'settling' ? 'Settling source evidence' : ''].filter(Boolean)))]
}

function ratio(numerator: MetricClaim | null, denominator: MetricClaim | null, names: [string, string], comparison: string): OverviewRatio {
  if (!numerator || !denominator) return { value: null, qualifications: [],
    reason: `${[!numerator && names[0], !denominator && names[1]].filter(Boolean).join(' and ')} unavailable or incompatible; ${comparison} comparison cannot be calculated.` }
  const qualifications = overviewInputQualifications([numerator, denominator])
  if ((denominator.value as number) === 0) return { value: null, qualifications,
    reason: `${names[1]} is zero; ${comparison} is undefined and cannot support a comparison.` }
  const value = (numerator.value as number) / (denominator.value as number)
  return { value: Number.isFinite(value) ? value : null, qualifications,
    reason: Number.isFinite(value) ? null : `${comparison} is nonfinite and cannot support a comparison.` }
}

/** Matching calendar windows retain distinct booking-creation and impression-date populations. */
export function overviewBusinessSummary(data: ReportingData, prior = false) {
  const booked = overviewSummaryInput(data, 'business', 'booked_value', data.business.data?.metrics.booked_value, prior)
  const bookings = overviewSummaryInput(data, 'business', 'paid_bookings', data.business.data?.metrics.paid_bookings, prior)
  const spend = overviewSummaryInput(data, 'meta', 'spend', data.meta.data?.metrics.spend, prior)
  return { mer: ratio(booked, spend, ['Business booked value', 'Meta spend'], 'All-source MER'),
    spendPerBooking: ratio(spend, bookings, ['Meta spend', 'Business paid bookings'], 'Ad spend per booking') }
}

/** Current/prior comparisons retain each source's own observation and declared population. */
export function overviewComparableInput(data: ReportingData, source: Source, key: SummaryKey) {
  const metric = data[source].data?.metrics[key]
  const current = overviewSummaryInput(data, source, key, metric), previous = overviewSummaryInput(data, source, key, metric, true)
  return current && previous && current.source.head === previous.source.head && current.setupFingerprint === previous.setupFingerprint
    ? { current: current.value as number, previous: previous.value as number } : null
}

export function overviewRatioComparison(data: ReportingData, key: 'mer' | 'spendPerBooking'): string | null {
  if (!overviewComparableInput(data, 'meta', 'spend')
    || !overviewComparableInput(data, 'business', key === 'mer' ? 'booked_value' : 'paid_bookings')) return null
  const current = overviewBusinessSummary(data)[key].value, previous = overviewBusinessSummary(data, true)[key].value
  if (current === null || previous === null) return null
  if (overviewNumbersClose(current, previous)) return 'Unchanged'
  // Displayed precision: two decimals for the ratio, the currency's minor unit for money.
  const displayed = (value: number) => key === 'mer' ? value.toFixed(2) : roundMoney(value)
  if (displayed(current) === displayed(previous)) return `${key === 'mer' ? `${current.toFixed(2)}×` : `${formatMoney(current)}`} at displayed precision`
  if (previous === 0) return 'Prior zero · percentage change undefined'
  const change = Math.round(Math.abs((current - previous) / previous * 100))
  return `${current > previous ? '+' : '−'}${change || '<1'}%`
}

export function overviewRatioValue(ratio: OverviewRatio, unit: 'ratio' | 'money') {
  return ratio.value === null ? 'Unavailable' : unit === 'ratio' ? `${ratio.value.toFixed(2)}×`
    : new Intl.NumberFormat(accountLocale(), { style: 'currency', currency: accountCurrency() }).format(ratio.value)
}
