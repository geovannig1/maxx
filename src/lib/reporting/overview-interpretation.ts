import { accountCurrency, accountLocale } from '@/config/business-config'
import type { MetricClaim } from '@/lib/cockpit/contracts'
import type { ReportingData } from './contracts'
import { overviewBusinessSummary, overviewComparableInput, overviewInputQualifications, overviewNumbersClose as close, overviewRatioComparison, overviewRatioValue, overviewSummaryInput } from './overview-business-summary'
import { deriveBusinessDrivers } from './business-drivers'
import { trendRows } from './trend'
import { isBookingLikeOutcome, outcomeWords } from '@/config/outcome-nouns'

// What this business calls its outcomes (NEXT_PUBLIC_OUTCOME_NOUN).
const OW = outcomeWords()

interface DailyInput { date: string; value: number; claim: MetricClaim }
export interface OverviewTemporalReading {
  observation: string
  summary?: string
  qualifier: string
  qualifications: string[]
}
export interface OverviewBusinessMovementReading {
  observation: string
  qualifications: string[]
  explanation?: string[]
  changed?: boolean
}
export interface OverviewMerMovementReading {
  observation: string
  qualifications: string[]
  explanation: string[]
  changed: boolean
}
const money = (value: number) => new Intl.NumberFormat(accountLocale(), { style: 'currency', currency: accountCurrency() }).format(value)
const sum = (rows: DailyInput[]) => rows.reduce((total, row) => total + row.value, 0)
const pct = (current: number, previous: number) => previous === 0 ? null : Math.round((current - previous) / Math.abs(previous) * 100)
const direction = (value: number | null) => value === null || value === 0 ? null : value > 0 ? 'rose' : 'fell'
const fieldChange = (label: string, current: MetricClaim | null, previous: MetricClaim | null) => {
  if (!current || !previous) return null
  const value = pct(current.value as number, previous.value as number)
  const move = direction(value)
  return value === null || !move ? null : { label, pct: Math.abs(value), move, sign: value > 0 ? 1 : -1 }
}

/** Every calendar day must validate and reconcile with its own source's period total. */
function daily(data: ReportingData, source: 'business' | 'meta', key: 'booked_value' | 'paid_bookings' | 'spend'): DailyInput[] | null {
  const section = data[source], headline = overviewSummaryInput(data, source, key, section.data?.metrics[key])
  if (!headline) return null
  const rows = trendRows(data.context, section.data?.series ?? [], [], key).map(row => ({ date: row.date,
    claim: overviewSummaryInput(data, source, key, row.metric, false, row.date) }))
  if (!rows.length || rows.some(row => !row.claim || row.claim.source.head !== headline.source.head)) return null
  const values = rows.map(row => ({ date: row.date, value: row.claim!.value as number, claim: row.claim! }))
  return close(sum(values), headline.value as number) ? values : null
}

function divergence(business: DailyInput[], bookings: DailyInput[], spend: DailyInput[] | null, qualifications: string[]): OverviewTemporalReading | null {
  if (!spend || business.length < 4) return null
  const split = Math.floor(business.length / 2), parts = (rows: DailyInput[]) => [rows.slice(0, split), rows.slice(split)]
  const average = (rows: DailyInput[]) => sum(rows) / rows.length
  const bookedParts = parts(business), spentParts = parts(spend), counts = parts(bookings).map(sum)
  const booked = bookedParts.map(average), spent = spentParts.map(average)
  if ((booked[1] - booked[0]) * (spent[1] - spent[0]) >= 0
    || money(booked[0]) === money(booked[1]) || money(spent[0]) === money(spent[1])) return null
  const dates = bookedParts.map(rows => `${rows[0].date} – ${rows.at(-1)!.date}`)
  return {
    observation: `From ${dates[0]} to ${dates[1]}, recorded booked value ${booked[1] < booked[0] ? 'fell' : 'rose'} from ${money(booked[0])} to ${money(booked[1])} per day while Meta spend ${spent[1] < spent[0] ? 'fell' : 'rose'} from ${money(spent[0])} to ${money(spent[1])} per day.`,
    qualifier: `The intervals contained ${counts[0]} to ${counts[1]} paid ${OW.many} (${money(sum(bookedParts[0]))} and ${money(sum(bookedParts[1]))} booked value); separate ${OW.one} and impression dates do not establish attribution.`,
    qualifications,
  }
}

