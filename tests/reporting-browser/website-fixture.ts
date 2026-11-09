import { makeReportMetric } from '../../src/lib/reporting/claims'
import { buildWebsiteReport, type WebsiteJourneyValue } from '../../src/lib/reporting/website-metrics'
import { summarizePaidTouchBookingLag } from '../../src/lib/reporting/measurement-lag'
import { executiveFixture } from './executive-fixture'

/** Outcome uuid fixture for a numeric case id (economics identity is the outcome uuid). */
const oid = (n: number): string => `00000000-0000-4000-a000-${String(n).padStart(12, '0')}`

// Fictional native-shaped cohorts. A smaller page deteriorates; device mix reverses another page's aggregate.
export function websiteReportingFixture(from = '2026-09-02', to = '2026-09-04') {
  const data = executiveFixture(from, to, true), context = data.context
  const traffic = (landingPage: string, device: string, sessions: number, engaged: number): WebsiteJourneyValue => ({
    landingPage, device, channel: 'Paid Social', sessions, engagedSessions: engaged,
    engagementRate: engaged / sessions, users: Math.floor(sessions * .8), pageViews: sessions * 2,
  })
  const stable = Array.from({ length: 8 }, (_, i) => traffic(`/gallery-${i + 1}`, 'mobile', 1000, 500))
  const rows = [...stable, traffic('/book', 'mobile', 100, 20), traffic('/book', 'desktop', 100, 60),
    traffic('/mix', 'mobile', 900, 270), traffic('/mix', 'desktop', 100, 90)]
  const previousRows = [...stable, traffic('/book', 'mobile', 100, 70), traffic('/book', 'desktop', 100, 60),
    traffic('/mix', 'mobile', 100, 20), traffic('/mix', 'desktop', 900, 720), traffic('/previous-only', 'tablet', 25, 10)]
  const event = (name: string, eventCount: number) => ({ name, device: 'mobile', channel: 'Paid Social', eventCount })
  const events = [event('form_start', 500), event('appointment_confirmed', 3)]
  const previousEvents = [event('form_start', 500), event('appointment_confirmed', 9), event('generate_lead', 2)]
  const coverage = (n: number) => ({ state: 'complete' as const, numerator: n, denominator: n })
  // Native account totals are supplied independently; users are never reconstructed from row sums.
  const website = buildWebsiteReport(context, {
    currentTotals: { sessions: 9200, engagedSessions: 4440, engagementRate: 4440 / 9200, users: 6900, pageViews: 18400 },
    previousTotals: { sessions: 9225, engagedSessions: 4880, engagementRate: 4880 / 9225, users: 6800, pageViews: 18450 },
    rows, previousRows, events, previousEvents, currentTotalsCoverage: coverage(1), previousTotalsCoverage: coverage(1),
    journeyCoverage: coverage(rows.length), previousJourneyCoverage: coverage(previousRows.length),
    eventCoverage: coverage(events.length), previousEventCoverage: coverage(previousEvents.length),
    metadata: { timezone: context.timezone, currency: context.currency, sampled: false, subjectToThresholding: false,
      dataLossFromOtherRow: false, returnedRows: rows.length + events.length, totalRows: rows.length + events.length },
  })
  const created = `${to}T15:00:00Z`
  const lag = summarizePaidTouchBookingLag({ linkedCount: 3, asOf: context.asOf,
    assignments: [1, 6, 39].map((days, i) => ({ outcomeId: oid(i + 1), linkId: `link-${i}`, touchId: `touch-${i}`,
      metaCampaignId: 'campaign-1', metaAdsetId: 'set-1', metaAdId: `ad-${i + 1}`, policyVersion: 1,
      observedAt: new Date(Date.parse(created) - days * 86400000).toISOString(), outcomeCreatedAt: created, linkedAt: created })),
  })
  const specs = [
    ['linked_value_bearing_bookings', 'Paid-linked value-bearing bookings', 3, 'count'],
    ['paid_touch_booking_lag_sample_bookings', 'Paid-touch booking-lag sample bookings', lag.sampleCount, 'count'],
    ['median_paid_touch_to_booking_lag_days', 'Median paid-touch to booking lag', lag.medianDays, 'days'],
    ['p90_paid_touch_to_booking_lag_days', 'P90 paid-touch to booking lag', lag.p90Days, 'days'],
    ['longest_paid_touch_to_booking_lag_days', 'Longest observed paid-touch to booking lag', lag.longestDays, 'days'],
  ] as const
  const paidAssociation = Object.fromEntries(specs.map(([key, label, current, unit]) => [key, makeReportMetric({
    context, key, label, unit, current, previous: null, source: 'first_party_attribution',
    definition: `Fictional observed linked booking sample. ${label}; not connected account results.`,
    entity: { level: 'business', id: context.account.id }, measurementKind: 'associated_noncausal',
    attributionScope: key === 'linked_value_bearing_bookings' ? 'meta_click_associated_noncausal' : 'none',
    basis: 'booking_created_date_et', sourceHead: context.asOf,
    coverage: { state: 'partial', numerator: 3, denominator: key === 'linked_value_bearing_bookings' ? 5 : 3 }, previousCoverage: { state: 'unknown', numerator: null, denominator: null },
  })]))
  return { ...data, website: { state: 'available' as const, asOf: context.asOf, data: website.report, notes: ['Fictional website comparison scenario.'] },
    measurement: { ...data.measurement!, data: { ...data.measurement!.data!, paidAssociation,
      paidAssociationNotes: ['Fictional linked sample: 3 of 5 eligible bookings. Unconverted visitors are not observed.'] } } }
}
