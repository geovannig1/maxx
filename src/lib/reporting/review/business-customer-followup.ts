import { accountCurrency, accountLocale } from '@/config/business-config'
import { etDateOf } from '@/lib/utils/date-utils'
import type { ReportMetric, ReportingData, ReportingRange } from '../contracts'
import {
  BUSINESS_CUSTOMER_FOLLOWUP_DEFINITIONS as DEFINITIONS,
  BUSINESS_CUSTOMER_FOLLOWUP_HORIZONS as HORIZONS,
  BUSINESS_CUSTOMER_FOLLOWUP_METRIC_KEYS as KEYS,
} from '../business-customer-followup'
import { compareCreativeEvidenceInstants as compareInstants } from '../creative-assignment-contract'
import type { ReviewEvidence, ReviewFinding } from './contracts'
import { metricEvidence, reportLink, statement, unavailableFinding } from './evidence'
import { outcomeWords } from '@/config/outcome-nouns'

// What this business calls its outcomes (NEXT_PUBLIC_OUTCOME_NOUN).
const OW = outcomeWords()

type Period = 'current' | 'prior'
type Claim = ReportMetric['current']
type Key = typeof KEYS[number]
const UNITS: Record<Key, Claim['unit']> = {
  cohort_customers: 'count', eligible_customers: 'count', repeat_customers: 'count',
  repeat_rate: 'percent', repeat_bookings: 'count', repeat_booked_value: 'money',
  repeat_booked_value_per_eligible_customer: 'money',
}
const LABELS: Record<Key, string> = {
  cohort_customers: 'Cohort customers', eligible_customers: 'Eligible customers', repeat_customers: 'Repeat customers',
  repeat_rate: 'Repeat rate', repeat_bookings: `Repeat ${OW.many}`, repeat_booked_value: 'Repeat booked value',
  repeat_booked_value_per_eligible_customer: 'Repeat booked value per eligible customer',
}
const close = (left: number, right: number) => Math.abs(left - right)
  <= Number.EPSILON * 16 * Math.max(1, Math.abs(left), Math.abs(right))
const shifted = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000)
  .toISOString().slice(0, 10)
const path = (index: number, key: Key) => ['intelligence', 'customers', 'data', 'followup', 'horizons', index, 'metrics', key] as const
const value = (ref: ReviewEvidence | null, period: Period): number | null => {
  const claim = period === 'current' ? ref?.metric.current : ref?.metric.previous
  return claim?.availability.state === 'available' && typeof claim.value === 'number' && Number.isFinite(claim.value)
    ? claim.value : null
}
const display = (value: number | null, unit: Claim['unit']) => value === null ? 'unavailable'
  : unit === 'money' ? value.toLocaleString(accountLocale(), { style: 'currency', currency: accountCurrency() })
    : unit === 'percent' ? `${value.toLocaleString('en-US', { maximumFractionDigits: 1 })}%`
      : value.toLocaleString('en-US', { maximumFractionDigits: 1 })

function nativeClaim(data: ReportingData, metric: ReportMetric, claim: Claim | null, key: Key,
  range: ReportingRange, entityId: string, period: Period, days: number, observedThrough: string): boolean {
  if (!claim) return false
  const eligibleClaimId = `report:outcomes:business:${entityId}:eligible_customers:${range.from}:${range.to}`
  const numeratorClaimId = `report:outcomes:business:${entityId}:${key === 'repeat_rate' ? 'repeat_customers' : 'repeat_booked_value'}:${range.from}:${range.to}`
  const inputs = ['repeat_rate', 'repeat_booked_value_per_eligible_customer'].includes(key)
    ? [numeratorClaimId, eligibleClaimId] : []
  const matureThrough = shifted(observedThrough, -days)
  return metric.key === key && metric.label === LABELS[key] && metric.definition === DEFINITIONS[key] && metric.event === null
    && claim.claimId === `report:outcomes:business:${entityId}:${key}:${range.from}:${range.to}`
    && claim.metricKey === `outcomes.${key}` && claim.label === LABELS[key] && claim.unit === UNITS[key]
    && claim.formula === DEFINITIONS[key].slice(0, 500) && claim.definitionVersion === 1
    && claim.source.system === 'outcomes' && claim.source.role === 'business_truth'
    && claim.source.evidencePlane === 'outcome_business' && claim.source.head === null
    && claim.entity.level === 'business' && claim.entity.id === entityId
    && claim.attributionScope === 'all_sources' && claim.measurementKind === (inputs.length ? 'derived' : 'operational')
    && claim.window.start === range.from && claim.window.end === range.to
    && claim.window.basis === 'booking_created_date_et' && claim.window.timezone === data.context.timezone
    && claim.comparison.method === (period === 'current' ? 'prior_equal_period' : 'none')
    && (period === 'prior' || claim.comparison.window?.start === data.context.comparison.from
      && claim.comparison.window.end === data.context.comparison.to
      && claim.comparison.window.basis === 'booking_created_date_et'
      && claim.comparison.window.timezone === data.context.timezone)
    && (period === 'current' || claim.comparison.window === null)
    && claim.asOf === data.business.asOf && claim.freshness.state === 'unknown'
    && claim.freshness.observedAt === claim.asOf && claim.freshness.maxAgeHours === null
    && claim.maturity.matureThrough === matureThrough
    && claim.maturity.state === (range.to <= matureThrough ? 'settled' : 'partial')
    && claim.coverage.state === 'complete' && Number.isSafeInteger(claim.coverage.numerator)
    && claim.coverage.numerator === claim.coverage.denominator
    && claim.setupFingerprint === null && claim.authority.state === 'diagnostic'
    && claim.authority.policyVersion === 'reporting-v1'
    && JSON.stringify(claim.inputClaimIds) === JSON.stringify(inputs)
    && (claim.availability.state === 'unavailable' && claim.value === null
      || claim.availability.state === 'available' && typeof claim.value === 'number' && Number.isFinite(claim.value)
        && claim.value >= 0 && (claim.unit !== 'count' || Number.isSafeInteger(claim.value)))
}

