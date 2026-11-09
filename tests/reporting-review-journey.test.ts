import './_support/outcome-noun-booking'
import { describe, expect, it } from 'vitest'
import type { MetricClaim } from '@/lib/cockpit/contracts'
import { makeReportMetric, COMPLETE_FIELD_COVERAGE } from '@/lib/reporting/claims'
import type { ReportMetric, ReportingData, ReportingSectionName } from '@/lib/reporting/contracts'
import { validateReportingPacket } from '@/lib/reporting/validation'
import { verifyFindingReferences } from '@/lib/reporting/review/evidence'
import { deriveJourneyReview } from '@/lib/reporting/review/journey'
import { websiteEventAnchor } from '@/lib/reporting/website-identity'

const context = {
  account: { id: 'account-db', metaAccountId: 'act_123', name: 'Studio' },
  range: { from: '2026-09-02', to: '2026-09-04' },
  comparison: { from: '2026-08-30', to: '2026-09-01' },
  timezone: 'America/New_York' as const,
  currency: 'USD' as const,
  asOf: '2026-09-05T16:00:00Z',
}

function metric(
  source: ReportingSectionName | 'ga4' | 'first_party_attribution' | 'capi',
  key: string,
  current: number | null,
  previous?: number | null,
  coverage = COMPLETE_FIELD_COVERAGE,
  entity?: MetricClaim['entity'],
  basis?: MetricClaim['window']['basis'],
  unit: MetricClaim['unit'] = key.includes('rate') ? 'percent' : 'count',
): ReportMetric {
  const system = source === 'website' ? 'ga4' : source
  return makeReportMetric({
    context,
    source: system as 'ga4' | 'first_party_attribution' | 'capi' | 'meta' | 'outcomes' | 'maxx',
    key,
    label: key.replace(/_/g, ' '),
    definition: `${key} fixture claim.`,
    unit,
    current,
    previous,
    coverage,
    previousCoverage: COMPLETE_FIELD_COVERAGE,
    event: key === 'event_count' ? 'generate_lead' : null,
    entity,
    basis,
  })
}

function rowMetric(index: number, key: string, current: number | null, coverage = COMPLETE_FIELD_COVERAGE, unit?: MetricClaim['unit']) {
  return metric('website', key, current, undefined, coverage, { level: 'account', id: `account-db:journey:${index}` }, undefined, unit)
}

function eventMetric(index: number, key: string, current: number | null) {
  return metric('website', key, current, undefined, COMPLETE_FIELD_COVERAGE, { level: 'account', id: `account-db:event:${index}` })
}

function measurementMetric(source: 'first_party_attribution' | 'capi', key: string, current: number | null) {
  return metric(source, key, current, undefined, COMPLETE_FIELD_COVERAGE, { level: 'business', id: 'account-db' }, 'booking_created_date_et')
}

function data(): ReportingData {
  return {
    context,
    business: { state: 'unavailable', data: null, asOf: null, notes: [] },
    meta: { state: 'unavailable', data: null, asOf: null, notes: [] },
    website: {
      state: 'available',
      asOf: context.asOf,
      notes: [],
      data: {
        metrics: {},
        sourceDescription: 'GA4 landing-page, device and channel rows.',
        metadata: {
          timezone: 'America/New_York',
          currency: 'USD',
          subjectToThresholding: false,
          dataLossFromOtherRow: false,
          sampled: false,
          returnedRows: 4,
          totalRows: 4,
        },
        rows: [
          {
            id: 'studio-mobile-paid',
            landingPage: '/studio',
            device: 'mobile',
            channel: 'Paid Social',
            metrics: {
              sessions: rowMetric(0, 'sessions', 120),
              engaged_sessions: rowMetric(0, 'engaged_sessions', 36),
              engagement_rate: rowMetric(0, 'engagement_rate', 30),
            },
          },
          {
            id: 'studio-desktop-paid',
            landingPage: '/studio',
            device: 'desktop',
            channel: 'Paid Social',
            metrics: {
              sessions: rowMetric(1, 'sessions', 24),
              engaged_sessions: rowMetric(1, 'engaged_sessions', 18),
              engagement_rate: rowMetric(1, 'engagement_rate', 75),
            },
          },
          {
            id: 'pricing-mobile-paid',
            landingPage: '/pricing',
            device: 'mobile',
            channel: 'Paid Social',
            metrics: {
              sessions: rowMetric(2, 'sessions', 10),
              engaged_sessions: rowMetric(2, 'engaged_sessions', 7),
            },
          },
          {
            id: 'pricing-desktop-organic',
            landingPage: '/pricing',
            device: 'desktop',
            channel: 'Organic Search',
            metrics: {
              sessions: rowMetric(3, 'sessions', 300),
              engaged_sessions: rowMetric(3, 'engaged_sessions', 210),
            },
          },
        ],
        events: [
          {
            name: 'generate_lead',
            device: 'mobile',
            channel: 'Paid Social',
            metrics: {
              event_count: eventMetric(0, 'event_count', 7),
            },
          },
        ],
      },
    },
    measurement: {
      state: 'available',
      asOf: context.asOf,
      notes: [],
      data: {
        sourceDescription: 'First-party paid association and CAPI transport.',
        paidAssociationNotes: ['Association completeness is a lower bound.'],
        capiNotes: ['Accepted receipts are transport evidence only.'],
        paidAssociation: {
          linked_value_bearing_bookings: measurementMetric('first_party_attribution', 'linked_value_bearing_bookings', 3),
        },
        capi: {
          eligible_website_confirmations: measurementMetric('capi', 'eligible_website_confirmations', 9),
          accepted_live_confirmations: measurementMetric('capi', 'accepted_live_confirmations', 6),
        },
      },
    },
  }
}

