import type { ReportingData, WebsiteEventRow, WebsiteRow } from '../contracts'
import type { ReviewEvidence, ReviewFinding } from './contracts'
import { matchedWebsitePairs, websiteEventFindings, websitePopulationReview } from './website-population'
import { bookingLagFindings } from './booking-lag'
import {
  display,
  metricEvidence,
  numeric,
  reportLink,
  statement,
  unavailableFinding,
} from './evidence'
import { outcomeWords } from '@/config/outcome-nouns'

// What this business calls its outcomes (NEXT_PUBLIC_OUTCOME_NOUN).
const OW = outcomeWords()

type VaryingDimension = 'landingPage' | 'device' | 'channel'

interface RowPair {
  a: WebsiteRow
  b: WebsiteRow
  aIndex: number
  bIndex: number
  varying: VaryingDimension
  sessions: number
  aRate: number
  bRate: number
}

const DIAGNOSTIC_AUTHORITY = { state: 'diagnostic' as const, executable: false as const }

function rowPair(data: ReportingData): RowPair | null {
  return matchedWebsitePairs(data)[0] ?? null
}

function websiteBlocked(data: ReportingData): string | null {
  if (data.website.state === 'loading' || data.website.state === 'unavailable') {
    return `GA4 website evidence is ${data.website.state}.`
  }
  if (!data.website.data?.metadata) return 'GA4 website rows are unavailable.'
  return null
}

function commonPairLabel(pair: RowPair): string {
  const shared = [
    pair.varying !== 'landingPage' ? pair.a.landingPage : null,
    pair.varying !== 'device' ? pair.a.device : null,
    pair.varying !== 'channel' ? pair.a.channel : null,
  ].filter(Boolean)
  return shared.join(' / ')
}

function matchedPairFinding(data: ReportingData, selected?: RowPair): ReviewFinding {
  const blocked = websiteBlocked(data)
  if (blocked) {
    return {
      ...unavailableFinding(data, {
        id: 'journey.ga4.matched_pair',
        area: 'website',
        title: 'Matched GA4 journey comparison unavailable',
        reason: blocked,
        href: '/reports',
      }),
      limitations: [blocked, 'A definitive page/device/channel comparison is withheld until GA4 rows are complete.'],
    }
  }

  const pair = selected ?? rowPair(data)
  if (!pair) {
    return unavailableFinding(data, {
      id: 'journey.ga4.matched_pair',
      area: 'website',
      title: 'No matched GA4 page/device/channel pair',
      reason: 'No GA4 row pair varied exactly one of landing page, device or channel with comparable session and native engagement-rate claims.',
      href: '/reports',
    })
  }

  const refs = [
    metricEvidence(data, 'website', ['rows', pair.aIndex, 'metrics', 'sessions']),
    metricEvidence(data, 'website', ['rows', pair.bIndex, 'metrics', 'sessions']),
    metricEvidence(data, 'website', ['rows', pair.aIndex, 'metrics', 'engagement_rate']),
    metricEvidence(data, 'website', ['rows', pair.bIndex, 'metrics', 'engagement_rate']),
  ]
  const sessionRefs = refs.slice(0, 2).filter((ref): ref is ReviewEvidence => Boolean(ref))
  const dimensionLabel = pair.varying === 'landingPage' ? 'landing page' : pair.varying
  const equalRate = pair.aRate === pair.bRate
  return {
    id: 'journey.ga4.matched_pair',
    area: 'website',
    title: `Matched GA4 ${dimensionLabel} comparison`,
    status: equalRate ? 'unchanged' : 'mixed',
    priority: equalRate ? 'context' : 'investigate',
    observation: statement(
      equalRate
        ? `${commonPairLabel(pair)} held constant while ${dimensionLabel} varied: ${pair.a[pair.varying]} had ${display(pair.a.metrics.sessions)} sessions and ${pair.b[pair.varying]} had ${display(pair.b.metrics.sessions)} sessions; both measured ${display(pair.a.metrics.engagement_rate)} engagement rate.`
        : `${commonPairLabel(pair)} held constant while ${dimensionLabel} varied: ${pair.a[pair.varying]} had ${display(pair.a.metrics.sessions)} sessions and ${display(pair.a.metrics.engagement_rate)} engagement rate; ${pair.b[pair.varying]} had ${display(pair.b.metrics.sessions)} sessions and ${display(pair.b.metrics.engagement_rate)} engagement rate.`,
      ...refs,
    ),
    materiality: {
      ...statement(`The two displayed rows cover ${pair.sessions} GA4 sessions. Every eligible held-dimension group is assessed; this pair shows its widest observed engagement-rate contrast. Other members remain in the matching detail table.`, refs[0], refs[1], refs[2], refs[3]),
      priorityReason: 'A current-period contrast is descriptive; compatible prior changes and traffic-mix reversals receive their own assessments.',
    },
    explanations: [{
      hypothesis: equalRate
        ? `The ${dimensionLabel} split did not change the native engagement rate in this matched pair.`
        : `The observed engagement-rate contrast may follow the ${dimensionLabel} split while page, device or channel stayed fixed.`,
      evidence: refs.filter((ref): ref is ReviewEvidence => Boolean(ref)),
      missing: ['ordered user journeys', `business ${OW.one} identity`],
    }],
    counterEvidence: statement(`GA4 engagement-rate telemetry does not establish booked ${OW.many}, paid efficiency or ordered user journeys.`, refs[2], refs[3]),
    nextInspection: {
      question: `Open the website pages table and inspect the named rows; add page-scoped event evidence before judging this ${dimensionLabel} cohort downstream.`,
      href: `${reportLink(data, '/reports', { report: 'website', ...Object.fromEntries(
        (['landingPage', 'device', 'channel'] as const).filter(key => key !== pair.varying)
          .map(key => [key === 'landingPage' ? 'website_page' : `website_${key}`, pair.a[key]]),
      ) })}#website-pages`,
      outcomes: [
        { result: 'Manual page inspection finds a device- or page-specific obstacle.', interpretation: 'Treat the matched GA4 contrast as a journey-quality hypothesis for review.' },
        { result: 'Future page-scoped event evidence becomes available.', interpretation: 'Reassess with event evidence that actually carries page identity.' },
      ],
    },
    limitations: [`GA4 page rows contain traffic metrics, not ordered people or business ${OW.many}.`],
    exposure: { value: pair.sessions, unit: 'sessions', evidence: sessionRefs },
    authority: DIAGNOSTIC_AUTHORITY,
  }
}