function horizonEvidence(data: ReportingData, index: number) {
  const followup = data.business.data?.intelligence?.customers.data?.followup
  const horizon = HORIZONS[index]
  const row = followup?.horizons[index]
  if (!row || row.id !== horizon.id || row.name !== horizon.name
    || Object.keys(row.metrics).sort().join('|') !== [...KEYS].sort().join('|')) return null
  const entityId = `${data.context.account.id}:customers:followup:${horizon.id}`.slice(0, 160)
  const refs = Object.fromEntries(KEYS.map(key => [key, metricEvidence(data, 'business', path(index, key))])) as Record<Key, ReviewEvidence | null>
  for (const key of KEYS) for (const period of ['current', 'prior'] as const) {
    const metric = refs[key]?.metric, claim = period === 'current' ? metric?.current : metric?.previous
    if (!metric || !nativeClaim(data, metric, claim ?? null, key, period === 'current' ? data.context.range : data.context.comparison,
      entityId, period, horizon.days, followup.observedThrough)) return null
  }
  for (const period of ['current', 'prior'] as const) {
    const cohort = value(refs.cohort_customers, period), eligible = value(refs.eligible_customers, period)
    const repeats = value(refs.repeat_customers, period), bookings = value(refs.repeat_bookings, period)
    const booked = value(refs.repeat_booked_value, period), rate = value(refs.repeat_rate, period)
    const perEligible = value(refs.repeat_booked_value_per_eligible_customer, period)
    const claim = (key: Key) => period === 'current' ? refs[key]!.metric.current : refs[key]!.metric.previous!
    if (cohort === null || eligible === null || repeats === null || bookings === null || booked === null
      || eligible > cohort || repeats > eligible || bookings < repeats
      || claim('cohort_customers').coverage.denominator !== cohort
      || claim('eligible_customers').coverage.denominator !== cohort
      || ['repeat_customers', 'repeat_rate', 'repeat_bookings', 'repeat_booked_value', 'repeat_booked_value_per_eligible_customer']
        .some(key => claim(key as Key).coverage.denominator !== eligible)
      || (eligible === 0 ? rate !== null || perEligible !== null
        : rate === null || perEligible === null || !close(rate, repeats / eligible * 100) || !close(perEligible, booked / eligible))) return null
  }
  return { horizon, refs }
}

function unavailable(data: ReportingData, reason: string): ReviewFinding {
  const finding = unavailableFinding(data, { id: 'business_customer_followup', area: 'business',
    title: 'Equal-follow-up customer results', reason, href: '/reports' })
  return { ...finding, nextInspection: { ...finding.nextInspection,
    href: `${reportLink(data, '/reports', { report: 'business' })}#business-customer-followup` } }
}

