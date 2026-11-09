import type { ReportMetric, ReportingContext, ReportingData, ReportingRange } from '../contracts'
import { upcomingBusinessContext } from '../business-intelligence-context'
import type { ReviewEvidence, ReviewFinding } from './contracts'
import { deriveCustomerReview } from './business-customers'
import { deriveCustomerFollowupReview } from './business-customer-followup'
import { comparable, display, metricEvidence, numeric, reportLink, statement, unavailableFinding } from './evidence'
import { outcomeWords } from '@/config/outcome-nouns'

// What this business calls its outcomes (NEXT_PUBLIC_OUTCOME_NOUN).
const OW = outcomeWords()

type Evidence = ReviewEvidence | null
type Unit = ReportMetric['current']['unit']
type Path = readonly (string | number)[]
const authority = { state: 'diagnostic', executable: false } as const
export const businessDetailHref = (data: ReportingData, anchor: string) => `${reportLink(data, '/reports', { report: 'business' })}#${anchor}`

function nativeClaim(metric: ReportMetric, claim: ReportMetric['current'] | null, unit: Unit, entityId: string,
  context: ReportingContext, range: ReportingRange, basis: ReportMetric['current']['window']['basis']): boolean {
  if (!claim) return false
  return metric.event === null && claim.metricKey === `outcomes.${metric.key}` && claim.unit === unit
    && claim.source.system === 'outcomes' && claim.source.role === 'business_truth' && claim.source.evidencePlane === 'outcome_business'
    && claim.entity.level === 'business' && claim.entity.id === entityId.slice(0, 160)
    && claim.attributionScope === 'all_sources' && claim.measurementKind === 'operational'
    && claim.definitionVersion === 1 && claim.formula === metric.definition.slice(0, 500)
    && claim.window.start === range.from && claim.window.end === range.to && claim.window.basis === basis
    && claim.window.timezone === context.timezone
    && (claim.availability.state !== 'available' || (typeof claim.value === 'number' && Number.isFinite(claim.value)
      && claim.value >= 0 && (unit !== 'count' || Number.isSafeInteger(claim.value))))
}

/** Native meaning is checked before interpreting a key, including otherwise self-consistent wrong claims. */
export function businessEvidence(data: ReportingData, key: string, unit: Unit, path: Path = ['metrics', key], suffix = '',
  range = data.context.range, basis: ReportMetric['current']['window']['basis'] = 'booking_created_date_et'): Evidence {
  const ref = metricEvidence(data, 'business', path)
  if (!ref || ref.metric.key !== key || !nativeClaim(ref.metric, ref.metric.current, unit,
    `${data.context.account.id}${suffix}`, data.context, range, basis)) return null
  if (basis === 'service_date_et' && (ref.metric.previous !== null || ref.metric.current.comparison.method !== 'none')) return null
  return ref
}

export function businessPrior(data: ReportingData, ref: Evidence): boolean {
  return !!ref && nativeClaim(ref.metric, ref.metric.previous, ref.metric.current.unit, ref.metric.current.entity.id,
    data.context, data.context.comparison, 'booking_created_date_et') && numeric(ref.metric, true) !== null
}
export function businessChange(data: ReportingData, ref: Evidence): number | null {
  return businessPrior(data, ref) && comparable(ref?.metric, ref?.metric, true)
    ? numeric(ref!.metric)! - numeric(ref!.metric, true)! : null
}
export function businessPeriod(data: ReportingData, label: string, ref: Evidence): string {
  const prior = businessPrior(data, ref) ? display(ref!.metric, true) : 'unavailable'
  return `${label}: ${display(ref?.metric)} (prior ${prior}).`
}
export function businessExposure(ref: Evidence): ReviewFinding['exposure'] {
  const value = numeric(ref?.metric), unit = ref?.metric.current.unit
  return ref && value !== null && value >= 0 && (unit === 'money' || unit === 'count')
    ? { value, unit, evidence: [ref] } : null
}
export function unavailableBusiness(data: ReportingData, id: string, title: string, reason: string, anchor: string): ReviewFinding {
  const finding = unavailableFinding(data, { id, area: 'business', title, reason, href: '/reports' })
  return { ...finding, nextInspection: { ...finding.nextInspection, href: businessDetailHref(data, anchor) } }
}
const shown = (ref: Evidence) => display(ref?.metric)
const value = (ref: Evidence) => numeric(ref?.metric)
const scope = (data: ReportingData) => `${data.context.range.from}–${data.context.range.to}, ${data.context.timezone}`

