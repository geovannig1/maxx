import './_support/outcome-noun-booking'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { OverviewReport } from '@/components/reporting/OverviewReport'
import { SavedReportProvider } from '@/components/reporting/SavedReportContext'
import { makeReportMetric, COMPLETE_FIELD_COVERAGE } from '@/lib/reporting/claims'
import type { ReportingData } from '@/lib/reporting/contracts'
import type { OpenSavedReportingReportReply } from '@/lib/reporting/saved-contract'
import { executiveFixture } from './reporting-browser/executive-fixture'

const navigation = vi.hoisted(() => ({ search: '' }))
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams(navigation.search), usePathname: () => '/dashboard' }))
beforeEach(() => { navigation.search = '' })
const section = (html: string, label: string) => html.match(new RegExp(`<section[^>]*aria-label="${label}"[^>]*>[\\s\\S]*?<\\/section>`))?.[0] ?? ''
const destinations = (html: string) => [...html.matchAll(/href="([^"]+)"/g)].map(match => match[1].replaceAll('&amp;', '&'))
  .filter(href => href.startsWith('/')).map(href => new URL(href, 'https://maxx.test'))

const context: ReportingData['context'] = {
  account: { id: 'db', metaAccountId: 'act_1', name: 'Studio' },
  range: { from: '2026-09-02', to: '2026-09-04' }, comparison: { from: '2026-08-30', to: '2026-09-01' },
  timezone: 'America/New_York', currency: 'USD', asOf: '2026-09-05T17:00:00Z',
}
const unavailable = { state: 'unavailable' as const, data: null, asOf: null, notes: [] }
describe('results-first overview', () => {
  it('shows the business lane despite unavailable Meta, with explicit sources and prior results', () => {
    const metric = makeReportMetric({ context, key: 'paid_bookings', label: 'Paid bookings', source: 'outcomes',
      unit: 'count', current: 2, previous: 1, definition: 'Active appointments with positive amount paid.',
      coverage: COMPLETE_FIELD_COVERAGE, previousCoverage: COMPLETE_FIELD_COVERAGE })
    const data: ReportingData = { context, meta: unavailable, website: unavailable,
      business: { state: 'available', asOf: context.asOf, notes: [], data: {
        metrics: { paid_bookings: metric }, series: [], comparisonSeries: [], types: [], sourceDescription: 'Acuity business ledger',
      } } }
    const html = renderToStaticMarkup(<OverviewReport data={data} />)
    const business = section(html, 'Business results'), advertising = section(html, 'Advertising results')
    expect(business).toContain('Bookings · All sources')
    expect(business).toContain('aria-label="Bookings with recorded payment: 2. Definition and source"')
    expect(business).toContain('Previous: 1')
    expect(advertising).toContain('Dashboard result event')
    expect(advertising).toContain('<option value="appointment_confirmed" selected="">AppointmentConfirmed</option>')
    expect(advertising).toContain('Meta · Attributed · Unavailable')
    expect(advertising).toContain('aria-label="Reported results: Unavailable. Definition and source"')
    expect(advertising).toContain('aria-label="Reported ROAS: Unavailable. Definition and source"')
    expect(html).not.toContain('Paid CPA')
  })
  it('can omit duplicated findings inside a prepared report', () => {
    const data: ReportingData = { context, meta: unavailable, business: unavailable, website: unavailable }
    const html = renderToStaticMarkup(<OverviewReport data={data} showFindings={false} />)
    expect(html).not.toContain('aria-label="Executive interpretation"')
    expect(html).not.toContain('aria-label="What deserves a closer look"')
    expect(html).toContain('Advertising results')
  })
  it('keeps AppointmentConfirmed selected when its results are unavailable and Purchase has observations', () => {
    const data = executiveFixture()
    const html = renderToStaticMarkup(<OverviewReport data={data} showFindings={false} />)
    const advertising = section(html, 'Advertising results')
    expect(data.meta.data!.metrics.purchase_count.current.value).toBe(10)
    expect(advertising).toContain('<option value="appointment_confirmed" selected="">AppointmentConfirmed</option>')
    expect(advertising).toContain('aria-label="Reported results: Unavailable. Definition and source"')
    expect(advertising).toContain('aria-label="Cost / result: Unavailable. Definition and source"')
    expect(advertising).toContain('aria-label="AppointmentConfirmed reported value: Unavailable. Definition and source"')
  })
  it('lets the dashboard choose the named event without changing drill pages', () => {
    const data = executiveFixture()
    navigation.search = 'overview_event=purchase'
    const html = renderToStaticMarkup(<OverviewReport data={data} showFindings={false} />)
    const advertising = section(html, 'Advertising results')
    expect(advertising).toContain('aria-label="Dashboard result event"')
    expect(advertising).toContain('<option value="purchase" selected="">Purchase</option>')
    expect(advertising).toContain('aria-label="Reported results: 10. Definition and source"')
    expect(advertising).toContain('aria-label="Cost / result: $220.00. Definition and source"')
    expect(advertising).toContain('aria-label="Reported ROAS: 0.45×. Definition and source"')
    expect(advertising).toContain('aria-label="Purchase reported value: $1,000.00. Definition and source"')
    const results = destinations(advertising).find(url => url.pathname === '/performance' && url.searchParams.get('group') === 'results')!
    expect(results).toBeDefined()
    expect(Object.fromEntries(results.searchParams)).toEqual({ account: data.context.account.id, from: '2026-09-02', to: '2026-09-04', group: 'results' })
    expect(html).not.toContain('customer return')
    expect(html).not.toContain('cancellation')
    expect(html).not.toContain('refund')
  })
  it('uses the 25-row executive creative scan by default', () => {
    const data = executiveFixture()
    const html = renderToStaticMarkup(<OverviewReport data={data} showFindings={false} />)
    expect(html).toContain('10 ads supplied · 10 matches · 10 on this page')
    const rows = [...html.matchAll(/<tr[^>]*aria-label="(Creative \d+) comparison"/g)].map(match => match[1])
    expect(rows).toEqual(['Creative 1', 'Creative 2', 'Creative 3', 'Creative 4', 'Creative 5',
      'Creative 6', 'Creative 7', 'Creative 8', 'Creative 10', 'Creative 9'])
    expect(html).toContain('aria-label="Search creative"')
    expect(html).toContain('Page 1 of 1')
    expect(html.match(/<button[^>]*aria-label="Previous creative page"[^>]*>/)?.[0]).toContain('disabled=""')
    const next = html.match(/<button[^>]*aria-label="Next creative page"[^>]*>/)?.[0]
    expect(next).toBeDefined()
    expect(next).toContain('disabled=""')
  })
  it('preserves the explicit compact five-row creative scan', () => {
    navigation.search = 'overview_creative_size=5'
    const html = renderToStaticMarkup(<OverviewReport data={executiveFixture()} showFindings={false} />)
    expect(html).toContain('10 ads supplied · 10 matches · 5 on this page')
    expect([...html.matchAll(/<tr[^>]*aria-label="(Creative \d+) comparison"/g)].map(match => match[1]))
      .toEqual(['Creative 1', 'Creative 2', 'Creative 3', 'Creative 4', 'Creative 5'])
    expect(html).toContain('Page 1 of 2')
    expect(html.match(/<button[^>]*aria-label="Next creative page"[^>]*>/)?.[0]).not.toContain('disabled=""')
  })
  it('preserves original saved-report identity on overview drill links', () => {
    const data = executiveFixture()
    const saved = { saved: { id: 'saved-overview' } } as OpenSavedReportingReportReply
    const html = renderToStaticMarkup(<SavedReportProvider value={saved}><OverviewReport data={data} showFindings={false} /></SavedReportProvider>)
    const urls = destinations(html)
    expect(urls.some(url => url.pathname === '/performance' && url.searchParams.get('group') === 'results')).toBe(true)
    expect(urls.some(url => url.pathname === '/creative')).toBe(true)
    expect(urls.some(url => url.pathname === '/reports' && url.searchParams.get('report') === 'business' && url.hash === '#business-results')).toBe(true)
    for (const url of urls) {
      expect(url.searchParams.get('account')).toBe(data.context.account.id)
      expect(url.searchParams.get('from')).toBe(data.context.range.from)
      expect(url.searchParams.get('to')).toBe(data.context.range.to)
      expect(url.searchParams.get('saved')).toBe(saved.saved.id)
    }
  })
})
