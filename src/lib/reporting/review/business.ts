import type { ReportingData } from '../contracts'
import type { ReviewEvidence, ReviewFinding } from './contracts'
import { display, metricEvidence, numeric, reportLink, statement, unavailableFinding } from './evidence'
import { businessChange, businessDetailHref, businessEvidence, businessExposure, businessPeriod,
  deriveBusinessIntelligenceReview, unavailableBusiness } from './business-intelligence'
import { deriveBusinessDriverReview } from './business-drivers'
import { deriveBusinessPlatformReview } from './business-platform'
import { outcomeWords } from '@/config/outcome-nouns'

// What this business calls its outcomes (NEXT_PUBLIC_OUTCOME_NOUN).
const OW = outcomeWords()

type Evidence = ReviewEvidence | null
const authority = { state: 'diagnostic', executable: false } as const
const businessHref = (data: ReportingData, anchor = 'business-results') => `${reportLink(data, '/reports', { report: 'business' })}#${anchor}`
const amount = (ref: Evidence) => numeric(ref?.metric)
const show = (ref: Evidence) => display(ref?.metric)
const businessUnits = { amount_paid: 'money', booked_value: 'money', paid_bookings: 'count', active_appointments: 'count',
  unknown_payment_count: 'count', payment_coverage: 'percent' } as const
const withUnit = (ref: Evidence, unit: 'money' | 'count' | 'percent'): Evidence => ref?.metric.current.unit === unit ? ref : null
const metric = (data: ReportingData, key: keyof typeof businessUnits, path: readonly (string | number)[] = ['metrics', key]) =>
  withUnit(metricEvidence(data, 'business', path), businessUnits[key])

function unavailable(data: ReportingData, id: string, title: string, reason: string, anchor = 'business-results'): ReviewFinding {
  const finding = unavailableFinding(data, { id, area: 'business', title, reason, href: '/reports' })
  return { ...finding, nextInspection: { ...finding.nextInspection, href: businessHref(data, anchor) } }
}

function exposure(ref: Evidence, unit: 'money' | 'count'): ReviewFinding['exposure'] {
  const value = amount(ref)
  return ref && ref.metric.current.unit === unit && value !== null && value >= 0 ? { value, unit, evidence: [ref] } : null
}

function incomplete(ref: Evidence, prior = false): boolean {
  const claim = prior ? ref?.metric.previous : ref?.metric.current
  return !!claim && claim.coverage.state !== 'complete'
}

