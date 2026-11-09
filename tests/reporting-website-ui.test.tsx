import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('next/navigation', () => ({
  usePathname: () => '/reports',
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}))
import { AudienceReport } from '@/components/reporting/AudienceReport'
import {
  collectReportExportRows,
  REPORT_PRESETS,
  reportPresetFromSearch,
  reportUrlForPreset,
  ReportsReport,
} from '@/components/reporting/ReportsReport'
import { WebsiteJourney } from '@/components/reporting/WebsiteJourney'
import { makeReportMetric } from '@/lib/reporting/claims'
import type {
  ReportMetric,
  ReportingContext,
  ReportingData,
  ReportingSectionName,
} from '@/lib/reporting/contracts'

const context: ReportingContext = {
  account: { id: 'account-db', metaAccountId: 'act_123', name: 'Example Studio' },
  range: { from: '2026-09-02', to: '2026-09-04' },
  comparison: { from: '2026-08-30', to: '2026-09-01' },
  timezone: 'America/New_York',
  currency: 'USD',
  asOf: '2026-09-05T16:00:00Z',
}

const complete = { state: 'complete' as const, numerator: 1, denominator: 1 }

function metric(
  source: 'meta' | 'outcomes' | 'ga4',
  key: string,
  label: string,
  current: number,
  unit: ReportMetric['current']['unit'] = 'count',
  event: string | null = null,
): ReportMetric {
  return makeReportMetric({
    context,
    source,
    key,
    label,
    current,
    previous: Math.max(0, current - 1),
    unit,
    event,
    definition: `${label} reported by ${source} for the selected period.`,
    coverage: complete,
    previousCoverage: complete,
  })
}