/** A matched-horizon first-observed cohort assessment; no identity or acquisition claim leaves the report. */
export function deriveCustomerFollowupReview(data: ReportingData): ReviewFinding | null {
  const section = data.business.data?.intelligence?.customers
  const followup = section?.data?.followup
  if (!followup) return null
  try {
    if (!['available', 'partial'].includes(data.business.state) || !['available', 'partial'].includes(section.state)
      || !section.asOf || !data.business.asOf || compareInstants(section.asOf, data.business.asOf) > 0
      || section.asOf !== data.business.asOf
      || compareInstants(data.business.asOf, data.context.asOf) > 0 || followup.observedThrough > etDateOf(section.asOf)) {
      return unavailable(data, 'The follow-up observation does not match this report’s source identity or observation date.')
    }
  } catch { return unavailable(data, 'The follow-up source clocks are invalid.') }
  const rows = HORIZONS.map((_, index) => horizonEvidence(data, index))
  if (rows.some(row => !row)) return unavailable(data, 'The supplied follow-up horizons or native outcome claims are invalid.')
  const selected = rows.find(row => row && value(row.refs.eligible_customers, 'current')! > 0
    && value(row.refs.eligible_customers, 'prior')! > 0
    && value(row.refs.repeat_rate, 'current') !== null && value(row.refs.repeat_rate, 'prior') !== null)
  if (!selected) return unavailable(data, 'No current and prior first-observed cohort has an eligible customer at the same supplied horizon.')
  const refs = selected.refs
  const currentEligible = value(refs.eligible_customers, 'current')!, priorEligible = value(refs.eligible_customers, 'prior')!
  const currentRepeat = value(refs.repeat_customers, 'current')!, priorRepeat = value(refs.repeat_customers, 'prior')!
  const currentRate = value(refs.repeat_rate, 'current')!, priorRate = value(refs.repeat_rate, 'prior')!
  const currentBookings = value(refs.repeat_bookings, 'current')!, priorBookings = value(refs.repeat_bookings, 'prior')!
  const currentBooked = value(refs.repeat_booked_value, 'current')!, priorBooked = value(refs.repeat_booked_value, 'prior')!
  const currentPer = value(refs.repeat_booked_value_per_eligible_customer, 'current')!
  const priorPer = value(refs.repeat_booked_value_per_eligible_customer, 'prior')!
  const rateChange = currentRate - priorRate, valueChange = currentPer - priorPer
  const opposite = rateChange * valueChange < 0
  const direction = opposite ? 'mixed' : rateChange < 0 || rateChange === 0 && valueChange < 0 ? 'declined'
    : rateChange > 0 || valueChange > 0 ? 'improved' : undefined
  const observation = `At ${selected.horizon.name}, ${currentRepeat} of ${currentEligible} eligible current-cohort customers repeated (${display(currentRate, 'percent')}), with ${currentBookings} repeat ${OW.many} and ${display(currentBooked, 'money')} repeat booked value (${display(currentPer, 'money')} per eligible customer). Prior: ${priorRepeat} of ${priorEligible} eligible customers (${display(priorRate, 'percent')}), ${priorBookings} repeat ${OW.many} and ${display(priorBooked, 'money')} (${display(priorPer, 'money')} per eligible customer). Observed through ${followup.observedThrough}.`
  return {
    id: 'business_customer_followup', area: 'business', title: 'Equal-follow-up customer results',
    status: direction === 'mixed' ? 'mixed' : direction ? 'observed' : 'unchanged', direction,
    priority: direction ? 'investigate' : 'context',
    observation: statement(observation, ...Object.values(refs)),
    materiality: { ...statement(`${selected.horizon.name} compares ${currentEligible} eligible current-cohort customers with ${priorEligible} eligible prior-cohort customers after the same elapsed time.`, refs.eligible_customers),
      priorityReason: 'Equal follow-up prevents unequal cohort age from deciding the repeat-result comparison.' },
    explanations: [{ hypothesis: `The observed difference may reflect customer mix, service mix or later ${OW.one} behavior within the equal horizon.`,
      evidence: statement('', refs.repeat_rate, refs.repeat_booked_value_per_eligible_customer).evidence,
      missing: ['Matched service and customer-context evidence for the eligible first-observed cohorts.'] }],
    counterEvidence: statement(opposite
      ? 'Repeat rate and repeat booked value per eligible customer move in opposite directions, so the result is mixed.'
      : 'These cohort results do not establish why customers repeated or whether advertising caused the difference.',
    refs.repeat_rate, refs.repeat_booked_value_per_eligible_customer),
    nextInspection: { question: `Which first-observed cohort and service records explain the ${selected.horizon.name} repeat result?`,
      href: `${reportLink(data, '/reports', { report: 'business' })}#business-customer-followup`, outcomes: [
        { result: 'The difference persists across eligible service groups.', interpretation: 'Treat it as an observed customer-repeat pattern and investigate the contributing services.' },
        { result: 'Service mix or sparse eligible groups explain the aggregate.', interpretation: 'Qualify the aggregate and retain the exact eligible sample.' },
      ] },
    limitations: [...section.notes,
      'First observed in retained history does not establish acquisition; earlier history outside the retained ledger remains unknown.',
      `Results use current mutable ${OW.one} facts through the observation date, not historical payment snapshots, paid attribution, profit or causality.`,
      `Same-day ${OW.many} do not establish a later ${OW.one} sequence.`],
    exposure: null, authority: { state: 'diagnostic', executable: false },
  }
}
