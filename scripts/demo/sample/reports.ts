// Sample reporting data shared by `npm run demo` (scripts/demo/gateway.ts) and the reporting tests and
// browser preview under tests/. Lives with the demo so the demo never imports the test tree.
import { makeReportMetric } from '../../../src/lib/reporting/claims'
import { buildBusinessReport, type BusinessLedgerRow } from '../../../src/lib/reporting/business-metrics'
import { buildMetaMetrics, type MetaRow } from '../../../src/lib/reporting/meta-metrics'
import { buildWebsiteReport } from '../../../src/lib/reporting/website-metrics'
import { aggregateConfirmationFacts } from '../../../src/lib/outcomes/confirmation-facts'
import { previousReportingRange } from '../../../src/lib/reporting/range'
import type { ReportingContext, ReportingData, ReportingPacket } from '../../../src/lib/reporting/contracts'

// All rows below are fictional native-shaped inputs, never a connected account retrieval.
function nativeMetaRow(spend: number, prior = false, adId?: string): MetaRow {
  const count = (value: number) => prior ? Math.floor(value / 2) : value
  const totals = {
    spend: count(spend), impressions: count(10000), reach: count(8000), clicks: count(150), link_clicks: count(100),
    outbound_clicks: count(90), landing_page_views: count(80), engagements: count(120), reactions: count(20),
    comments: count(3), shares: count(2), saves: count(1), purchase_count: count(2), purchase_value: count(200),
    appointment_value: count(300), bookings: count(3), bookings_click: count(2), bookings_view: count(1),
  }
  const image: typeof totals = {
    spend: count(spend / 3), impressions: count(4000), reach: count(3200), clicks: count(50), link_clicks: count(30),
    outbound_clicks: count(30), landing_page_views: count(25), engagements: count(40), reactions: count(5),
    comments: count(1), shares: count(1), saves: 0, purchase_count: prior ? 0 : 1, purchase_value: prior ? 0 : 100,
    appointment_value: prior ? 0 : 100, bookings: prior ? 0 : 1, bookings_click: 0, bookings_view: prior ? 0 : 1,
  }
  const value = (key: keyof typeof totals) => String(adId === 'ad-2' ? image[key] : adId === 'ad-1' ? totals[key] - image[key] : totals[key])
  const videoAction = (amount: number) => [{ action_type: 'video_view', value: String(count(amount)) }]
  return {
    // Native reach and frequency are supplied for each fictional population, never summed by the adapter.
    spend: value('spend'), impressions: value('impressions'), reach: value('reach'), frequency: '1.25',
    clicks: value('clicks'), inline_link_clicks: value('link_clicks'),
    outbound_clicks: [{ action_type: 'outbound_click', value: value('outbound_clicks') }],
    ...(adId === 'ad-2' ? {} : {
      video_play_actions: videoAction(1000), video_continuous_2_sec_watched_actions: videoAction(500),
      video_thruplay_watched_actions: videoAction(200), video_p25_watched_actions: videoAction(300),
      video_p50_watched_actions: videoAction(200), video_p75_watched_actions: videoAction(100), video_p100_watched_actions: videoAction(50),
      video_avg_time_watched_actions: videoAction(4),
    }),
    actions: (Object.entries({ landing_page_view: 'landing_page_views', post_engagement: 'engagements', post_reaction: 'reactions',
      comment: 'comments', post: 'shares', 'onsite_conversion.post_save': 'saves', purchase: 'purchase_count' }) as Array<[string, keyof typeof totals]>)
      .map(([action_type, key]) => ({ action_type, value: value(key) })),
    action_values: [{ action_type: 'purchase', value: value('purchase_value') }],
    conversion_values: [{ action_type: 'offsite_conversion.fb_pixel_custom.AppointmentConfirmed', value: value('appointment_value') }],
    results: [{ indicator: 'conversions:offsite_conversion.fb_pixel_custom.AppointmentConfirmed', values: [
      { value: value('bookings'), attribution_windows: ['default'] },
      { value: value('bookings_click'), attribution_windows: ['7d_click'] },
      { value: value('bookings_view'), attribution_windows: ['1d_view'] },
    ] }],
  }
}

