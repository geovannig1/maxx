import { describe, expect, it, vi } from 'vitest'
import { validateReportingPacket } from '@/lib/reporting/validation'
import { buildMetaMetrics } from '@/lib/reporting/meta-metrics'
import { buildMetaBreakdowns, buildMetaSeries, previousContext } from '@/lib/reporting/meta-breakdowns'
import { buildBusinessReport } from '@/lib/reporting/business-metrics'
import { buildWebsiteReport } from '@/lib/reporting/website-metrics'
import { COMPLETE_FIELD_COVERAGE, makeReportMetric } from '@/lib/reporting/claims'
import type { ReportingContext, ReportingPacket } from '@/lib/reporting/contracts'
import { readMetaReport } from '@/lib/platforms/meta/reporting/meta-reader'

const api = vi.hoisted(() => ({ get: vi.fn() }))
vi.mock('@/lib/platforms/meta/client', () => ({ metaGet: api.get }))

const context: ReportingContext = {
  account: { id: 'account-db', metaAccountId: 'act_123', name: 'Studio' },
  range: { from: '2026-09-02', to: '2026-09-04' }, comparison: { from: '2026-08-30', to: '2026-09-01' },
  timezone: 'America/New_York', currency: 'USD', asOf: '2026-09-05T16:00:00Z',
}
const current = { spend: '10', impressions: '100', reach: '80', frequency: '1.25', clicks: '4',
  date_start: '2026-09-02', date_stop: '2026-09-02', publisher_platform: 'instagram', platform_position: 'reels' }
const prior = { ...current, spend: '8', date_start: '2026-08-30', date_stop: '2026-08-30' }
function metaPacket(): Extract<ReportingPacket, { section: 'meta' }> {
  const ad = { level: 'ad' as const, id: 'ad-1' }
  return structuredClone({ section: 'meta', context, notes: [], result: { state: 'available', asOf: context.asOf, notes: [], data: {
    metrics: buildMetaMetrics(context, current, prior),
    entities: [{ ...ad, name: 'Studio walkthrough', campaignId: 'c1', campaignName: 'Rental', adsetId: 's1', adsetName: 'Cold',
      status: 'PAUSED', configurationAsOf: context.asOf, audience: 'cold', audienceLabel: 'Cold audience', creative: null,
      metrics: buildMetaMetrics(context, current, prior, ad),
      series: buildMetaSeries(context, [current], [prior], ad),
      comparisonSeries: buildMetaSeries(previousContext(context), [prior], null, ad),
      breakdowns: buildMetaBreakdowns(context, 'placement', [current], [prior], ad),
    }],
    series: buildMetaSeries(context, [current], [prior]),
    comparisonSeries: buildMetaSeries(previousContext(context), [prior], null),
    breakdowns: buildMetaBreakdowns(context, 'placement', [current], [prior]),
    observations: [], attributionWindow: '7-day click / 1-day view', reportingTime: 'impression', sourceDescription: 'Meta',
  } } })
}
function businessPacket(): Extract<ReportingPacket, { section: 'business' }> {
  return structuredClone({ section: 'business', context, notes: [], result: { state: 'available', asOf: context.asOf, notes: [],
    data: buildBusinessReport(context, [{ id: 1, price: 100, amount_paid: 100, canceled: false, booking_date_et: context.range.from, appointment_type: 'Studio Rental' }], []) } })
}
function websitePacket(): Extract<ReportingPacket, { section: 'website' }> {
  const totals = { sessions: 10, engagedSessions: 4, engagementRate: 0.4, users: 8, pageViews: 16 }
  const { report } = buildWebsiteReport(context, { currentTotals: totals, previousTotals: totals,
    rows: [{ ...totals, landingPage: '/rentals', device: 'mobile', channel: 'Paid Social' }],
    events: [{ name: 'begin_checkout', device: 'mobile', channel: 'Paid Social', eventCount: 3 }],
    metadata: { timezone: context.timezone, currency: context.currency, subjectToThresholding: null, dataLossFromOtherRow: false, sampled: false, returnedRows: 2, totalRows: 2 } })
  return structuredClone({ section: 'website', context, notes: [], result: { state: 'available', asOf: context.asOf, notes: [], data: report } })
}