function eventFinding(data: ReportingData): ReviewFinding {
  const events = data.website.data?.events ?? []
  let best: { event: WebsiteEventRow; index: number; value: number } | null = null
  for (const [index, event] of events.entries()) {
    const value = numeric(event.metrics.event_count)
    if (value === null) continue
    if (!best || value > best.value) best = { event, index, value }
  }
  if (!best) {
    return unavailableFinding(data, {
      id: 'journey.ga4.event_telemetry',
      area: 'measurement',
      title: 'GA4 named event telemetry unavailable',
      reason: 'No named GA4 event row had an available event_count metric.',
      href: '/reports',
    })
  }
  const ref = metricEvidence(data, 'website', ['events', best.index, 'metrics', 'event_count'])
  return {
    id: 'journey.ga4.event_telemetry',
    area: 'measurement',
    title: 'GA4 named event telemetry',
    status: 'observed',
    observation: statement(
      `GA4 recorded ${display(best.event.metrics.event_count)} ${best.event.name} events for ${best.event.device} / ${best.event.channel}.`,
      ref,
    ),
    materiality: {
      ...statement('The event count is browser telemetry for a named event, device and channel.', ref),
      priorityReason: 'count',
    },
    explanations: [{
      hypothesis: 'The event row can help inspect measurement instrumentation for that device/channel cohort.',
      evidence: ref ? [ref] : [],
      missing: ['landing page identity', 'deduplicated people', 'ordered journey sequence'],
    }],
    counterEvidence: statement(`This event telemetry is not a people count, ${OW.one} conversion, funnel order or page-level result.`, ref),
    nextInspection: {
      question: 'Open the website events table and inspect the named event row without joining identities the report does not carry.',
      href: `${reportLink(data, '/reports', { report: 'website' })}#website-events`,
      outcomes: [
        { result: 'The same device/channel has enough sessions but few named events.', interpretation: 'Inspect event instrumentation and page intent.' },
        { result: 'Named events move with traffic volume.', interpretation: 'Treat the row as telemetry volume unless identity evidence is added.' },
      ],
    },
    limitations: ['GA4 event rows have event, device and channel only in this report.'],
    exposure: { value: best.value, unit: 'count', evidence: ref ? [ref] : [] },
    authority: DIAGNOSTIC_AUTHORITY,
  }
}

