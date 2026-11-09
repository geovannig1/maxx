import type { ReportingData } from '../contracts'
import type { ReviewFinding } from './contracts'
import { display, metricEvidence, numeric, reportLink, statement, unavailableFinding } from './evidence'
import { compareCreativeEvidenceInstants } from '../creative-assignment-contract'
import { outcomeWords } from '@/config/outcome-nouns'

// What this business calls its outcomes (NEXT_PUBLIC_OUTCOME_NOUN).
const OW = outcomeWords()

const KEYS = ['paid_touch_booking_lag_sample_bookings', 'median_paid_touch_to_booking_lag_days',
  'p90_paid_touch_to_booking_lag_days', 'longest_paid_touch_to_booking_lag_days'] as const

/** Observed completed-booking sample; never an inferred click-cohort maturity distribution. */
export function bookingLagFindings(data: ReportingData): ReviewFinding[] {
  const metrics = data.measurement?.data?.paidAssociation
  if (!metrics || !KEYS.some(key => metrics[key])) return []
  const refs = KEYS.map(key => metricEvidence(data, 'measurement', ['paidAssociation', key]))
  const linked = metrics.linked_value_bearing_bookings
  const valid = refs.every((ref, index) => {
    const claim = ref?.metric.current, value = numeric(ref?.metric)
    return claim && value !== null && value >= 0 && (index !== 0 || Number.isSafeInteger(value))
      && ref.metric.key === KEYS[index] && ref.metric.event === null
      && claim.metricKey === `first_party_attribution.${KEYS[index]}` && claim.unit === (index === 0 ? 'count' : 'days')
      && claim.source.system === 'first_party_attribution' && claim.source.role === 'association_truth'
      && claim.source.evidencePlane === 'paid_association' && claim.measurementKind === 'associated_noncausal'
      && claim.attributionScope === 'none' && claim.entity.level === 'business' && claim.entity.id === data.context.account.id
      && claim.window.basis === 'booking_created_date_et' && claim.window.timezone === data.context.timezone
      && claim.window.start === data.context.range.from && claim.window.end === data.context.range.to
      && claim.freshness.state !== 'stale' && claim.maturity.state !== 'partial'
      && compareCreativeEvidenceInstants(claim.asOf, data.context.asOf) <= 0
      && claim.asOf === refs[0]?.metric.current.asOf && claim.source.head === refs[0]?.metric.current.source.head
      && claim.coverage.numerator === numeric(refs[0]?.metric)
      && claim.coverage.denominator === refs[0]?.metric.current.coverage.denominator
  })
  const sample = numeric(refs[0]?.metric), median = numeric(refs[1]?.metric), p90 = numeric(refs[2]?.metric), longest = numeric(refs[3]?.metric)
  const denominator = refs[0]?.metric.current.coverage.denominator
  if (!valid || sample === null || sample <= 0 || median === null || p90 === null || longest === null
    || median > p90 || p90 > longest || typeof denominator !== 'number' || !Number.isSafeInteger(denominator) || sample > denominator
    || numeric(linked) !== denominator || linked.current.unit !== 'count' || linked.event !== null
    || linked.key !== 'linked_value_bearing_bookings' || linked.current.metricKey !== 'first_party_attribution.linked_value_bearing_bookings'
    || linked.current.source.system !== 'first_party_attribution' || linked.current.source.role !== 'association_truth'
    || linked.current.source.evidencePlane !== 'paid_association' || linked.current.measurementKind !== 'associated_noncausal'
    || linked.current.attributionScope !== 'meta_click_associated_noncausal'
    || linked.current.entity.level !== 'business' || linked.current.entity.id !== data.context.account.id
    || linked.current.window.start !== data.context.range.from || linked.current.window.end !== data.context.range.to
    || linked.current.window.basis !== 'booking_created_date_et' || linked.current.window.timezone !== data.context.timezone
    || linked.current.asOf !== refs[0]?.metric.current.asOf || linked.current.source.head !== refs[0]?.metric.current.source.head
    || linked.current.freshness.state === 'stale') {
    return [unavailableFinding(data, { id: 'journey.measurement.booking_lag', area: 'measurement',
      title: `Observed paid-touch ${OW.one} delay unavailable`, reason: `A consistent linked sample, timestamp cohort and observed lag distribution could not be established. Other valid ${OW.one} and delivery observations remain separate.`, href: '/reports' })]
  }
  const days = Math.round((Date.parse(`${data.context.range.to}T00:00:00Z`) - Date.parse(`${data.context.range.from}T00:00:00Z`)) / 86400000) + 1
  const extendsWindow = longest > days
  return [{ id: 'journey.measurement.booking_lag', area: 'measurement', title: `Observed paid-touch ${OW.one} delay`,
    status: 'observed', priority: extendsWindow ? 'investigate' : 'context',
    observation: statement(`${sample} sampled ${OW.many}: median ${display(refs[1]!.metric)}, empirical p90 ${display(refs[2]!.metric)}, longest observed ${display(refs[3]!.metric)} from retained paid touch to ${OW.one} creation. The sample covers ${sample} of ${denominator} linked eligible ${OW.many} created in the selected period.`, ...refs),
    materiality: { ...statement(extendsWindow
      ? `The observed tail extends beyond this ${days}-day reporting period. Some ${OW.many} created now followed touches from earlier periods; dividing these ${OW.many} by this period's ad activity does not measure that traffic cohort's conversion rate.`
      : `The sample describes ${OW.many} created in this ${days}-day period. Completed ${OW.one} timing alone cannot establish how all visitors from this period will convert.`, ...refs),
      priorityReason: 'Timing changes the interpretation of short-period results; it does not require suppressing valid business or platform measurements.' },
    explanations: [], counterEvidence: statement(`Only retained, linked ${OW.many} with valid timestamps enter this sample. Its empirical p90 can be dominated by a single ${OW.one} and is not a validated waiting period.`, ...refs),
    nextInspection: { question: `Inspect observed ${OW.one} delay and its sample coverage`, href: `${reportLink(data, '/reports', { report: 'website' })}#measurement-evidence`,
      outcomes: [{ result: 'A complete touch cohort with follow-up becomes available.', interpretation: 'Measure outcomes by that cohort and its age before assessing maturity.' },
        { result: `Only completed linked ${OW.many} are observed.`, interpretation: 'Use this timing description and retain separate business-date and platform-attribution results.' }] },
    limitations: [`The sample excludes unconverted visitors and may omit unlinked ${OW.many}; it cannot establish a complete conversion-delay distribution.`,
      `Observed paid touch is not proof of a native ad click. ${OW.One}-to-service lead time is a separate measure.`,
      'No fixed maturity threshold, incremental return, forecast or campaign edit follows from this sample.'],
    exposure: null, authority: { state: 'diagnostic', executable: false } }]
}