/** A majority day is described against all other days, not assigned an alarm or causal verdict. */
export function overviewTemporalReading(data: ReportingData): OverviewTemporalReading | null {
  const business = daily(data, 'business', 'booked_value'), bookings = daily(data, 'business', 'paid_bookings')
  if (!business || !bookings || business.length < 3 || sum(bookings) < 2) return null
  const total = sum(business), count = sum(bookings), largest = business.reduce((peak, row) => row.value > peak.value ? row : peak)
  const spend = daily(data, 'meta', 'spend')
  const claims = [...business, ...bookings, ...(spend ?? [])].map(row => row.claim)
  const periodClaims = [data.business.data!.metrics.booked_value.current, data.business.data!.metrics.paid_bookings.current,
    ...(spend ? [data.meta.data!.metrics.spend.current] : [])]
  const qualifications = overviewInputQualifications([...claims, ...periodClaims])
  if (total <= 0 || largest.value <= total - largest.value) return divergence(business, bookings, spend, qualifications)
  const peakCount = bookings.find(row => row.date === largest.date)!.value, remainingCount = count - peakCount
  const remainingSpend = spend && sum(spend.filter(row => row.date !== largest.date))
  const prior = overviewSummaryInput(data, 'business', 'booked_value', data.business.data?.metrics.booked_value, true)
  const priorContext = prior && close(prior.value as number, total) ? ` despite unchanged period booked value` : ''
  return {
    observation: `${largest.date} supplied ${money(largest.value)} of ${money(total)} booked value (${Math.round(largest.value / total * 100)}%), with ${peakCount} of ${count} paid ${OW.many}${priorContext}.`,
    summary: `${largest.date} supplied ${Math.round(largest.value / total * 100)}% of booked value.`,
    qualifier: `The other ${business.length - 1} dates contributed ${money(total - largest.value)} from ${remainingCount} paid ${OW.one}${remainingCount === 1 ? '' : 's'}${remainingSpend !== null
      ? ` alongside ${money(remainingSpend)} in Meta spend; these separate ${OW.one} and impression dates do not establish attribution` : '; Meta daily spend is unavailable for a matched calendar comparison'}.`,
    qualifications: priorContext && prior ? [...new Set([...qualifications, ...overviewInputQualifications([prior])])] : qualifications,
  }
}

export function overviewBusinessMovementReading(data: ReportingData): OverviewBusinessMovementReading | null {
  const account = deriveBusinessDrivers(data).account
  const { current, prior, change } = account
  if (current.valuePerBooking !== null && prior.valuePerBooking !== null && change.valuePerBooking !== null) {
    const average = comparisonText(`Average ${OW.one} value`, current.valuePerBooking, prior.valuePerBooking, money)
    const completeHours = isBookingLikeOutcome() && current.recordedHours !== null && current.recordedHours > 0
      && prior.recordedHours !== null && prior.recordedHours > 0 && change.recordedHours !== null
    const valuePerHour = completeHours ? current.bookedValue! / current.recordedHours! : null
    const priorPerHour = completeHours ? prior.bookedValue! / prior.recordedHours! : null
    const hourComparison = valuePerHour !== null && priorPerHour !== null && Number.isFinite(valuePerHour) && Number.isFinite(priorPerHour)
      ? comparisonText('booked value per recorded hour', valuePerHour, priorPerHour, money) : null
    const hourContrast = hourComparison && !close(valuePerHour!, priorPerHour!)
      && (close(current.valuePerBooking, prior.valuePerBooking) || (current.valuePerBooking - prior.valuePerBooking) * (valuePerHour! - priorPerHour!) < 0)
    const explanation = [
      `${comparisonText('All-source booked value', current.bookedValue!, prior.bookedValue!, money)}; eligible ${OW.many} ${prior.bookings} → ${current.bookings}.`,
      ...(hourComparison ? [`${hourComparison[0].toUpperCase()}${hourComparison.slice(1)}; this is recorded-duration context, not a rental rate, profit or utilization.`] : []),
      ...(completeHours ? [`${comparisonText('Recorded hours', current.recordedHours!, prior.recordedHours!, amount => `${amount.toFixed(1)} hours`)}; hours per duration-recorded ${OW.one}: ${(prior.recordedHours! / prior.bookings!).toFixed(1)} → ${(current.recordedHours! / current.bookings!).toFixed(1)} hours (${changeLabel(current.recordedHours! / current.bookings!, prior.recordedHours! / prior.bookings!)}).`] : []),
    ]
    const claims = Object.values(account.evidence).flatMap(ref => ref ? [ref.metric.current, ...(ref.metric.previous ? [ref.metric.previous] : [])] : [])
    return { observation: `${average}${hourContrast ? `, while ${hourComparison}` : ''}.`, explanation,
      changed: !close(current.valuePerBooking, prior.valuePerBooking) || !!hourComparison && !close(valuePerHour!, priorPerHour!),
      qualifications: overviewInputQualifications(claims) }
  }
  const metrics = data.business.data?.metrics
  const value = fieldChange('value', overviewSummaryInput(data, 'business', 'booked_value', metrics?.booked_value),
    overviewSummaryInput(data, 'business', 'booked_value', metrics?.booked_value, true))
  const bookings = fieldChange('bookings', overviewSummaryInput(data, 'business', 'paid_bookings', metrics?.paid_bookings),
    overviewSummaryInput(data, 'business', 'paid_bookings', metrics?.paid_bookings, true))
  const hours = fieldChange('hours', overviewSummaryInput(data, 'business', 'recorded_booked_hours', metrics?.recorded_booked_hours),
    overviewSummaryInput(data, 'business', 'recorded_booked_hours', metrics?.recorded_booked_hours, true))
  if (!value || !bookings) return null
  const qualifications = overviewInputQualifications([
    metrics!.booked_value.current, metrics!.booked_value.previous!, metrics!.paid_bookings.current, metrics!.paid_bookings.previous!,
    ...(hours ? [metrics!.recorded_booked_hours.current, metrics!.recorded_booked_hours.previous!] : []),
  ])
  const opposite = value.sign !== bookings.sign
  const sameHours = hours && hours.sign === value.sign
  const headline = opposite
    ? `${bookings.sign < 0 ? 'Fewer' : 'More'} ${OW.many} brought in ${value.sign > 0 ? 'more' : 'less'} value${sameHours ? ` and ${hours.sign > 0 ? 'booked' : 'fewer booked'} hours` : ''}`
    : `Business ${value.sign > 0 ? 'grew' : 'declined'} across value and ${OW.many}${sameHours ? ' with booked hours moving the same way' : ''}`
  const parts = [
    `${OW.many} ${bookings.move} ${bookings.pct}%`,
    `value ${value.move} ${value.pct}%`,
    ...(hours ? [`hours ${hours.move} ${hours.pct}%`] : []),
  ]
  return { observation: `${headline}: ${parts[0]}, while ${parts.slice(1).join(' and ')}.`, qualifications }
}