function measurementFinding(data: ReportingData): ReviewFinding {
  const measurement = data.measurement?.data
  if (!measurement) {
    return unavailableFinding(data, {
      id: 'journey.measurement.association_transport',
      area: 'measurement',
      title: 'Paid association and CAPI unavailable',
      reason: data.measurement ? `Measurement evidence is ${data.measurement.state}.` : 'Measurement evidence was not included.',
      href: '/reports',
    })
  }
  const refs = [
    metricEvidence(data, 'measurement', ['paidAssociation', 'linked_value_bearing_bookings']),
    metricEvidence(data, 'measurement', ['capi', 'eligible_website_confirmations']),
    metricEvidence(data, 'measurement', ['capi', 'accepted_live_confirmations']),
  ]
  const paid = measurement.paidAssociation.linked_value_bearing_bookings
  const eligible = measurement.capi.eligible_website_confirmations
  const accepted = measurement.capi.accepted_live_confirmations
  const presentRefs = refs.filter((ref): ref is ReviewEvidence => ref !== null && numeric(ref.metric) !== null)
  if (presentRefs.length === 0) {
    return unavailableFinding(data, {
      id: 'journey.measurement.association_transport',
      area: 'measurement',
      title: 'Paid association and CAPI unavailable',
      reason: 'Paid association and CAPI metrics were included but none had an available measured value.',
      href: '/reports',
    })
  }
  const eligibleRef = refs[1] ?? null
  const eligibleValue = numeric(eligible)
  return {
    id: 'journey.measurement.association_transport',
    area: 'measurement',
    title: 'Paid association and CAPI transport',
    status: 'mixed',
    observation: statement(
      `First-party paid association observed ${display(paid)} linked value bearing ${OW.many} as a lower bound. CAPI transport observed ${display(eligible)} eligible website confirmations and ${display(accepted)} accepted live confirmations in separate cohorts. Delivery counts the confirmation event when it occurred; it does not establish current ${OW.one} status.`,
      ...refs,
    ),
    materiality: {
      ...statement('Association and delivery receipts are retained as lower-bound measurement evidence with separate source planes.', ...refs),
      priorityReason: 'count',
    },
    explanations: [{
      hypothesis: 'First-party association can support paid-linkage inspection while CAPI receipts support transport-health inspection.',
      evidence: refs.filter((ref): ref is ReviewEvidence => Boolean(ref)),
      missing: ['complete linker manifest', 'incremental lift', 'ad-level performance proof'],
    }],
    counterEvidence: statement(`Accepted CAPI delivery is a transport receipt; it does not establish ad attribution, paid efficiency or ${OW.one} performance.`, refs[2]),
    nextInspection: {
      question: 'Open the measurement evidence section and inspect association completeness and CAPI transport as separate cohorts.',
      href: `${reportLink(data, '/reports', { report: 'website' })}#measurement-evidence`,
      outcomes: [
        { result: 'Association completeness improves while CAPI acceptance stays stable.', interpretation: 'Paid-link lower bounds become more inspectable without changing transport health.' },
        { result: 'CAPI acceptance changes while association is flat.', interpretation: 'Treat it as delivery/instrumentation movement, not ad performance.' },
      ],
    },
    limitations: [
      ...(measurement.paidAssociationNotes ?? []),
      ...(measurement.capiNotes ?? []),
      `CAPI accepted delivery and paid ${OW.one} association use different cohorts.`,
    ],
    exposure: eligibleValue === null || !eligibleRef ? null : { value: eligibleValue, unit: 'count', evidence: [eligibleRef] },
    authority: DIAGNOSTIC_AUTHORITY,
  }
}

export function deriveJourneyReview(data: ReportingData): ReviewFinding[] {
  const pairs = matchedWebsitePairs(data), events = websiteEventFindings(data)
  return [
    ...websitePopulationReview(data).findings,
    ...(pairs.length ? pairs.map((pair, index) => ({ ...matchedPairFinding(data, pair),
      id: index === 0 ? 'journey.ga4.matched_pair' : `journey.group:${pair.key}` })) : [matchedPairFinding(data)]),
    ...(events.length ? events : [eventFinding(data)]),
    measurementFinding(data),
    ...bookingLagFindings(data),
  ]
}