describe('deriveJourneyReview', () => {
  it('uses reporting packets that pass the section validator', () => {
    const fixture = data()

    expect(() => validateReportingPacket({
      context,
      section: 'website',
      result: fixture.website,
      notes: [],
    })).not.toThrow()
    expect(() => validateReportingPacket({
      context,
      section: 'measurement',
      result: fixture.measurement,
      notes: [],
    })).not.toThrow()
  })

  it('compares matched GA4 page/device/channel pairs by native engagement rate with exact row metrics', () => {
    const fixture = data()
    const findings = deriveJourneyReview(fixture)
    const finding = findings.find(row => row.id === 'journey.ga4.matched_pair')

    expect(finding?.status).toBe('mixed')
    expect(finding).toBeDefined()
    verifyFindingReferences(fixture, finding!)
    expect(finding?.observation.text).toContain('/studio')
    expect(finding?.observation.text).toContain('mobile')
    expect(finding?.observation.text).toContain('desktop')
    expect(finding?.observation.text).toContain('sessions')
    expect(finding?.observation.text).toContain('engagement rate')
    expect(finding?.observation.text).not.toMatch(/mobile underperforms/i)
    expect(finding?.observation.text).not.toContain('/pricing')
    expect(finding?.observation.evidence.map(ref => [ref.path, ref.metric.key])).toEqual([
      ['/website/data/rows/0/metrics/sessions', 'sessions'],
      ['/website/data/rows/1/metrics/sessions', 'sessions'],
      ['/website/data/rows/0/metrics/engagement_rate', 'engagement_rate'],
      ['/website/data/rows/1/metrics/engagement_rate', 'engagement_rate'],
    ])
    expect(finding?.exposure).toMatchObject({ value: 144, unit: 'sessions' })
    expect(finding?.exposure?.evidence.map(ref => [ref.path, ref.metric.current.unit])).toEqual([
      ['/website/data/rows/0/metrics/sessions', 'count'],
      ['/website/data/rows/1/metrics/sessions', 'count'],
    ])
    expect(finding?.nextInspection.href).toBe('/reports?report=website&website_page=%2Fstudio&website_channel=Paid+Social&from=2026-09-02&to=2026-09-04#website-pages')
  })

  it('allows a partial website packet when the matched row claims and relevant metadata are usable', () => {
    const fixture = data()
    fixture.website.state = 'partial'
    fixture.website.data!.metadata.sampled = true

    const finding = deriveJourneyReview(fixture).find(row => row.id === 'journey.ga4.matched_pair')

    expect(finding?.status).toBe('mixed')
    expect(finding).toBeDefined()
    verifyFindingReferences(fixture, finding!)
    expect(finding?.observation.evidence.map(ref => ref.path)).toEqual([
      '/website/data/rows/0/metrics/sessions',
      '/website/data/rows/1/metrics/sessions',
      '/website/data/rows/0/metrics/engagement_rate',
      '/website/data/rows/1/metrics/engagement_rate',
    ])
  })

  it('requires complete journey claim coverage even when global metadata is only a merged source note', () => {
    const fixture = data()
    fixture.website.data!.rows[0].metrics.sessions = rowMetric(0, 'sessions', 120, {
      state: 'partial',
      numerator: 1,
      denominator: 2,
    })

    const finding = deriveJourneyReview(fixture).find(row => row.id === 'journey.ga4.matched_pair')

    expect(finding?.status).toBe('unavailable')
    expect(finding?.observation.text).toMatch(/session and native engagement-rate claims/i)
    expect(finding?.observation.evidence).toEqual([])
  })

  it('requires comparable native engagement-rate claims for a matched GA4 pair', () => {
    const fixture = data()
    fixture.website.data!.rows[1].metrics.engagement_rate = rowMetric(1, 'engagement_rate', 75, {
      state: 'partial',
      numerator: 1,
      denominator: 2,
    })

    const finding = deriveJourneyReview(fixture).find(row => row.id === 'journey.ga4.matched_pair')

    expect(finding?.status).toBe('unavailable')
    expect(finding?.observation.text).toMatch(/engagement-rate/i)
    expect(finding?.exposure).toBeNull()
  })

  it('reports an identical matched engagement-rate pair as unchanged without inventing concern', () => {
    const fixture = data()
    fixture.website.data!.rows[0].metrics.engagement_rate = rowMetric(0, 'engagement_rate', 75)
    fixture.website.data!.rows[0].metrics.engaged_sessions = rowMetric(0, 'engaged_sessions', 90)

    const finding = deriveJourneyReview(fixture).find(row => row.id === 'journey.ga4.matched_pair')

    expect(finding?.status).toBe('unchanged')
    expect(finding).toBeDefined()
    verifyFindingReferences(fixture, finding!)
    expect(finding?.observation.text).toContain('both measured 75% engagement rate')
    expect(finding?.observation.text).not.toMatch(/difference|lower|underperform|concern/i)
    expect(finding?.nextInspection.outcomes.map(row => row.result).join(' ')).not.toMatch(/downstream events/i)
  })

  it('rejects wrong units and empty session cohorts before interpreting an engagement-rate contrast', () => {
    const wrongUnit = data()
    wrongUnit.website.data!.rows[0].metrics.sessions = rowMetric(0, 'sessions', 120, COMPLETE_FIELD_COVERAGE, 'seconds')
    expect(deriveJourneyReview(wrongUnit).find(row => row.id === 'journey.ga4.matched_pair')?.status).toBe('unavailable')

    const impossibleRate = data()
    impossibleRate.website.data!.rows[0].metrics.engagement_rate = rowMetric(0, 'engagement_rate', 120)
    expect(deriveJourneyReview(impossibleRate).find(row => row.id === 'journey.ga4.matched_pair')?.status).toBe('unavailable')

    const emptyCohort = data()
    emptyCohort.website.data!.rows[1].metrics.sessions = rowMetric(1, 'sessions', 0)
    expect(deriveJourneyReview(emptyCohort).find(row => row.id === 'journey.ga4.matched_pair')?.status).toBe('unavailable')
  })

  it('keeps named GA4 event telemetry scoped to event, device and channel without page or people claims', () => {
    const fixture = data()
    const finding = deriveJourneyReview(fixture).find(row => row.id === 'journey.ga4.event_telemetry')

    expect(finding?.status).toBe('observed')
    expect(finding).toBeDefined()
    verifyFindingReferences(fixture, finding!)
    expect(finding?.observation.text).toContain('generate_lead')
    expect(finding?.observation.text).toContain('mobile')
    expect(finding?.observation.text).toContain('Paid Social')
    expect(finding?.observation.text).not.toContain('/studio')
    expect(finding?.observation.text).not.toMatch(/people|funnel|conversion/i)
    expect(finding?.observation.evidence[0]?.path).toBe('/website/data/events/0/metrics/event_count')
    const href = new URL(finding!.nextInspection.href, 'https://maxx.local')
    expect(href.searchParams.get('website_event')).toBe('generate_lead')
    expect(href.searchParams.get('website_device')).toBe('mobile')
    expect(href.searchParams.has('website_page')).toBe(false)
    expect(href.hash).toBe(`#${websiteEventAnchor(fixture.website.data!.events[0])}`)
  })

  it('reports first-party paid association and CAPI delivery as separate lower-bound cohorts', () => {
    const fixture = data()
    const finding = deriveJourneyReview(fixture).find(row => row.id === 'journey.measurement.association_transport')

    expect(finding?.status).toBe('mixed')
    expect(finding).toBeDefined()
    verifyFindingReferences(fixture, finding!)
    expect(finding?.observation.text).toContain('linked value bearing bookings')
    expect(finding?.observation.text).toContain('accepted live confirmations')
    expect(finding?.observation.text).toContain('separate cohorts')
    expect(JSON.stringify(finding)).not.toMatch(/cancel|refund/i)
    expect(finding?.observation.text).toContain('current booking status')
    expect(finding?.observation.text).not.toMatch(/ad performance|ROAS|cost per/i)
    expect(finding?.observation.evidence.map(ref => ref.path)).toEqual([
      '/measurement/data/paidAssociation/linked_value_bearing_bookings',
      '/measurement/data/capi/eligible_website_confirmations',
      '/measurement/data/capi/accepted_live_confirmations',
    ])
    expect(finding?.exposure).toMatchObject({ value: 9, unit: 'count' })
    expect(finding?.exposure?.evidence.map(ref => ref.path)).toEqual([
      '/measurement/data/capi/eligible_website_confirmations',
    ])
    expect(finding?.nextInspection.href).toBe('/reports?report=website&from=2026-09-02&to=2026-09-04#measurement-evidence')
    expect(finding?.nextInspection.href).not.toMatch(/[?&]section=|[?&]measurement=/)
  })

  it('does not turn all-null paid association and CAPI metrics into mixed exposure zero', () => {
    const fixture = data()
    fixture.measurement!.data!.paidAssociation.linked_value_bearing_bookings =
      measurementMetric('first_party_attribution', 'linked_value_bearing_bookings', null)
    fixture.measurement!.data!.capi.eligible_website_confirmations =
      measurementMetric('capi', 'eligible_website_confirmations', null)
    fixture.measurement!.data!.capi.accepted_live_confirmations =
      measurementMetric('capi', 'accepted_live_confirmations', null)
    const finding = deriveJourneyReview(fixture).find(row => row.id === 'journey.measurement.association_transport')

    expect(finding?.status).toBe('unavailable')
    expect(finding?.exposure).toBeNull()
    expect(finding?.observation.evidence).toEqual([])
  })
})
