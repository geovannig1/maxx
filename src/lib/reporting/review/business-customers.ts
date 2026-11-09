import { formatMoneyTrim } from '@/lib/utils/format-currency'
import { ReportingContextSchema, ReportingDateSchema, type ReportMetric, type ReportingData } from '../contracts'
import { BUSINESS_CUSTOMER_DEFINITIONS } from '../business-intelligence-metrics'
import { BUSINESS_DRIVER_DEFINITIONS } from '../business-driver-definitions'
import { compareCreativeEvidenceInstants as compareInstants } from '../creative-assignment-contract'
import type { ReviewEvidence, ReviewFinding } from './contracts'
import { metricEvidence, reportLink, statement, unavailableFinding } from './evidence'
import { outcomeWords } from '@/config/outcome-nouns'

// What this business calls its outcomes (NEXT_PUBLIC_OUTCOME_NOUN).
const OW = outcomeWords()

type Claim = ReportMetric['current']
type Period = 'current' | 'prior'
type Field = { ref: ReviewEvidence | null; current: Claim | null; prior: Claim | null; change: number | null }
const GROUPS = [
  ['prior_booking', `Prior ${OW.one} in retained history`], ['first_observed', 'First observed in retained history'],
  ['unidentified', `Unidentified ${OW.many}`],
] as const
const UNITS = { bookings: 'count', booked_value: 'money', amount_paid: 'money', paid_bookings: 'count',
  recorded_booked_hours: 'hours', duration_recorded_bookings: 'count', duration_coverage: 'percent' } as const
type Key = keyof typeof UNITS
type Group = { id: string; name: string; fields: Record<Key, Field> }
const amount = (claim: Claim | null) => claim?.value as number | undefined ?? null
const number = (value: number) => value.toLocaleString('en-US', { maximumFractionDigits: 2 })
const shown = (value: number | null, unit = 'count') => value === null ? 'unavailable' : (unit === 'money' ? formatMoneyTrim(value) : number(value))
const signed = (value: number, unit = 'money') => value === 0 ? 'unchanged' : `${value > 0 ? '+' : '−'}${shown(Math.abs(value), unit)}`
const close = (a: number, b: number) => Math.abs(a - b) <= Number.EPSILON * 8 * Math.max(Math.abs(a), Math.abs(b), Number.MIN_VALUE)
const complete = (claim: Claim | null) => !!claim && claim.coverage.state === 'complete'
const emptyField = (): Field => ({ ref: null, current: null, prior: null, change: null })

function sourceValid(data: ReportingData): boolean {
  const section = data.business.data?.intelligence?.customers, report = section?.data
  try {
    return ReportingContextSchema.safeParse(data.context).success && ['available', 'partial'].includes(data.business.state)
      && !!section && ['available', 'partial'].includes(section.state) && !!report && !!section.asOf && !!data.business.asOf
      && compareInstants(section.asOf, data.business.asOf) <= 0 && compareInstants(data.business.asOf, data.context.asOf) <= 0
      && report.identityBasis === 'normalized_email' && report.historyCoverage === 'retained_ledger'
      && report.historyTo === data.context.range.to && (report.historyFrom === null
        || ReportingDateSchema.safeParse(report.historyFrom).success && report.historyFrom <= report.historyTo)
  } catch { return false }
}