function changeLabel(current: number, previous: number) {
  if (close(current, previous)) return 'Unchanged'
  if (previous === 0) return 'prior zero; percentage change undefined'
  return `${current > previous ? '+' : '−'}${Math.abs(pct(current, previous)!) || '<1'}%`
}

function comparisonText(label: string, current: number, previous: number, format: (value: number) => string) {
  if (close(current, previous)) return `${label} held at ${format(current)}`
  if (format(current) === format(previous)) return `${label} was ${format(current)} at displayed precision; the unrounded value ${current > previous ? 'rose' : 'fell'}`
  if (previous === 0) return `${label} ${current > previous ? 'rose' : 'fell'} from ${format(previous)} to ${format(current)}`
  return `${label} ${current > previous ? 'rose' : 'fell'} ${Math.abs(pct(current, previous)!) || 'less than 1'}% to ${format(current)}`
}

/** Compare the two validated mixed-basis ratios without treating either as attributed return or profit. */
export function overviewMerMovementReading(data: ReportingData): OverviewMerMovementReading | null {
  const current = overviewBusinessSummary(data).mer, previous = overviewBusinessSummary(data, true).mer
  const spend = overviewComparableInput(data, 'meta', 'spend'), value = overviewComparableInput(data, 'business', 'booked_value')
  if (current.value === null || previous.value === null || !spend || !value) return null
  const displayedCurrent = current.value.toFixed(2), displayedPrevious = previous.value.toFixed(2)
  const movement = close(current.value, previous.value) ? `held at ${displayedCurrent}×`
    : displayedCurrent === displayedPrevious ? `was ${displayedCurrent}× at displayed precision; the unrounded ratio ${current.value > previous.value ? 'rose' : 'fell'}`
    : `${current.value > previous.value ? 'rose' : 'fell'} from ${displayedPrevious}× to ${displayedCurrent}×`
  const spendChange = close(spend.current, spend.previous) ? null : close(spend.current, spend.previous * 2) ? 'Meta spend doubled'
    : comparisonText('Meta spend', spend.current, spend.previous, money)
  const cost = overviewBusinessSummary(data).spendPerBooking, priorCost = overviewBusinessSummary(data, true).spendPerBooking
  const costChange = overviewRatioComparison(data, 'spendPerBooking')
  return {
    observation: `${spendChange ? `${spendChange} while all-source` : 'All-source'} MER ${movement}.`,
    changed: !close(value.current, value.previous) || !close(spend.current, spend.previous),
    explanation: [`${comparisonText('All-source booked value', value.current, value.previous, money)}; ${comparisonText('Meta spend', spend.current, spend.previous, money)}.`,
      ...(costChange ? [`Meta spend per all-source paid ${OW.one}: ${overviewRatioValue(priorCost, 'money')} → ${overviewRatioValue(cost, 'money')} (${costChange}); not customer acquisition cost.`] : [])],
    qualifications: [...new Set([...current.qualifications, ...previous.qualifications])],
  }
}
