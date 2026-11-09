import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
vi.mock('next/navigation', () => ({ usePathname: () => '/reports', useSearchParams: () => new URLSearchParams() }))
import { selectedWebsiteRows, WebsiteTables } from '@/components/reporting/WebsiteTables'
import { collectReportExportRows, websiteExportPending } from '@/components/reporting/ReportsReport'
import { websiteEventAnchor, websiteRowAnchor } from '@/lib/reporting/website-identity'
import { websiteReportingFixture } from './reporting-browser/website-fixture'

describe('complete website comparison detail', () => {
  it('preserves all current/prior tuples and scopes page and event filters independently', () => {
    const report = websiteReportingFixture().website.data
    expect(selectedWebsiteRows(report, new URLSearchParams()).rows).toHaveLength(13)
    const selected = selectedWebsiteRows(report, new URLSearchParams({ website_page: '/book', website_device: 'mobile', website_channel: 'Paid Social' }))
    expect(selected.rows.map(row => row.landingPage)).toEqual(['/book'])
    expect(selected.events).toHaveLength(3) // no false page identity added to events
    expect(selectedWebsiteRows(report, new URLSearchParams({ website_event: 'appointment_confirmed' })).rows).toHaveLength(13)
    expect(selectedWebsiteRows(report, new URLSearchParams({ website_q: 'not-a-supplied-cohort' }))).toEqual({ rows: [], events: [] })
    expect(selectedWebsiteRows(report, new URLSearchParams({ website_q: 'previous-only' })).rows).toHaveLength(1)
  })
  it('shows native prior values, missing-current rows and all traffic columns with stable fragment-safe IDs', () => {
    const data = websiteReportingFixture(), html = renderToStaticMarkup(<WebsiteTables report={data.website.data} context={data.context} />)
    expect(html).toContain('13 of 13 supplied rows')
    expect(html).toContain('Previous: 2026-08-30')
    expect(html).toContain('/previous-only')
    expect(html).toContain('Users')
    expect(html).toContain('Page views')
    const row = data.website.data.rows.find(row => row.landingPage === '/previous-only')!
    expect(row.metrics.sessions.current.value).toBeNull()
    expect(row.metrics.sessions.previous?.value).toBe(25)
    for (const id of [websiteRowAnchor(row), websiteEventAnchor(data.website.data.events[0])]) {
      expect(decodeURIComponent(id)).toBe(id)
      expect(html).toContain(`id="${id}"`)
    }
    expect(websiteRowAnchor({ ...row, landingPage: '/one%20two' })).not.toBe(websiteRowAnchor({ ...row, landingPage: '/one two' }))
  })
  it('exports the complete supplied report including prior-only traffic and observed lag evidence', () => {
    const data = websiteReportingFixture(), exported = collectReportExportRows(data, 'website')
    expect(exported.some(row => row.entity.includes('/gallery-8'))).toBe(true)
    expect(exported.some(row => row.entity.includes('/previous-only') && row.metric === 'Sessions')).toBe(true)
    expect(exported.some(row => row.metric === 'P90 paid-touch to booking lag')).toBe(true)
    expect(exported.some(row => /cancel|refund/i.test(row.metric))).toBe(false)
  })
  it('waits for every requested website source to settle before offering the full export', () => {
    const data = websiteReportingFixture()
    expect(websiteExportPending(data)).toBe(false)
    expect(websiteExportPending({ ...data, measurement: { state: 'loading', data: null, asOf: null, notes: [] } })).toBe(true)
    expect(websiteExportPending({ ...data, measurement: { state: 'unavailable', data: null, asOf: null, notes: ['Read failed.'] } })).toBe(false)
  })
})