function nativeClaim(data: ReportingData, ref: ReviewEvidence | null, key: string, unit: Claim['unit'], definition: string,
  entity: string, observedAt: string, period: Period): Claim | null {
  const metric = ref?.metric, claim = period === 'current' ? metric?.current : metric?.previous
  const range = period === 'current' ? data.context.range : data.context.comparison
  if (!metric || !claim || metric.key !== key || metric.event !== null || metric.definition !== definition
    || claim.claimId !== `report:outcomes:business:${entity.slice(0, 160)}:${key}:${range.from}:${range.to}`
    || claim.metricKey !== `outcomes.${key}` || claim.formula !== definition.slice(0, 500) || claim.definitionVersion !== 1
    || claim.source.system !== 'outcomes' || claim.source.role !== 'business_truth' || claim.source.evidencePlane !== 'outcome_business'
    || claim.source.head !== null || claim.entity.level !== 'business' || claim.entity.id !== entity.slice(0, 160) || claim.unit !== unit
    || claim.attributionScope !== 'all_sources' || claim.measurementKind !== 'operational' || claim.inputClaimIds.length !== 0
    || claim.authority.state !== 'diagnostic' || claim.authority.policyVersion !== 'reporting-v1' || claim.setupFingerprint !== null
    || claim.window.start !== range.from || claim.window.end !== range.to || claim.window.timezone !== data.context.timezone
    || claim.window.basis !== 'booking_created_date_et' || claim.freshness.state === 'stale' || claim.maturity.state === 'partial'
    || claim.availability.state !== 'available' || typeof claim.value !== 'number' || !Number.isFinite(claim.value)
    || key !== 'amount_paid' && claim.value < 0 || unit === 'count' && !Number.isSafeInteger(claim.value)
    || !['complete', 'partial'].includes(claim.coverage.state) || !Number.isSafeInteger(claim.coverage.numerator)
    || !Number.isSafeInteger(claim.coverage.denominator) || claim.coverage.numerator! < 0
    || claim.coverage.numerator! > claim.coverage.denominator!
    || claim.coverage.state === 'complete' && claim.coverage.numerator !== claim.coverage.denominator) return null
  try {
    if (compareInstants(claim.asOf, observedAt) !== 0 || compareInstants(claim.asOf, data.context.asOf) > 0
      || claim.freshness.observedAt && compareInstants(claim.freshness.observedAt, claim.asOf) > 0) return null
  } catch { return null }
  return claim
}

function canCompare(data: ReportingData, current: Claim | null, prior: Claim | null): boolean {
  const comparison = current?.comparison, range = data.context.comparison
  return complete(current) && complete(prior) && comparison?.method === 'prior_equal_period'
    && comparison.window?.start === range.from && comparison.window.end === range.to
    && comparison.window.timezone === data.context.timezone && comparison.window.basis === 'booking_created_date_et'
    && prior?.comparison.method === 'none' && prior.comparison.window === null
}
function field(data: ReportingData, path: (string | number)[], key: string, unit: Claim['unit'], definition: string,
  entity: string, observedAt: string): Field {
  const ref = metricEvidence(data, 'business', [...path, key])
  const current = nativeClaim(data, ref, key, unit, definition, entity, observedAt, 'current')
  const prior = nativeClaim(data, ref, key, unit, definition, entity, observedAt, 'prior')
  const change = canCompare(data, current, prior) ? amount(current)! - amount(prior)! : null
  return { ref: current || prior ? ref : null, current, prior, change: change !== null && Number.isFinite(change) ? change : null }
}