function nativeBusinessRows(context: ReportingContext, prior = false): BusinessLedgerRow[] {
  return Array.from({ length: prior ? 4 : 8 }, (_, index) => ({
    id: (prior ? 100 : 0) + index + 1, price: index < (prior ? 2 : 5) ? (prior ? 125 : 100) : 0,
    amount_paid: index < (prior ? 2 : 5) ? (prior ? 125 : 100) : 0, canceled: index === (prior ? 3 : 7),
    booking_date_et: (prior ? context.comparison : context.range).from, appointment_type: 'Synthetic studio rental',
  }))
}

/** Fictional GA4 evidence; `scale` multiplies every count (1 is the fixture the tests pin). */
export function nativeWebsite(context: ReportingContext, scale = 1) {
  const n = (value: number) => Math.round(value * scale)
  const rows = [
    { landingPage: '/studio-rentals', device: 'mobile', channel: 'Paid Social', sessions: n(120),
      engagedSessions: n(36), engagementRate: .3, users: n(90), pageViews: n(160) },
    { landingPage: '/studio-rentals', device: 'desktop', channel: 'Paid Social', sessions: n(80),
      engagedSessions: n(64), engagementRate: .8, users: n(60), pageViews: n(140) },
  ]
  const events = ([['begin_checkout', 'mobile', 14], ['begin_checkout', 'desktop', 6],
    ['appointment_confirmed', 'mobile', 2], ['appointment_confirmed', 'desktop', 4],
    ['generate_lead', 'mobile', 3], ['generate_lead', 'desktop', 1]] as const)
    .map(([name, device, eventCount]) => ({ name, device, channel: 'Paid Social', eventCount: n(eventCount) }))
  // Fictional prior events use the same native event/device/channel query as the current inventory.
  // Prior page rows and the other two prior event tuples remain unobserved in this base fixture.
  const previousEvents = ([['begin_checkout', 'mobile', 10], ['appointment_confirmed', 'desktop', 3],
    ['generate_lead', 'mobile', 1], ['generate_lead', 'desktop', 1]] as const)
    .map(([name, device, eventCount]) => ({ name, device, channel: 'Paid Social', eventCount: n(eventCount) }))
  const coverage = (size: number) => ({ state: 'complete' as const, numerator: size, denominator: size })
  const native = buildWebsiteReport(context, {
    currentTotals: { sessions: n(200), engagedSessions: n(100), engagementRate: .5, users: n(150), pageViews: n(300) },
    previousTotals: { sessions: n(100), engagedSessions: n(50), engagementRate: .5, users: n(75), pageViews: n(150) },
    currentTotalsCoverage: coverage(1), previousTotalsCoverage: coverage(1),
    rows, events, previousEvents, journeyCoverage: coverage(rows.length), eventCoverage: coverage(events.length),
    previousEventCoverage: coverage(previousEvents.length), eventAbsenceProven: false, previousEventAbsenceProven: false,
    metadata: { timezone: context.timezone, currency: context.currency, subjectToThresholding: false,
      dataLossFromOtherRow: false, sampled: false, returnedRows: rows.length + events.length, totalRows: rows.length + events.length },
  }).report
  return { ...native, sourceDescription: `Synthetic GA4 test evidence. ${native.sourceDescription}` }
}

function nativeConfirmationFacts(context: ReportingContext, prior: boolean) {
  const rows = nativeBusinessRows(context, prior)
  return aggregateConfirmationFacts(rows.map((row, index) => ({ id: row.id, canceled: row.canceled,
    web_origin_state: prior ? index === 2 ? 'staff_or_manual' : 'website'
      : index === 5 ? 'staff_or_manual' : index === 6 ? 'origin_unknown' : 'website',
    capi_sent_at: !prior && index === 4 ? context.asOf : null,
  })), new Set(rows.slice(0, prior ? 2 : 4).map(row => String(row.id))))
}