function paymentCoverage(data: ReportingData): ReviewFinding {
  const paid = metric(data, 'amount_paid'), bookings = metric(data, 'paid_bookings')
  const active = metric(data, 'active_appointments'), unknown = metric(data, 'unknown_payment_count')
  const percent = metric(data, 'payment_coverage'), booked = metric(data, 'booked_value')
  const refs = [paid, bookings, active, unknown, percent]
  if (refs.every(ref => amount(ref) === null)) return unavailable(data, 'business_payment_coverage', 'Recorded payments and coverage',
    `Recorded payment fields and the active ${OW.one} population are unavailable for this scope.`)
  const coverage = paid?.metric.current.coverage ?? bookings?.metric.current.coverage
  const zeroPopulation = amount(active) === 0
  const observedCoverage = coverage && coverage.state !== 'unknown' && coverage.numerator !== null && coverage.denominator !== null
    ? `${coverage.numerator} of ${coverage.denominator} active ${OW.many} have recorded native payment fields.`
    : 'Native payment-field coverage is unavailable.'
  const partial = [paid, bookings].some(ref => incomplete(ref))
  const priorPartial = [paid, bookings].some(ref => incomplete(ref, true))
  const bookingCoverage = bookings?.metric.current.coverage
  const complete = !zeroPopulation && refs.every(ref => amount(ref) !== null && ref?.metric.current.coverage.state === 'complete')
    && amount(unknown) === 0 && amount(percent) === 100 && coverage?.numerator === amount(active) && coverage?.denominator === amount(active)
    && bookingCoverage?.numerator === amount(active) && bookingCoverage?.denominator === amount(active)
  const bounds = partial ? 'The recorded payment count and amount are observed lower bounds.'
    : priorPartial ? 'Prior payment coverage is incomplete; a matched payment comparison is unavailable.'
      : complete ? 'The current native payment-field population is complete.'
        : 'Native payment completeness cannot be confirmed from the available payment claims and population controls.'
  return {
    id: 'business_payment_coverage', area: 'business', title: 'Recorded payments and coverage',
    status: priorPartial || !complete ? 'mixed' : 'observed',
    observation: statement([
      zeroPopulation ? `There are 0 active ${OW.many}; payment-field coverage has no denominator.` : observedCoverage,
      `${show(unknown)} unknown payment records. Recorded amount paid: ${show(paid)}; paid ${OW.many}: ${show(bookings)}.`, bounds,
    ].join(' '), ...refs),
    materiality: { ...statement(`The current scope contains ${show(active)} active ${OW.many} and ${show(paid)} recorded amount paid.`, active, paid),
      priorityReason: 'Payment completeness controls how much of the business amount can be interpreted.' },
    explanations: [
      { hypothesis: `Missing native payment fields could leave paid amounts or positive-payment ${OW.one} counts unobserved.`,
        evidence: statement('', paid, bookings, unknown).evidence, missing: ['Validated native amount_paid values for records with unknown payment fields.'] },
      { hypothesis: `${OW.One} price and recorded payments can differ with ${OW.one} terms or payment timing.`,
        evidence: statement('', paid, booked).evidence, missing: [`${OW.One} terms, payment chronology and settlement evidence.`] },
    ],
    counterEvidence: statement(`Booked value (${show(booked)}) records scheduled price. Amount paid (${show(paid)}) records native payment fields; the two definitions require ${OW.one}-level reconciliation.`, booked, paid),
    nextInspection: {
      question: `In the business results, which unknown native payment fields need ${OW.one}-level checking?`, href: businessHref(data),
      outcomes: [
        { result: 'Validated payment values fill previously unknown records.', interpretation: 'Recompute the recorded total and its matched comparison before concluding that paid activity declined.' },
        { result: 'Both periods have complete native payment fields.', interpretation: `A like-for-like change in the recorded payment amount can be described within the ${OW.one}-created population.` },
      ],
    },
    limitations: ['Booked value minus amount paid does not establish an outstanding balance.',
      'Native payment fields do not establish processor settlement.'],
    exposure: exposure(paid, 'money') ?? exposure(active, 'count'), authority,
  }
}