function groupFields(data: ReportingData, id: string, index: number, observedAt: string): Record<Key, Field> {
  const fields = Object.fromEntries(Object.entries(UNITS).map(([key, unit]) => [key, index < 0 ? emptyField()
    : field(data, ['intelligence', 'customers', 'data', 'groups', index, 'metrics'], key, unit,
      BUSINESS_CUSTOMER_DEFINITIONS[key] ?? BUSINESS_DRIVER_DEFINITIONS[key as keyof typeof BUSINESS_DRIVER_DEFINITIONS],
      `${data.context.account.id}:customers:${id}`, observedAt)])) as Record<Key, Field>
  for (const period of ['current', 'prior'] as const) {
    const bookings = fields.bookings[period]
    if (bookings && (amount(bookings) !== bookings.coverage.denominator || !complete(bookings))) fields.bookings[period] = null
    const count = amount(fields.bookings[period])
    for (const key of ['booked_value', 'amount_paid', 'paid_bookings'] as const) {
      const claim = fields[key][period]
      if (!claim) continue
      if (key === 'paid_bookings' && amount(claim)! > claim.coverage.numerator!
        || claim.coverage.numerator === 0 && (amount(claim) !== 0 || claim.coverage.denominator !== 0)
        || key === 'booked_value' && claim.coverage.numerator! > 0 && amount(claim)! <= 0) fields[key][period] = null
    }
    const hours = fields.recorded_booked_hours[period], dated = fields.duration_recorded_bookings[period]
    const coverage = fields.duration_coverage[period], recorded = amount(dated)
    const validHours = hours && count !== null && dated && complete(dated) && recorded! <= count
      && hours.coverage.denominator === count && hours.coverage.numerator === recorded && dated.coverage.denominator === count
      && (recorded === 0 ? amount(hours) === 0 && count === 0
        : amount(hours)! > 0 && coverage && coverage.coverage.denominator === count && close(amount(coverage)!, recorded! / count * 100))
    if (hours && !validHours) fields.recorded_booked_hours[period] = null
  }
  for (const [key, value] of Object.entries(fields)) {
    const paymentPopulation = !['amount_paid', 'paid_bookings'].includes(key) || (['current', 'prior'] as const).every(period =>
      !fields.bookings[period] || value[period]?.coverage.denominator === amount(fields.bookings[period]))
    value.change = paymentPopulation && canCompare(data, value.current, value.prior) ? amount(value.current)! - amount(value.prior)! : null
    if (value.change !== null && !Number.isFinite(value.change)) value.change = null
    if (!value.current && !value.prior) value.ref = null
  }
  return fields
}

function total(groups: Group[], key: Key, period: Period): number | null {
  const claims = groups.map(group => group.fields[key][period])
  if (!claims.every(complete)) return null
  const sum = claims.reduce((sum, claim) => sum + amount(claim)!, 0)
  return Number.isFinite(sum) ? sum : null
}
function movement(groups: Group[], key: Key): number | null {
  if (!groups.every(group => group.fields[key].change !== null)) return null
  const change = total(groups, key, 'current')! - total(groups, key, 'prior')!
  return Number.isFinite(change) ? change : null
}
function periodText(label: string, value: Field, unit: string): string {
  const qualified = (claim: Claim | null) => `${shown(amount(claim), unit)}${claim && !complete(claim)
    ? `, partial observed subtotal (${claim.coverage.numerator} of ${claim.coverage.denominator} ${OW.many})` : ''}`
  return `${label}: ${qualified(value.current)} (prior ${qualified(value.prior)}${value.change === null ? '' : `; ${signed(value.change, unit)}`}).`
}
function groupText(group: Group): string {
  const booked = group.fields.booked_value, count = group.fields.bookings
  const missingCount = !count.current || !count.prior
  const comparisonLimit = booked.change !== null ? '' : !booked.current || !booked.prior
    ? ' Booked-value comparison unavailable: a native period is missing or invalid.'
    : !complete(booked.current) || !complete(booked.prior)
      ? ' Incomplete price coverage withholds a complete-period comparison.'
      : ' Native comparison metadata is incompatible; booked-value comparison is withheld.'
  return `${periodText(group.name, booked, 'money')} ${shown(amount(count.current))} ${OW.many} (prior ${shown(amount(count.prior))}).${comparisonLimit}${missingCount
    ? ` Native ${OW.many} unavailable or invalid in a period; full-population reconciliation is withheld.` : ''}`
}
function reconciliation(data: ReportingData, groups: Group[], population: boolean, observedAt: string, limits: string[]) {
  const values = field(data, ['metrics'], 'booked_value', 'money', BUSINESS_DRIVER_DEFINITIONS.booked_value, data.context.account.id, observedAt)
  const bookings = field(data, ['metrics'], 'value_bearing_bookings', 'count', BUSINESS_DRIVER_DEFINITIONS.value_bearing_bookings, data.context.account.id, observedAt)
  let matched = population
  for (const period of ['current', 'prior'] as const) {
    for (const [key, headline] of [['booked_value', values], ['bookings', bookings]] as const) {
      const sum = population ? total(groups, key, period) : null, expected = amount(headline[period])
      const paired = groups.every(group => {
        const count = group.fields.bookings[period], value = group.fields.booked_value[period]
        return !!count && !!value && value.coverage.denominator === amount(count) && (amount(count) === 0) === (amount(value) === 0)
      })
      const valid = paired && sum !== null && complete(headline[period]) && expected !== null && close(sum, expected)
      if (!valid) limits.push(`${period} ${key === 'booked_value' ? 'booked value' : `value-bearing ${OW.many}`} do not reconcile: customer groups ${shown(sum, key === 'booked_value' ? 'money' : 'count')}, headline ${shown(expected, key === 'booked_value' ? 'money' : 'count')}. Whole-business contribution is withheld.`)
      matched &&= valid
    }
  }
  return { matched: matched && values.change !== null && bookings.change !== null, values, bookings }
}