function fixture(): ReportingData {
  const websiteMetrics = {
    sessions: metric('ga4', 'sessions', 'Sessions', 320),
    engaged_sessions: metric('ga4', 'engaged_sessions', 'Engaged sessions', 205),
    engagement_rate: metric('ga4', 'engagement_rate', 'Engagement rate', 64.1, 'percent'),
    users: metric('ga4', 'users', 'Users', 282),
    page_views: metric('ga4', 'page_views', 'Page views', 615),
    intent_events: metric('ga4', 'intent_events', 'Intent events', 27, 'count', 'begin_checkout'),
    lead_events: metric('ga4', 'lead_events', 'Lead events', 8, 'count', 'generate_lead'),
    confirmation_events: metric('ga4', 'confirmation_events', 'Tracked confirmations', 5, 'count', 'appointment_confirmed'),
  }
  const eventCount = metric('ga4', 'event_count', 'Event count', 27, 'count', 'begin_checkout')

  return {
    context,
    meta: {
      state: 'available',
      asOf: context.asOf,
      notes: [],
      data: {
        metrics: {
          spend: metric('meta', 'spend', 'Spend', 120, 'money'),
          bookings: metric('meta', 'bookings', 'Reported bookings', 6, 'count', 'AppointmentConfirmed'),
          cost_per_booking: metric('meta', 'cost_per_booking', 'Cost per reported booking', 20, 'money', 'AppointmentConfirmed'),
          appointment_value: metric('meta', 'appointment_value', 'Reported booking value', 480, 'money', 'AppointmentConfirmed'),
          appointment_roas: metric('meta', 'appointment_roas', 'AppointmentConfirmed ROAS', 4, 'ratio', 'AppointmentConfirmed'),
          purchase_count: metric('meta', 'purchase_count', 'Reported purchases', 4, 'count', 'Purchase'),
          purchase_value: metric('meta', 'purchase_value', 'Reported purchase value', 360, 'money', 'Purchase'),
          purchase_roas: metric('meta', 'purchase_roas', 'Purchase ROAS', 3, 'ratio', 'Purchase'),
          outbound_clicks: metric('meta', 'outbound_clicks', 'Outbound clicks', 44),
          landing_page_views: metric('meta', 'landing_page_views', 'Landing page views', 31),
        },
        entities: [
          {
            id: 'adset-1', level: 'adset', name: 'Cold Springfield creators',
            campaignId: 'campaign-1', campaignName: 'Studio rentals',
            adsetId: 'adset-1', adsetName: 'Cold Springfield creators',
            status: 'ACTIVE', configurationAsOf: context.asOf,
            audience: 'cold', audienceLabel: 'Cold · Springfield creators', creative: null,
            metrics: {
              spend: metric('meta', 'spend', 'Spend', 80, 'money'),
              impressions: metric('meta', 'impressions', 'Impressions', 9000),
              reach: metric('meta', 'reach', 'Reach', 7100),
              bookings: metric('meta', 'bookings', 'Reported bookings', 5, 'count', 'AppointmentConfirmed'),
              cost_per_booking: metric('meta', 'cost_per_booking', 'Cost per reported booking', 16, 'money', 'AppointmentConfirmed'),
              purchase_count: metric('meta', 'purchase_count', 'Reported purchases', 3, 'count', 'Purchase'),
              purchase_roas: metric('meta', 'purchase_roas', 'Purchase ROAS', 2.5, 'ratio', 'Purchase'),
            },
          },
          {
            id: 'ad-1', level: 'ad', name: 'Cyclorama video',
            campaignId: 'campaign-1', campaignName: 'Studio rentals',
            adsetId: 'adset-1', adsetName: 'Cold Springfield creators',
            status: 'ACTIVE', configurationAsOf: context.asOf,
            audience: 'cold', audienceLabel: 'Cold · Springfield creators', creative: null,
            metrics: { spend: metric('meta', 'spend', 'Spend', 80, 'money') },
          },
        ],
        series: [], comparisonSeries: [],
        breakdowns: [
          { id: 'placement-feed', dimension: 'placement', label: 'Instagram Feed', metrics: {
            spend: metric('meta', 'placement_spend', 'Spend', 72, 'money'),
            impressions: metric('meta', 'placement_impressions', 'Impressions', 9000),
            reach: metric('meta', 'placement_reach', 'Reach', 7100),
          } },
          { id: 'age-25-34', dimension: 'age', label: '25–34', metrics: {
            spend: metric('meta', 'age_spend', 'Spend', 62, 'money'),
            impressions: metric('meta', 'age_impressions', 'Impressions', 7600),
          } },
        ],
        observations: [], attributionWindow: '7-day click / 1-day view',
        reportingTime: 'conversion', sourceDescription: 'Meta Ads Insights for the selected account and dates.',
      },
    },
    business: {
      state: 'available', asOf: context.asOf, notes: [],
      data: {
        metrics: {
          paid_bookings: metric('outcomes', 'paid_bookings', 'Paid bookings', 8),
          amount_paid: metric('outcomes', 'amount_paid', 'Amount paid', 2125, 'money'),
        },
        series: [], comparisonSeries: [], types: [],
        sourceDescription: 'Acuity ledger by booking creation date, all acquisition sources.',
      },
    },
    website: {
      state: 'available', asOf: context.asOf, notes: [],
      data: {
        metrics: websiteMetrics,
        rows: [{
          id: 'book-mobile-paid', landingPage: '/book', device: 'mobile', channel: 'Paid Social',
          metrics: {
            sessions: metric('ga4', 'row_sessions', 'Sessions', 73),
            engaged_sessions: metric('ga4', 'row_engaged_sessions', 'Engaged sessions', 48),
            engagement_rate: metric('ga4', 'row_engagement_rate', 'Engagement rate', 65.8, 'percent'),
          },
        }],
        events: [{ name: 'begin_checkout', device: 'mobile', channel: 'Paid Social', metrics: { event_count: eventCount } }],
        metadata: {
          timezone: 'America/New_York', currency: 'USD', subjectToThresholding: null,
          dataLossFromOtherRow: false, sampled: false, returnedRows: 1, totalRows: 1,
        },
        sourceDescription: 'GA4 sessions and events for the selected property and dates.',
      },
    },
  }
}