function leadTime(data: ReportingData): ReviewFinding {
  const section = data.business.data?.intelligence?.leadTime
  const report = section && ['available', 'partial'].includes(section.state) ? section.data : null
  const get = (key: string, unit: Unit) => report ? businessEvidence(data, key, unit, ['intelligence', 'leadTime', 'data', 'metrics', key], ':lead_time') : null
  const median = get('median_lead_days', 'days'), p90 = get('p90_lead_days', 'days')
  const eligible = get('eligible_bookings', 'count'), dated = get('dated_bookings', 'count')
  const refs = [median, p90, eligible, dated]
  if (refs.every(ref => value(ref) === null)) return unavailableBusiness(data, 'business_lead_time', `${OW.One}-to-service lead time`,
    `Native ${OW.one}-to-service timestamps and sample counts are unavailable.`, 'business-lead-time')
  const complete = value(dated) !== null && value(eligible) !== null && value(dated) === value(eligible)
    && median?.metric.current.coverage.state === 'complete'
  const change = complete ? businessChange(data, median) : null
  const priorSample = businessPrior(data, dated) && businessPrior(data, eligible)
    ? ` Prior sample: ${display(dated!.metric, true)} of ${display(eligible!.metric, true)} ${OW.many}.` : ' Prior sample unavailable.'
  return {
    id: 'business_lead_time', area: 'business', title: `${OW.One}-to-service lead time`, status: complete && change === 0 ? 'unchanged' : !complete || change === null ? 'mixed' : 'observed',
    priority: !complete || (change !== null && change !== 0) ? 'investigate' : 'context',
    observation: statement(`For ${OW.many} created ${scope(data)}, ${shown(dated)} of ${shown(eligible)} ${OW.many} have usable creation/service timestamps.${priorSample} ${businessPeriod(data, 'Observed median', median)} ${businessPeriod(data, 'Observed p90', p90)} ${!complete ? 'Missing timestamps limit the observed duration sample.' : 'Elapsed days use current recorded service dates.'}`, ...refs),
    materiality: { ...statement(`${shown(dated)} dated ${OW.many} support the observed lead-time sample.`, dated), priorityReason: 'Service lead time affects when recorded demand lands; it does not measure ad conversion lag.' },
    explanations: [{ hypothesis: `Service mix or recorded ${OW.one} dates may explain the duration pattern.`, evidence: statement('', median, dated).evidence,
      missing: ['Comparable service mix and historical schedule observations.'] }],
    counterEvidence: statement('An observed lead-time change is not inherently favorable or unfavorable. Missing timestamps and current rescheduling facts can alter the sample.', median, eligible, dated),
    nextInspection: { question: !complete ? `Which missing or invalid timestamps limit the observed ${OW.one}-to-service sample?`
      : change !== null && change < 0 ? `Which services account for the shorter observed ${OW.one}-to-service lead time?`
        : change !== null && change > 0 ? `Which services account for the longer observed ${OW.one}-to-service lead time?`
          : `Do the service mix and sample coverage support this ${OW.one}-to-service comparison?`, href: businessDetailHref(data, 'business-lead-time'), outcomes: [
        { result: 'The pattern persists within matched service groups and complete timestamps.', interpretation: `Describe the observed lead-time difference for those ${OW.one} cohorts.` },
        { result: 'Missing timestamps or service mix changes explain the aggregate.', interpretation: 'Qualify the aggregate and retain the relevant group observations.' },
      ] },
    limitations: [...section!.notes, `${OW.One}-to-service lead time is not ad-touch conversion lag or evidence of profit. It does not establish historical schedule knowledge.`],
    exposure: businessExposure(dated), authority,
  }
}