function fieldLimits(groups: Group[]): string[] {
  return groups.flatMap(group => Object.entries(UNITS).flatMap(([key, unit]) => {
    if (key === 'duration_coverage' || key === 'duration_recorded_bookings') return []
    const value = group.fields[key as Key], label = key.replaceAll('_', ' ')
    const observations = (['current', 'prior'] as const).flatMap(period => {
      const claim = value[period]
      return !claim ? [`${group.name}: ${period} ${label} unavailable or invalid.`]
        : !complete(claim) ? [`${group.name}: ${period} ${label} ${shown(amount(claim), unit)}${unit === 'hours' ? ' hours' : ''} is a partial observed subtotal (${claim.coverage.numerator} of ${claim.coverage.denominator} ${OW.many}); incomplete ${unit === 'hours' ? 'duration' : key === 'booked_value' ? 'price' : 'payment'} coverage withholds a complete-period comparison.`]
          : ['amount_paid', 'paid_bookings'].includes(key) && group.fields.bookings[period]
            && claim.coverage.denominator !== amount(group.fields.bookings[period])
            ? [`${group.name}: ${period} recorded payment observation ${shown(amount(claim), unit)} has a population that disagrees with the native ${OW.one} count; its comparison is withheld.`] : []
    })
    return [...observations, ...(value.current && value.prior && value.change === null && !observations.length
      ? [`${group.name}: ${label} comparison is unavailable because native comparison metadata is incompatible.`] : [])]
  }))
}

function groupCounterEvidence(groups: Group[]): string {
  return groups.flatMap(group => {
    const value = group.fields.booked_value.change
    return value === null ? [] : (['amount_paid', 'recorded_booked_hours'] as const).flatMap(key => {
      const metric = group.fields[key], change = metric.change
      return change !== null && (value * change < 0 || value === 0 && change !== 0)
        ? [`${group.name}: ${periodText(key === 'amount_paid' ? 'recorded payments' : 'recorded hours', metric, key === 'amount_paid' ? 'money' : 'hours')}`] : []
    })
  }).join(' ')
}