describe('report packet semantic validation', () => {
  it('keeps paid association and CAPI transport separate inside measurement evidence', () => {
    const paid = makeReportMetric({ context, source: 'first_party_attribution', key: 'linked_value_bearing_bookings',
      label: 'Observed linked bookings', definition: 'Observed linked active value-bearing bookings; lower bound.',
      current: 2, unit: 'count', entity: { level: 'business', id: context.account.id }, basis: 'booking_created_date_et',
      coverage: { state: 'partial', numerator: 2, denominator: 8 } })
    const capi = makeReportMetric({ context, source: 'capi', key: 'accepted_live_confirmations',
      label: 'Accepted live confirmations', definition: 'Confirmed delivery receipts for the selected confirmation cohort.',
      current: 4, unit: 'count', entity: { level: 'business', id: context.account.id }, basis: 'booking_created_date_et',
      coverage: COMPLETE_FIELD_COVERAGE })
    const packet = { section: 'measurement', context, notes: [], result: { state: 'partial', asOf: context.asOf,
      notes: [], data: { paidAssociation: { linked_value_bearing_bookings: paid }, capi: { accepted_live_confirmations: capi },
        paidAssociationNotes: ['Link completeness is unverified.'], capiNotes: [], sourceDescription: 'Booking linkage and transport.' } } }
    expect(validateReportingPacket(packet).section).toBe('measurement')
    const swapped = structuredClone(packet)
    swapped.result.data.paidAssociation.linked_value_bearing_bookings = { ...capi, key: paid.key }
    expect(() => validateReportingPacket(swapped)).toThrow(/source|identity/i)
    const wrongScope = structuredClone(packet)
    wrongScope.result.data.capi.accepted_live_confirmations.current.window.start = '2026-09-01'
    expect(() => validateReportingPacket(wrongScope)).toThrow(/window|period/i)
  })
  it.each([false, true])('validates the full Meta reader output, including canonical campaign lineage (one day: %s)', async oneDay => {
    api.get.mockImplementation((path: string, params: Record<string, string>) => {
      if (path === '/act_123') return { id: 'act_123', currency: 'USD', timezone_name: 'America/New_York' }
      if (path.endsWith('/campaigns')) return { data: [{ id: 'c1', name: 'Campaign', status: 'ACTIVE' }] }
      if (path.endsWith('/adsets')) return { data: [{ id: 's1', name: 'Ad set', campaign_id: 'c1', status: 'ACTIVE' }] }
      if (path.endsWith('/ads')) return { data: [{ id: 'ad-1', name: 'Ad', campaign_id: 'c1', adset_id: 's1', status: 'ACTIVE' }] }
      if (path.endsWith('/customaudiences')) return { data: [] }
      if (path.endsWith('/insights')) {
        const range = JSON.parse(params.time_range)
        return { data: [{ ...current, date_start: range.since, date_stop: params.time_increment === '1' ? range.since : range.until,
          campaign_id: 'c1', campaign_name: 'Campaign', adset_id: 's1', adset_name: 'Ad set', ad_id: 'ad-1', ad_name: 'Ad',
          results: [{ indicator: 'AppointmentConfirmed' }], age: '25-34', gender: 'female', region: 'Massachusetts' }] }
      }
      throw new Error('Unexpected fixture API path')
    })
    const requestContext = oneDay ? { ...context, range: { from: '2026-09-02', to: '2026-09-02' }, comparison: { from: '2026-09-01', to: '2026-09-01' } } : context
    const result = await readMetaReport(requestContext)
    expect(result.data).not.toBeNull()
    expect(validateReportingPacket({ section: 'meta', context: requestContext, notes: [], result }).result.data).not.toBeNull()
  })
  it('accepts production-shaped Meta aggregates, ad rows, placements and paired day comparisons', () => {
    const packet = metaPacket()
    const report = packet.result.data!
    expect(report.series[0].metrics.spend.previous?.claimId).toBe(report.comparisonSeries[0].metrics.spend.current.claimId)
    expect(report.series[0].metrics.spend.previous?.comparison.method).toBe('none')
    expect(report.comparisonSeries[0].metrics.spend.current.comparison.method).toBe('prior_equal_period')
    expect(validateReportingPacket(packet)).toEqual(packet)
  })
  it('accepts business daily/type identities and website journey/event identities from their adapters', () => {
    for (const packet of [businessPacket(), websitePacket()]) expect(validateReportingPacket(packet)).toEqual(packet)
  })
  it('keeps unavailable source packets valid without invented claims', () => {
    expect(validateReportingPacket({ section: 'meta', context, notes: [], result: { state: 'unavailable', data: null, asOf: null, notes: ['Read failed.'] } }).result.state).toBe('unavailable')
  })
  it('rejects current/prior swaps and aggregate claims covering only a subset of the selected range', () => {
    const swapped = metaPacket(), narrowed = metaPacket()
    const metric = swapped.result.data!.metrics.spend
    swapped.result.data!.metrics.spend = { ...metric, current: metric.previous!, previous: metric.current }
    narrowed.result.data!.metrics.spend.current.window.end = context.range.from
    expect(() => validateReportingPacket(swapped)).toThrow(/window|period/i)
    expect(() => validateReportingPacket(narrowed)).toThrow(/window|period/i)
  })
  it('rejects a series label outside its range and a daily value carrying an aggregate window', () => {
    const outside = metaPacket(), aggregate = metaPacket()
    outside.result.data!.series[0].date = '1999-01-01'
    aggregate.result.data!.series[0].metrics.spend = aggregate.result.data!.metrics.spend
    expect(() => validateReportingPacket(outside)).toThrow(/date|period/i)
    expect(() => validateReportingPacket(aggregate)).toThrow(/window|period/i)
  })
  it('checks daily prior alignment against the corresponding offset, not merely any day in the prior range', () => {
    const packet = metaPacket()
    packet.result.data!.series[0].metrics.spend.previous!.window = { ...packet.result.data!.series[0].metrics.spend.previous!.window, start: '2026-09-01', end: '2026-09-01' }
    expect(() => validateReportingPacket(packet)).toThrow(/window|period/i)
  })
  it('rejects ad/account identity leakage and dimension claims borrowed from their parent total', () => {
    const wrongAd = metaPacket(), wrongAccount = metaPacket(), placement = metaPacket()
    wrongAd.result.data!.entities[0].metrics.spend.current.entity.id = 'another-ad'
    wrongAccount.result.data!.metrics.spend.current.entity.id = `${context.account.id}:another-population`
    placement.result.data!.entities[0].breakdowns![0].metrics.spend = placement.result.data!.entities[0].metrics.spend
    for (const packet of [wrongAd, wrongAccount, placement]) expect(() => validateReportingPacket(packet)).toThrow(/entity|population/i)
  })
  it('rejects misplaced business type and website row claims despite sharing an account prefix', () => {
    const business = businessPacket(), website = websitePacket()
    business.result.data!.types[0].metrics.paid_bookings = business.result.data!.metrics.paid_bookings
    website.result.data!.rows[0].metrics.sessions = website.result.data!.metrics.sessions
    expect(() => validateReportingPacket(business)).toThrow(/entity|population/i)
    expect(() => validateReportingPacket(website)).toThrow(/entity|population/i)
  })
  it('binds the source system, role and evidence plane as a unit', () => {
    const wrongRole = metaPacket(), wrongPlane = metaPacket()
    wrongRole.result.data!.metrics.spend.current.source.role = 'business_truth'
    wrongPlane.result.data!.metrics.spend.current.source.evidencePlane = 'outcome_business'
    for (const packet of [wrongRole, wrongPlane]) expect(() => validateReportingPacket(packet)).toThrow(/source/i)
  })
  it('rejects conflicting duplicate metadata even when number, key and unit are unchanged', () => {
    const packet = metaPacket()
    packet.result.data!.comparisonSeries[0].metrics.spend.current.freshness = { state: 'stale', observedAt: context.asOf, maxAgeHours: 1 }
    expect(() => validateReportingPacket(packet)).toThrow(/conflicting|identity/i)
  })
  it('rejects an incorrect comparison descriptor even though duplicate descriptors can differ by slot', () => {
    const packet = metaPacket()
    packet.result.data!.comparisonSeries[0].metrics.spend.current.comparison.window!.start = '2026-08-26'
    expect(() => validateReportingPacket(packet)).toThrow(/comparison|window/i)
  })
  it('rejects orphan lineage even for a measurement kind exempted by the cross-plane helper', () => {
    const packet = metaPacket()
    packet.result.data!.metrics.cpm.current.measurementKind = 'associated_noncausal'
    packet.result.data!.metrics.cpm.current.inputClaimIds = ['not-in-this-packet']
    expect(() => validateReportingPacket(packet)).toThrow(/lineage|input/i)
  })
  it('rejects duplicate entities and daily dates instead of silently deduplicating visible rows', () => {
    const entities = metaPacket(), dates = metaPacket()
    entities.result.data!.entities.push(entities.result.data!.entities[0])
    dates.result.data!.series.push(dates.result.data!.series[0])
    expect(() => validateReportingPacket(entities)).toThrow(/duplicate/i)
    expect(() => validateReportingPacket(dates)).toThrow(/duplicate/i)
  })
  it('retains strict allowlisting and rejects a mismatched map or claim metric identity', () => {
    const key = metaPacket(), claim = metaPacket(), definition = metaPacket(), extra = metaPacket()
    key.result.data!.metrics.spend.key = 'bookings'
    claim.result.data!.metrics.spend.current.metricKey = 'meta.bookings'
    definition.result.data!.metrics.spend.definition = 'A different measurement presented beside the same claim.'
    expect(() => validateReportingPacket(key)).toThrow()
    expect(() => validateReportingPacket(claim)).toThrow(/metric|identity/i)
    expect(() => validateReportingPacket(definition)).toThrow(/definition|identity/i)
    expect(() => validateReportingPacket({ ...extra, private_payload: 'not allowed' })).toThrow()
  })
  it('allows canonical same-metric campaign inputs for account outcomes, but no unrelated population', () => {
    const packet = metaPacket()
    const campaignMetrics = buildMetaMetrics(context, { ...current, results: [{ indicator: 'AppointmentConfirmed' }] }, null, { level: 'campaign', id: 'c1' })
    packet.result.data!.entities.push({ id: 'c1', level: 'campaign', name: 'Campaign', campaignId: 'c1', campaignName: 'Campaign',
      adsetId: null, adsetName: null, status: 'ACTIVE', configurationAsOf: context.asOf, audience: 'unknown', audienceLabel: 'Unknown', creative: null, metrics: campaignMetrics })
    const canonical = makeReportMetric({ context, source: 'meta', key: 'bookings', label: 'Reported bookings',
      definition: 'SUM of canonical campaign reported bookings.', unit: 'count', current: 0,
      coverage: COMPLETE_FIELD_COVERAGE, measurementKind: 'derived', inputMetrics: [campaignMetrics.bookings],
      entity: { level: 'account', id: context.account.id }, basis: 'impression_date_et', event: 'AppointmentConfirmed' })
    packet.result.data!.metrics.bookings = { ...canonical, current: { ...canonical.current, claimId: `${canonical.current.claimId}:campaign-canonical` } }
    // This focused account fixture contains no account efficiency claims dependent on the replaced ID.
    packet.result.data!.metrics = { bookings: packet.result.data!.metrics.bookings }
    expect(validateReportingPacket(packet)).toEqual(packet)
    const invalid = structuredClone(packet)
    invalid.result.data!.metrics.bookings.current.inputClaimIds = [campaignMetrics.impressions.current.claimId]
    expect(() => validateReportingPacket(invalid)).toThrow(/lineage|population/i)
  })
  it('rejects input cycles and source strings masquerading as numeric money', () => {
    const cycle = metaPacket(), text = metaPacket()
    cycle.result.data!.metrics.spend.current.inputClaimIds = [cycle.result.data!.metrics.spend.current.claimId]
    text.result.data!.metrics.spend.current.value = 'NaN'
    expect(() => validateReportingPacket(cycle)).toThrow(/cyclic/i)
    expect(() => validateReportingPacket(text)).toThrow(/numeric/i)
  })
})