function serviceReviews(data: ReportingData): ReviewFinding[] {
  return (data.business.data?.types ?? []).map((row, index) => {
    const get = (key: 'amount_paid' | 'active_appointments' | 'paid_bookings') => businessEvidence(data, key,
      key === 'amount_paid' ? 'money' : 'count', ['types', index, 'metrics', key], `:type:${row.id}`)
    const paid = get('amount_paid'), active = get('active_appointments'), paidBookings = get('paid_bookings')
    const duration = (key: string, unit: 'hours' | 'count') => businessEvidence(data, key, unit,
      ['types', index, 'metrics', key], `:type:${row.id}`)
    const hours = duration('recorded_booked_hours', 'hours'), mean = duration('hours_per_recorded_booking', 'hours')
    const valueBookings = duration('value_bearing_bookings', 'count')
    const id = `business_type:${encodeURIComponent(row.id)}`
    if ([paid, active, paidBookings].every(ref => amount(ref) === null)) return unavailableBusiness(data, id, `${row.name} · service assessment`,
      'Native service amounts and counts are unavailable or incompatible with this scope.', 'business-types')
    const paymentChange = businessChange(data, paid), countChange = businessChange(data, active)
    const hoursChange = businessChange(data, hours), valueCountChange = businessChange(data, valueBookings)
    const moreBookingsFewerHours = valueCountChange !== null && valueCountChange > 0 && hoursChange !== null && hoursChange < 0
    const deltas = [paymentChange, countChange, hoursChange].filter((value): value is number => value !== null)
    const positive = deltas.some(value => value > 0), negative = deltas.some(value => value < 0)
    const direction = positive && negative ? 'mixed' : negative ? 'declined' : positive ? 'improved' : undefined
    const durationLimited = hours !== null && hoursChange === null
    const limited = [paid, active, paidBookings].some(ref => amount(ref) === null || incomplete(ref) || incomplete(ref, true))
      || paymentChange === null || countChange === null || durationLimited
    const countPrior = active && businessChange(data, active) !== null ? display(active.metric, true) : 'unavailable'
    const change = paymentChange === null ? 'A matched payment comparison is unavailable.'
      : paymentChange < 0 ? 'Recorded payments fell.' : paymentChange > 0 ? 'Recorded payments rose.' : 'Matched recorded payments are unchanged.'
    const bounds = [paid, paidBookings].some(ref => incomplete(ref) || incomplete(ref, true))
      ? ' Incomplete payment fields leave observed lower bounds; they do not establish a paid-value decline.' : ''
    const durationText = hours ? ` ${businessPeriod(data, 'Recorded booked hours', hours)} ${businessPeriod(data, `Hours per duration-recorded ${OW.one}`, mean)}${moreBookingsFewerHours ? ` More ${OW.many} contain fewer recorded hours; inspect duration and service mix before treating ${OW.one} growth as stronger demand.` : ''}${hoursChange === null ? ' Duration coverage or its matched comparison is limited; this does not establish a decline in booked hours.' : ''}` : ''
    return {
      id, area: 'business', title: `${row.name} · service assessment`, status: direction || limited ? 'mixed' : 'unchanged', direction,
      priority: direction ? 'investigate' : 'context',
      observation: statement(`${row.name} (service ${row.id}), ${data.context.range.from}–${data.context.range.to}, ${data.context.timezone}: ${show(active)} active ${OW.many} (prior ${countPrior}). ${businessPeriod(data, 'All-source amount paid', paid)} ${businessPeriod(data, `Paid ${OW.many}`, paidBookings)} ${change}${paymentChange !== null && countChange !== null && paymentChange * countChange < 0 ? ` ${OW.One} count and recorded payment move in opposite directions.` : ''}${bounds}${durationText}`, paid, active, paidBookings, hours, mean, valueBookings),
      materiality: { ...statement(`${row.name}: ${show(active)} active ${OW.many} and ${show(paid)} recorded amount paid.`, active, paid),
        priorityReason: 'Each returned service is assessed, including prior-only and lower-value services; all-source amounts are not media return.' },
      explanations: [{ hypothesis: `${OW.One} volume, service terms or recorded payment timing may explain the observed pattern.`,
        evidence: statement('', active, paid, paidBookings).evidence, missing: [`Comparable ${OW.one} terms and payment chronology.`] }],
      counterEvidence: statement('Missing or incomplete payment evidence can change the interpretation. Service labels do not establish customer personas, and recorded amount paid is not processor settlement or profit.', paid, active),
      nextInspection: { question: moreBookingsFewerHours ? `Which recorded durations explain more ${OW.many} but fewer hours for ${row.name}?`
        : direction && paymentChange === null ? `Which service details explain the ${OW.one}-count ${direction === 'declined' ? 'decrease' : 'increase'} in ${row.name} while payment comparison remains limited?`
        : direction === 'mixed' ? `Why do ${OW.one} count and recorded payment differ for ${row.name}?`
        : direction === 'declined' ? `Which ${OW.one} counts and recorded payments account for the observed decrease in ${row.name}?`
          : direction === 'improved' ? `Which ${OW.one} counts and recorded payments support the observed increase in ${row.name}?`
            : durationLimited ? `Which missing duration records or prior measures limit the ${row.name} hours comparison?`
              : limited ? `Which payment fields or prior measures limit the ${row.name} comparison?`
              : `Does the ${OW.one} and payment detail support the unchanged ${row.name} result?`,
        href: businessDetailHref(data, 'business-types'), outcomes: [
          { result: 'Compatible counts and complete payments retain the contrast.', interpretation: 'Describe that service-level change while keeping volume and recorded payment distinct.' },
          { result: 'Missing payments or changed service terms alter the pattern.', interpretation: 'Revise the observation; do not attribute the change to advertising without supporting links.' },
        ] },
      limitations: [`All-source ${OW.one}-created service cohorts; service labels are not verified audience definitions.`,
        ...(hours ? [`Duration uses active positive-price ${OW.many} in the current retained schedule, not attendance or original ${OW.one}-time hours; incomplete samples cannot establish an hours decline.`] : []),
        ...(limited ? ['Some native fields or matched comparisons are unavailable or incomplete.'] : []),
        'Current ledger facts do not establish historical payment snapshots.'],
      exposure: businessExposure(paid) ?? businessExposure(active), authority,
    } satisfies ReviewFinding
  })
}