function unavailable(data: ReportingData, section: ReportingSectionName): ReportingData {
  return { ...data, [section]: { state: 'unavailable', data: null, asOf: null, notes: ['Connection unavailable.'] } }
}

describe('WebsiteJourney', () => {
  it('keeps Meta, GA4 and Acuity populations in explicit source lanes', () => {
    const html = renderToStaticMarkup(<WebsiteJourney data={fixture()} />)
    expect(html).toContain('Meta outbound activity')
    expect(html).toContain('GA4 website behavior')
    expect(html).toContain('Business outcome activity')
    expect(html).toContain('all acquisition sources')
    expect(html.toLowerCase()).not.toContain('cross-source conversion rate')
  })

  it('shows landing page, device, channel and per-event evidence with definitions', () => {
    const html = renderToStaticMarkup(<WebsiteJourney data={fixture()} />)
    expect(html).toContain('/book')
    expect(html).toContain('mobile')
    expect(html).toContain('Paid Social')
    expect(html).toContain('begin_checkout')
    expect(html).toContain('Event count')
    expect(html).toContain('2026-09-02')
    expect(html).toContain('America/New_York')
  })

  it('marks a failed website source unavailable instead of rendering a zero', () => {
    const html = renderToStaticMarkup(<WebsiteJourney data={unavailable(fixture(), 'website')} />)
    expect(html).toContain('GA4 website behavior unavailable')
    expect(html).toContain('Connection unavailable.')
    expect(html).not.toContain('0 sessions')
  })

  it('keeps partial source notes next to the available observations', () => {
    const data = fixture()
    const partial: ReportingData = {
      ...data,
      website: { ...data.website, state: 'partial', notes: ['Event inventory incomplete.'] },
    }
    const html = renderToStaticMarkup(<WebsiteJourney data={partial} />)
    expect(html).toContain('Partial · As of')
    expect(html).toContain('Event inventory incomplete.')
    expect(html).toContain('320')
  })
})

describe('AudienceReport', () => {
  it('renders audience and placement evidence without adding non-additive reach', () => {
    const html = renderToStaticMarkup(<AudienceReport data={fixture()} />)
    expect(html).toContain('Audience and placement')
    expect(html).toContain('Cold · Springfield creators')
    expect(html).toContain('Instagram Feed')
    expect(html).toContain('25–34')
    expect(html).toContain('Reach is not added across breakdown rows')
    expect(html).toContain('7-day click / 1-day view')
  })

  it('keeps a failed Meta source explicit', () => {
    const html = renderToStaticMarkup(<AudienceReport data={unavailable(fixture(), 'meta')} />)
    expect(html).toContain('Audience evidence unavailable')
    expect(html).toContain('Connection unavailable.')
  })

  it('uses ad sets as audience units, shows canonical result metrics, and names every missing breakdown', () => {
    const source = fixture()
    const original = source.meta.data!.entities[0]
    const resultMetrics = {
      spend: metric('meta', 'spend', 'Spend', 80, 'money'),
      impressions: metric('meta', 'impressions', 'Impressions', 9000),
      reach: metric('meta', 'reach', 'Reach', 7100),
      bookings: metric('meta', 'bookings', 'Reported bookings', 6, 'count', 'AppointmentConfirmed'),
      cost_per_booking: metric('meta', 'cost_per_booking', 'Cost per reported booking', 13.33, 'money', 'AppointmentConfirmed'),
      purchase_count: metric('meta', 'purchase_count', 'Reported purchases', 4, 'count', 'Purchase'),
      purchase_roas: metric('meta', 'purchase_roas', 'Purchase ROAS', 2.1, 'ratio', 'Purchase'),
    }
    const data: ReportingData = {
      ...source,
      meta: {
        ...source.meta,
        data: {
          ...source.meta.data!,
          entities: [
            { ...original, id: 'campaign-71', level: 'campaign', name: 'Campaign summary only', metrics: resultMetrics },
            { ...original, id: 'adset-71', level: 'adset', name: 'Springfield creator audience', metrics: resultMetrics },
            { ...original, id: 'ad-71', level: 'ad', name: 'Ad execution only', metrics: resultMetrics },
          ],
          breakdowns: [{
            id: 'placement-reels', dimension: 'placement', label: 'Instagram Reels', metrics: resultMetrics,
          }],
        },
      },
    }

    const html = renderToStaticMarkup(<AudienceReport data={data} />)
    expect(html).toContain('Springfield creator audience')
    expect(html).toContain('Ad set · adset-71')
    expect(html).not.toContain('Campaign summary only')
    expect(html).not.toContain('Ad execution only')
    expect(html).toContain('Reported bookings')
    expect(html).toContain('Cost per reported booking')
    expect(html).toContain('Reported purchases')
    expect(html).toContain('Purchase ROAS')
    expect(html).toContain('Age breakdown unavailable')
    expect(html).toContain('Gender breakdown unavailable')
    expect(html).toContain('Region breakdown unavailable')
  })
})