function nativeMeasurement(context: ReportingContext, business: ReturnType<typeof buildBusinessReport>) {
  return sampleMeasurement(context, business, { current: nativeConfirmationFacts(context, false), previous: nativeConfirmationFacts(context, true) },
    { current: 2, previous: 1 })
}

type Facts = ReturnType<typeof aggregateConfirmationFacts>
/** Fictional CAPI delivery and paid-link evidence over the given confirmation facts and linked counts. */
export function sampleMeasurement(context: ReportingContext, business: ReturnType<typeof buildBusinessReport>,
  facts: { current: Facts; previous: Facts }, linked: { current: number; previous: number }) {
  const { current, previous } = facts
  const capiDefinitions = [
    ['eligible_website_confirmations', 'CAPI-eligible website confirmations', 'websiteConfirmations', 'totalConfirmations',
      'Website-origin confirmations created in the selected America/New_York dates. Delivery counts the confirmation event when it occurred; it does not establish current appointment status.'],
    ['accepted_live_confirmations', 'Live-accepted CAPI confirmations', 'websiteWithAcceptedCapi', 'websiteConfirmations',
      'Website-origin confirmations in the selected creation-date cohort with an outcome_capi_deliveries live_accepted_at lineage marker. Test sends and legacy parent timestamps do not count as accepted.'],
    ['origin_unknown_confirmations', 'Confirmations with unknown origin', 'originUnknownConfirmations', 'totalConfirmations',
      'Confirmations created in the selected dates whose website versus staff/manual origin was not established. They are excluded from CAPI eligibility rather than assumed either way.'],
    ['legacy_stamp_unverified', 'Unverified legacy CAPI stamps', 'websiteLegacyStampUnverified', 'websiteConfirmations',
      'Website confirmations carrying a legacy capi_sent_at timestamp without live-accepted delivery lineage. These timestamps are visible but never treated as Meta acceptance.'],
  ] as const
  const capi = Object.fromEntries(capiDefinitions.map(([key, label, value, population, definition]) => [key, makeReportMetric({
    context, key, label, definition, source: 'capi', unit: 'count', current: current[value], previous: previous[value],
    entity: { level: 'business', id: context.account.id }, measurementKind: 'measured', attributionScope: 'capi_event_delivery',
    coverage: { state: 'complete', numerator: current[population], denominator: current[population] },
    previousCoverage: { state: 'complete', numerator: previous[population], denominator: previous[population] },
    basis: 'booking_created_date_et', sourceHead: context.asOf,
  })]))
  const paid = makeReportMetric({ context, key: 'linked_value_bearing_bookings', label: 'Paid-linked value-bearing bookings',
    definition: 'Observed lower bound of unique active value-bearing bookings created in the selected America/New_York dates with an immutable first-party paid-touch link. Incomplete Meta ad identity remains an account-level paid link; a missing link does not prove an organic booking because exact-window capture and linker completeness are unproven.',
    source: 'first_party_attribution', unit: 'count', current: linked.current, previous: linked.previous,
    entity: { level: 'business', id: context.account.id }, measurementKind: 'associated_noncausal', attributionScope: 'meta_click_associated_noncausal',
    coverage: { state: 'partial', numerator: linked.current, denominator: Number(business.metrics.value_bearing_bookings.current.value) },
    previousCoverage: { state: 'partial', numerator: linked.previous, denominator: Number(business.metrics.value_bearing_bookings.previous!.value) },
    basis: 'booking_created_date_et', sourceHead: context.asOf,
  })
  return { paidAssociation: { linked_value_bearing_bookings: paid }, capi,
    paidAssociationNotes: ['Synthetic observed lower bound; exact-window capture and linker completeness are unverified.'],
    capiNotes: ['Synthetic website-origin confirmation cohort records the confirmation event, not current appointment status; unknown origins remain not evaluable.',
      `Synthetic eligibility and accepted-delivery lineage observations at ${context.asOf}.`],
    sourceDescription: 'Synthetic booking associations and confirmation receipts for the selected dates.' }
}

