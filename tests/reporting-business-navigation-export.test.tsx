import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { ReportsReport, collectReportExportRows, reportPresetFromSearch, reportUrlForPreset } from '@/components/reporting/ReportsReport'
import { OverviewReport } from '@/components/reporting/OverviewReport'
import { buildBusinessReport } from '@/lib/reporting/business-metrics'
import { buildBusinessCustomers, buildBusinessLeadTime, buildBusinessUpcoming, type BusinessIntelligenceRow } from '@/lib/reporting/business-intelligence-metrics'
import { reportingFixture } from '../scripts/demo/sample/reports'
import { businessReportingFixture } from './reporting-browser/business-fixture'
import { deriveExpertReview, overviewFindings } from '@/lib/reporting/review'

const navigation = vi.hoisted(() => ({ search: '' }))
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams(navigation.search),
  usePathname: () => '/reports', useRouter: () => ({ push: vi.fn() }) }))

function fixture() {
  const data = reportingFixture(), context = data.context
  const row: BusinessIntelligenceRow = { id: 1, appointment_type: 'Lower-ranked service', price: 250, amount_paid: 200,
    canceled: false, email: 'synthetic-private@example.test', booking_date_et: context.range.from,
    datetime_created: `${context.range.from}T12:00:00Z`, datetime: '2026-09-08T12:00:00Z' }
  const prior = { ...row, id: 2, appointment_type: 'Prior-only service', price: 100, amount_paid: 100,
    booking_date_et: context.comparison.from, datetime_created: `${context.comparison.from}T12:00:00Z` }
  const rows = [row, prior]
  return { ...data, business: { ...data.business, data: { ...buildBusinessReport(context, [row], [prior]), intelligence: {
    customers: buildBusinessCustomers(context, rows), leadTime: buildBusinessLeadTime(context, rows),
    upcoming: buildBusinessUpcoming(context, rows, context.asOf),
  } } } }
}
beforeEach(() => { navigation.search = '' })

describe('business report navigation and exports', () => {
  it('prepares a business decrease and a supported increase without making the owner search for both', () => {
    const review = deriveExpertReview(businessReportingFixture())
    const visible = overviewFindings(review).filter(finding => finding.area === 'business')
    expect(visible.some(finding => finding.direction === 'declined' || finding.direction === 'mixed')).toBe(true)
    expect(visible.some(finding => finding.direction === 'improved')).toBe(true)
    expect(review.findings.some(finding => finding.id.includes('08%20Prior-only%20service') && finding.direction === 'declined')).toBe(true)
    expect(review.findings.some(finding => finding.id.includes('07%20Low-volume%20seventh%20service') && finding.direction === 'improved')).toBe(true)
  })
  it('resolves the Business preset and renders complete detail destinations', () => {
    navigation.search = 'from=2026-09-02&to=2026-09-04&report=business'
    expect(reportPresetFromSearch(navigation.search)).toBe('business')
    const html = renderToStaticMarkup(<ReportsReport data={fixture()} />)
    for (const id of ['business-results', 'business-types', 'business-customers', 'business-lead-time', 'business-upcoming']) expect(html).toContain(`id="${id}"`)
    expect(html).toContain('Prior-only service')
    expect(html).toContain('Previous: $100.00')
    expect(reportUrlForPreset('/reports', 'from=2026-09-02&to=2026-09-04&business_q=service', 'business'))
      .toBe('/reports?from=2026-09-02&to=2026-09-04&business_q=service&report=business')
  })
  it('places customer, timing and recorded future summaries on the dashboard with date-preserving detail links', () => {
    const html = renderToStaticMarkup(<OverviewReport data={fixture()} showFindings={false} />)
    const links = [...html.matchAll(/href="([^"]+)"/g)].map(match => new URL(match[1].replaceAll('&amp;', '&'), 'https://maxx.test'))
    for (const anchor of ['business-types', 'business-customers', 'business-lead-time', 'business-upcoming']) {
      const link = links.find(url => url.pathname === '/reports' && url.hash === `#${anchor}`)
      expect(link).toBeDefined()
      expect(Object.fromEntries(link!.searchParams)).toMatchObject({ account: 'fixture-db', from: '2026-09-02', to: '2026-09-04', report: 'business' })
    }
    expect(html).toContain('Recorded upcoming demand')
    expect(html).toContain('Service dates 2026-09-06 – 2026-10-03')
  })
  it('exports all business groups and native service comparisons with exact date bases and without identity fields', () => {
    const rows = collectReportExportRows(fixture(), 'business')
    expect(rows.length).toBeGreaterThan(30)
    expect(rows.find(row => row.entity.includes('Prior-only service') && row.metric === 'Amount paid'))
      .toMatchObject({ value: 0, previous_value: 100, from: '2026-09-02', comparison_from: '2026-08-30', date_basis: 'booking_created_date_et' })
    const future = rows.filter(row => row.date_basis === 'service_date_et')
    expect(future.length).toBeGreaterThan(0)
    expect(future.every(row => row.previous_value === null && row.comparison_from === '' && row.comparison_to === '')).toBe(true)
    expect(future.find(row => row.metric === 'Recorded bookings' && row.from === '2026-09-06'))
      .toMatchObject({ value: 2, to: '2026-10-03', source: 'outcomes', coverage: 'partial' })
    expect(JSON.stringify(rows)).not.toContain('synthetic-private@example.test')
    expect(rows.some(row => /cancel|refund|return/i.test(row.metric))).toBe(false)
    expect(rows.some(row => row.entity.includes('customer') && row.limitations.includes('retained'))).toBe(true)
  })
  it('retains the same complete business data in the full results export', () => {
    const data = fixture(), business = collectReportExportRows(data, 'business')
    expect(business.length).toBeGreaterThan(0)
    expect(collectReportExportRows(data, 'results')).toEqual(expect.arrayContaining(business))
  })
})