describe('ReportsReport', () => {
  it('offers business and other prepared reports and opens with results', () => {
    expect(REPORT_PRESETS.map(({ key, label }) => ({ key, label }))).toEqual([
      { key: 'results', label: 'Results' },
      { key: 'business', label: 'Business' },
      { key: 'creative', label: 'Creative' },
      { key: 'website', label: 'Website journey' },
      { key: 'audience', label: 'Audience report' },
    ])
    const html = renderToStaticMarkup(<ReportsReport data={fixture()} />)
    expect(html).toContain('Results report')
    expect(html).toContain('Print report')
    expect(html).toContain('Export full results')
    expect(html).toContain('2026-08-30')
    expect(html).toContain('2026-09-04')
  })

  it('resolves direct preset links and browser-history query values', () => {
    expect(reportPresetFromSearch('from=2026-09-02&to=2026-09-04&report=website')).toBe('website')
    expect(reportPresetFromSearch('from=2026-09-02&to=2026-09-04&report=audience')).toBe('audience')
    expect(reportPresetFromSearch('from=2026-09-02&to=2026-09-04&report=unknown')).toBe('results')
    expect(reportUrlForPreset('/reports', 'from=2026-09-02&to=2026-09-04&report=audience', 'website'))
      .toBe('/reports?from=2026-09-02&to=2026-09-04&report=website')
    expect(reportUrlForPreset('/reports', 'from=2026-09-02&to=2026-09-04&report=website', 'results'))
      .toBe('/reports?from=2026-09-02&to=2026-09-04')
  })

  it('builds each export from the metrics visible in that prepared report', () => {
    const data = fixture()
    const website = collectReportExportRows(data, 'website')
    const audience = collectReportExportRows(data, 'audience')
    const creative = collectReportExportRows(data, 'creative')

    expect(website.map(row => row.entity)).toEqual(expect.arrayContaining([
      'Meta outbound activity',
      'GA4 website behavior',
      '/book · mobile · Paid Social',
      'begin_checkout · mobile · Paid Social',
      'Business outcome activity',
    ]))
    expect(website.every(row => row.from === '2026-09-02' && row.timezone === 'America/New_York')).toBe(true)
    expect(audience.map(row => row.entity)).toContain('Placement · Instagram Feed')
    expect(audience.filter(row => row.entity.includes('adset-1')).map(row => row.metric)).toEqual(expect.arrayContaining([
      'Spend', 'Impressions', 'Reach', 'Reported bookings', 'Cost per reported booking', 'Reported purchases', 'Purchase ROAS',
    ]))
    expect(collectReportExportRows(data, 'results').map(row => row.metric)).toContain('Reported booking value')
    expect(creative.map(row => row.entity)).toContain('Creative · Cyclorama video')
  })
})