/** The browser fixtures' fictional illustration host (never resolves); the demo passes its own local image. */
export const FIXTURE_CREATIVE_IMAGE_URL = 'https://example.test/creative.jpg'

export function reportingFixture(from = '2026-09-02', to = '2026-09-04', account?: ReportingContext['account'], asOf = '2026-09-05T17:00:00Z',
  creativeImageUrl: string | null = FIXTURE_CREATIVE_IMAGE_URL): ReportingData {
  const context: ReportingContext = { account: account ?? { id: 'fixture-db', metaAccountId: 'act_123', name: 'Studio test account' },
    range: { from, to }, comparison: previousReportingRange({ from, to }), timezone: 'America/New_York', currency: 'USD', asOf }
  const spend = from === '2026-09-02' ? 120 : 240
  const metaMetrics = (entity: Parameters<typeof buildMetaMetrics>[3]) =>
    buildMetaMetrics(context, nativeMetaRow(spend, false, entity?.level === 'ad' ? entity.id : undefined),
      nativeMetaRow(spend, true, entity?.level === 'ad' ? entity.id : undefined), entity)
  const nativeBusiness = buildBusinessReport(context, nativeBusinessRows(context), nativeBusinessRows(context, true))
  const business = { ...nativeBusiness, sourceDescription: `Synthetic outcome test evidence. ${nativeBusiness.sourceDescription}` }
  const entity = (level: 'campaign' | 'adset' | 'ad', id: string, name: string) => ({ id, level, name,
    campaignId: 'campaign-1', campaignName: 'Studio rentals', adsetId: level === 'campaign' ? null : 'set-1', adsetName: 'Local creators',
    status: id === 'ad-2' ? 'PAUSED' : 'ACTIVE', configurationAsOf: context.asOf, audience: 'cold' as const, audienceLabel: 'Cold · broad targeting',
    creative: level === 'ad' ? { id: `creative-${id}`, name, format: id === 'ad-1' ? 'video' as const : 'image' as const,
      imageUrl: creativeImageUrl, thumbnailUrl: null, videoUrl: null, durationSeconds: id === 'ad-1' ? 20 : null,
      body: 'Make room for your next shoot.', headline: 'Book the studio', destination: 'https://example.test/studio' } : null,
    metrics: metaMetrics({ level, id }), series: [], comparisonSeries: [], breakdowns: [],
  })
  return { context, meta: { state: 'available', asOf: context.asOf, notes: [], data: {
    metrics: metaMetrics({ level: 'account', id: context.account.id }),
    entities: [entity('campaign', 'campaign-1', 'Studio rentals'), entity('adset', 'set-1', 'Local creators'), entity('ad', 'ad-1', 'Studio walkthrough'), entity('ad', 'ad-2', 'Portrait still')],
    series: [], comparisonSeries: [], breakdowns: [], observations: [], attributionWindow: '7-day click / 1-day view', reportingTime: 'Impression date', sourceDescription: 'Synthetic Meta test evidence',
  } }, business: { state: 'available', asOf: context.asOf, notes: [], data: business },
  website: { state: 'available', asOf: context.asOf, notes: [], data: nativeWebsite(context) },
  measurement: { state: 'partial', asOf: context.asOf, notes: [], data: nativeMeasurement(context, nativeBusiness) } }
}
export function fixturePacket(section: string, from: string, to: string, creativeImageUrl?: string | null): ReportingPacket {
  const data = reportingFixture(from, to, undefined, undefined, creativeImageUrl)
  const notes = ['Sample-data preview: fictional metrics, not Example Studio results.']
  if (section === 'meta') return { section, context: data.context, result: data.meta, notes }
  if (section === 'business') return { section, context: data.context, result: data.business, notes }
  if (section === 'measurement') return { section, context: data.context, result: data.measurement!, notes }
  return { section: 'website', context: data.context, result: data.website, notes }
}