/** One prepared explanation over the three supplied retained-ledger groups; no customer-level output. */
export function deriveCustomerReview(data: ReportingData): ReviewFinding {
  const href = `${reportLink(data, '/reports', { report: 'business' })}#business-customers`
  const unavailable = () => {
    const finding = unavailableFinding(data, { id: 'business_customers', area: 'business', title: 'Customer history and business results',
      reason: 'Customer history is unavailable or outside the native account, period or source observation; missing history does not establish newly acquired customers.', href: '/reports' })
    return { ...finding, nextInspection: { ...finding.nextInspection, href } }
  }
  if (!sourceValid(data)) return unavailable()
  const section = data.business.data!.intelligence!.customers, report = section.data!, observedAt = section.asOf!
  const limits: string[] = []
  const groups = GROUPS.map(([id, name]) => {
    const matches = report.groups.flatMap((group, index) => group.id === id ? [index] : [])
    if (matches.length !== 1) limits.push(`${name}: ${matches.length ? 'duplicate' : 'missing'} group; its population cannot enter reconciliation.`)
    return { id, name, fields: groupFields(data, id, matches.length === 1 ? matches[0] : -1, observedAt) }
  })
  const population = report.groups.length === 3 && GROUPS.every(([id]) => report.groups.filter(group => group.id === id).length === 1)
  const headline = reconciliation(data, groups, population, observedAt, limits)
  const headers = Object.fromEntries(['identified_customers', 'prior_booking_customers', 'first_observed_customers', 'unidentified_bookings', 'multiple_booking_customers']
    .map(key => [key, field(data, ['intelligence', 'customers', 'data', 'metrics'], key, 'count', BUSINESS_CUSTOMER_DEFINITIONS[key], `${data.context.account.id}:customers`, observedAt)]))
  const refs = groups.flatMap(group => Object.values(group.fields).map(value => value.ref))
  if (![...refs, ...Object.values(headers).map(value => value.ref)].some(Boolean)) return unavailable()
  const change = movement(groups, 'booked_value'), payments = population ? movement(groups, 'amount_paid') : null
  const hours = population ? movement(groups, 'recorded_booked_hours') : null
  const core = groups.flatMap(group => [group.fields.booked_value.change, group.fields.bookings.change])
  const values = groups.map(group => group.fields.booked_value.change)
  const offset = values.some(value => value !== null && value > 0) && values.some(value => value !== null && value < 0)
  const groupCounter = groupCounterEvidence(groups)
  const against = change === null ? [] : [[payments, 'Recorded payments'], [hours, 'Recorded hours']].flatMap(([value, label]) =>
    typeof value === 'number' && value * change < 0 ? [label] : [])
  const contrary = !!groupCounter || against.length > 0
  const stable = headline.matched && core.every(value => value === 0) && payments === 0 && hours === 0
    && groups.every(group => group.fields.amount_paid.change === 0 && group.fields.recorded_booked_hours.change === 0 && group.fields.paid_bookings.change === 0)
  const empty = stable && amount(headline.bookings.current) === 0 && amount(headline.bookings.prior) === 0
  const leading = headline.matched ? `${periodText('Booked value', headline.values, 'money')} ${shown(amount(headline.bookings.current))} ${OW.many} (prior ${shown(amount(headline.bookings.prior))}).`
    : 'Observed customer groups do not fully explain the value-bearing business headline.'
  const auxiliary = (key: 'amount_paid' | 'recorded_booked_hours', label: string, unit: string) => !population || movement(groups, key) === null ? ''
    : `${label}: ${shown(total(groups, key, 'current'), unit)} (prior ${shown(total(groups, key, 'prior'), unit)}).`
  const observation = `${empty ? `No qualifying ${OW.many} in either period. ` : ''}${leading} ${groups.map(groupText).join(' ')} ${offset ? 'Group gains and losses offset one another. ' : ''}${auxiliary('amount_paid', 'Recorded payments', 'money')} ${auxiliary('recorded_booked_hours', 'Recorded hours', 'hours')}${against.length ? ` ${against.join(' and ')} move against booked value.` : ''}${groupCounter ? ` ${groupCounter}` : ''}`.trim()
  const direction = offset || contrary ? 'mixed' : change === null || change === 0 ? undefined : change > 0 ? 'improved' : 'declined'
  const identified = headers.identified_customers, missing = headers.unidentified_bookings
  const identityCount = (value: Field, label: string) => `${shown(amount(value.current))} ${label} (prior ${shown(amount(value.prior))})`
  const identityText = `${identityCount(identified, 'identified customers')}; ${identityCount(headers.prior_booking_customers, `customers with a prior ${OW.one}`)}; ${identityCount(headers.first_observed_customers, 'first-observed customers')}; ${identityCount(missing, `unidentified ${OW.many}`)}; ${identityCount(headers.multiple_booking_customers, `customers with multiple cohort ${OW.many}`)}.`
  const exposure = headline.values.current && amount(headline.values.current)! >= 0 && complete(headline.values.current)
    ? { value: amount(headline.values.current)!, unit: 'money' as const, evidence: [headline.values.ref!] } : null
  const evidencePeriods = Object.fromEntries([...groups.flatMap(group => Object.values(group.fields)), ...Object.values(headers), headline.values, headline.bookings]
    .flatMap(value => value.ref ? [[value.ref.id, (['current', 'prior'] as const).filter(period => value[period] !== null)]] : []))
  return {
    id: 'business_customers', area: 'business', title: 'Customer history and business results', status: stable ? 'unchanged'
      : offset || contrary || !headline.matched || core.some(value => value === null) || payments === null || hours === null ? 'mixed' : 'observed',
    priority: stable ? 'context' : 'investigate', ...(direction ? { direction } : {}),
    observation: statement(observation, ...refs, headline.values.ref, headline.bookings.ref),
    evidencePeriods,
    materiality: { ...statement(`${identityText} All-source active positive-price ${OW.one}-created cohorts: ${data.context.range.from}–${data.context.range.to} versus ${data.context.comparison.from}–${data.context.comparison.to}, ${data.context.timezone}; observed ${observedAt}. Retained history: ${report.historyFrom ?? 'start unknown'} through ${report.historyTo}.`, ...Object.values(headers).map(value => value.ref)),
      priorityReason: stable ? 'Compatible observed group results are unchanged; no intervention is established.' : 'The customer-group split explains observed booked-value movements and their counterevidence.' },
    explanations: [{ hypothesis: offset ? 'The observed group contributions offset; a headline gain does not mean every customer group grew.'
      : `These are arithmetic contributions from retained ${OW.one} groups, not evidence of why customers booked.`, evidence: statement('', ...refs).evidence,
      missing: ['Complete earlier identity history and evidence of causal customer behavior.'] }],
    counterEvidence: statement(`${groupCounter}${groupCounter ? ' ' : ''}Booked value is scheduled price; recorded payments are current native amount_paid on the same active positive-price cohort, distinct from all-active payment totals and payment-event history. Recorded hours are a duration sample, not attendance, capacity or profit.`, ...groups.flatMap(group => [group.fields.booked_value.ref, group.fields.amount_paid.ref, group.fields.paid_bookings.ref, group.fields.recorded_booked_hours.ref])),
    nextInspection: { question: stable ? 'No intervention is established by these unchanged results; optionally inspect the existing group evidence.'
      : offset || contrary ? 'The offsetting group values and contrary evidence are already identified; inspect the native group records if a business decision requires their context.'
        : amount(missing.current)! > 0 ? `Preserve the unidentified ${OW.one} contribution; inspect identity coverage before interpreting its customer mix.`
          : 'Use the observed group movement as business context; inspect the native evidence only where a decision needs more detail.', href,
      outcomes: [{ result: 'The same native populations and observations remain supported.', interpretation: 'Retain the observed group explanation without inferring acquisition or paid causation.' },
        { result: 'Coverage or earlier retained identity history changes.', interpretation: 'Revise only the affected observations or group classification.' }] },
    limitations: [...limits, ...fieldLimits(groups), ...section.notes,
      'First observed in retained history is not a confirmed newly acquired customer. Earlier history is incomplete; the same identity can occupy different groups in different periods.',
      `Missing identity retains ${OW.one} and monetary contributions but does not establish a customer count. Current mutable ledger facts do not establish historical customer or payment snapshots.`],
    exposure, authority: { state: 'diagnostic', executable: false },
  }
}