function appointmentTypes(data: ReportingData, services: ReviewFinding[]): ReviewFinding {
  const usable = services.filter(item => item.status !== 'unavailable')
  if (!usable.length) return unavailableBusiness(data, 'business_type_contribution', `${OW.One}-type coverage`,
    `Native ${OW.one}-type amounts and counts are unavailable; their contribution cannot be measured.`, 'business-types')
  const paid = businessEvidence(data, 'amount_paid', 'money'), active = businessEvidence(data, 'active_appointments', 'count')
  const refs = usable.flatMap(item => item.observation.evidence)
  const limited = usable.length !== services.length || usable.some(item => item.limitations.some(note => note.startsWith('Some native')))
  return {
    id: 'business_type_contribution', area: 'business', title: `${OW.One}-type coverage`, status: limited ? 'mixed' : 'observed', priority: 'context',
    observation: statement(`${usable.length} of ${services.length} returned service rows have usable native observations across the current/prior union. All-source totals: ${show(active)} active ${OW.many}; amount paid ${show(paid)}. Each service has its own assessment and supported comparison.`, active, paid, ...refs),
    materiality: { ...statement(`The review retains every supplied service rather than selecting by current amount: ${services.length} rows.`, ...refs), priorityReason: 'Population coverage retains prior-only and lower-value service changes.' },
    explanations: [], counterEvidence: statement('Coverage of returned rows does not establish complete source retrieval. Service assessments retain missing payment and comparison limits.', ...refs),
    nextInspection: { question: 'Which service changes explain the business result, including smaller and prior-only services?', href: businessDetailHref(data, 'business-types'), outcomes: [
      { result: 'Complete comparable service rows explain the movement.', interpretation: 'Connect the observed volume and recorded-payment changes to their named services.' },
      { result: 'Payment or source coverage remains limited.', interpretation: 'Keep the measured observations while withholding unsupported totals or rankings.' },
    ] },
    limitations: ['This describes supplied service coverage, not paid attribution or verified customer personas.', ...(limited ? ['Some payment fields or comparisons are incomplete.'] : [])],
    exposure: null, authority,
  }
}

/** The outcome source remains business truth. These checks never join it to attributed Meta outcomes. */
export function deriveBusinessReview(data: ReportingData): ReviewFinding[] {
  const services = serviceReviews(data)
  return [deriveBusinessDriverReview(data), deriveBusinessPlatformReview(data), paymentCoverage(data), appointmentTypes(data, services), ...services, ...deriveBusinessIntelligenceReview(data)]
}