function upcoming(data: ReportingData): ReviewFinding {
  const section = data.business.data?.intelligence?.upcoming
  const report = section && ['available', 'partial'].includes(section.state) ? section.data : null
  let range: ReportingRange | null = null
  try { if (section?.asOf) range = upcomingBusinessContext(data.context, section.asOf).range } catch { /* Invalid source clock cannot define a horizon. */ }
  const validRange = report && range && report.range.from === range.from && report.range.to === range.to
  const get = (key: string, unit: Unit) => validRange ? businessEvidence(data, key, unit,
    ['intelligence', 'upcoming', 'data', 'metrics', key], ':upcoming', range!, 'service_date_et') : null
  const bookings = get('recorded_bookings', 'count'), booked = get('booked_value', 'money'), paid = get('amount_paid', 'money')
  const refs = [bookings, booked, paid]
  if (refs.every(ref => value(ref) === null)) return unavailableBusiness(data, 'business_upcoming', 'Recorded upcoming service dates',
    `Recorded future ${OW.many} and amounts are unavailable; future source completeness is unverified, so an empty read does not establish open dates.`, 'business-upcoming')
  const firstDay = report!.days.map((day, index) => ({ day, ref: businessEvidence(data, 'recorded_bookings', 'count',
    ['intelligence', 'upcoming', 'data', 'days', index, 'metrics', 'recorded_bookings'], `:upcoming:day:${day.date}`,
    { from: day.date, to: day.date }, 'service_date_et') }))
    .filter(item => item.day.date >= range!.from && item.day.date <= range!.to && value(item.ref) !== null && value(item.ref)! > 0)
    .sort((a, b) => a.day.date.localeCompare(b.day.date))[0]
  return {
    id: 'business_upcoming', area: 'business', title: 'Recorded upcoming service dates', status: 'mixed', priority: 'context',
    observation: statement(`Service dates ${range!.from}–${range!.to}, ${data.context.timezone}, observed ${section!.asOf}: ${shown(bookings)} recorded ${OW.many}; booked value ${shown(booked)}; amount paid ${shown(paid)}, all sources. ${firstDay ? `Next observed date: ${firstDay.day.date}, with ${shown(firstDay.ref)} recorded ${OW.many}.` : 'A dated breakdown is unavailable.'} This horizon is independent of the selected ${OW.one}-created period.`, ...refs, firstDay?.ref),
    materiality: { ...statement(`${shown(booked)} booked value and ${shown(bookings)} recorded ${OW.many} describe the observed upcoming workload.`, booked, bookings), priorityReason: 'Recorded service dates provide demand context without an invented capacity target.' },
    explanations: [{ hypothesis: `${OW.One}-created totals and upcoming workload differ because ${OW.many} can be booked before the selected period.`,
      evidence: statement('', bookings, booked).evidence, missing: [`Verified complete future schedule coverage and historical ${OW.one} pickup observations.`] }],
    counterEvidence: statement('Recorded booked value is distinct from amount paid. Omitted dates are not proven available slots, and this snapshot cannot establish historical pickup.', booked, paid),
    nextInspection: { question: value(paid) === null ? 'Which upcoming service dates lack valid recorded payment fields?'
      : 'Which recorded dates and services make up this upcoming workload, and where is source coverage unverified?',
      href: businessDetailHref(data, 'business-upcoming'), outcomes: [
        { result: 'Further valid future records become available.', interpretation: 'Update the observed workload using their actual service dates.' },
        { result: 'Only the retained records remain verified.', interpretation: 'Keep this partial workload visible without calling omitted dates open or forecasting revenue.' },
      ] },
    limitations: [...section!.notes, 'Future coverage is partial; this is not complete capacity, attributed return, profit or a payment-event forecast.'],
    exposure: businessExposure(booked) ?? businessExposure(bookings), authority,
  }
}

export function deriveBusinessIntelligenceReview(data: ReportingData): ReviewFinding[] {
  if (!data.business.data?.intelligence) return []
  const followup = deriveCustomerFollowupReview(data)
  return [deriveCustomerReview(data), ...(followup ? [followup] : []), leadTime(data), upcoming(data)]
}
