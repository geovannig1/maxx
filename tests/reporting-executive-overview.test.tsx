import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { AdsReport } from '@/components/reporting/AdsReport'
import { OverviewReport } from '@/components/reporting/OverviewReport'
import { AudienceReport } from '@/components/reporting/AudienceReport'
import { MeasurementEvidence } from '@/components/reporting/MeasurementEvidence'
import { collectReportExportRows } from '@/components/reporting/ReportsReport'
import { executiveFixture } from './reporting-browser/executive-fixture'
import { validateReportingPacket } from '@/lib/reporting/validation'

const navigation = vi.hoisted(() => ({ search: '', path: '/dashboard' }))
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams(navigation.search), usePathname: () => navigation.path }))
beforeEach(() => { navigation.search = ''; navigation.path = '/dashboard' })
const render = (data = executiveFixture()) => renderToStaticMarkup(<OverviewReport data={data} showFindings={false} />)
const comparison = (html: string) => html.match(/<section[^>]*aria-label="Campaign and ad-set comparison"[\s\S]*?<\/section>/)?.[0] ?? ''
const rowIds = (html: string) => [...html.matchAll(/data-hierarchy-row="([^"]+)"/g)].map(match => match[1])
const row = (html: string, id: string) => html.split(`data-hierarchy-row="${id}"`)[1]?.split('</article>')[0] ?? ''
const value = (html: string, key: string) => html.split(`data-hierarchy-metric="${key}"`)[1]?.split('</dd>')[0] ?? ''
const links = (html: string) => [...html.matchAll(/href="([^"]+)"/g)].map(match => new URL(match[1].replaceAll('&amp;', '&'), 'https://maxx.test'))

describe('complete executive performance', () => {
  it.each(['2026-09-02', '2026-09-01'])('uses a valid native-shaped preview with reconciled additive populations for %s', from => {
    const data = executiveFixture(from)
    expect(() => validateReportingPacket({ section: 'meta', context: data.context, result: data.meta, notes: [] })).not.toThrow()
    const meta = data.meta.data!
    for (const period of ['current', 'previous'] as const) for (const key of ['spend', 'impressions', 'clicks', 'outbound_clicks', 'purchase_count', 'purchase_value']) {
      for (const level of ['campaign', 'adset', 'ad']) expect(meta.entities.filter(entity => entity.level === level)
        .reduce((sum, entity) => sum + Number(entity.metrics[key][period]!.value), 0)).toBe(meta.metrics[key][period]!.value)
    }
  })
  it('shows every supplied ad set in one naturally scrolling comparison with named-event results and direct child-detail paths', () => {
    const allRows = comparison(render())
    expect(rowIds(allRows)).toEqual(['set-1', 'set-2', 'set-3', 'set-4', 'set-5', 'set-6', 'set-7', 'set-8', 'set-10', 'set-9'])
    expect(value(row(allRows, 'set-1'), 'bookings')).toContain('>4')
    expect(value(row(allRows, 'set-1'), 'cost_per_booking')).toContain('$225.00')
    expect(value(row(allRows, 'set-1'), 'appointment_roas')).toContain('1.11×')
    expect(allRows).not.toContain('overview_hierarchy_page')
    expect(new Set(rowIds(allRows))).toEqual(new Set(executiveFixture().meta.data!.entities.filter(entity => entity.level === 'adset').map(entity => entity.id)))
    const detail = links(allRows).find(url => url.searchParams.get('adset') === 'set-7')!
    expect(Object.fromEntries(detail.searchParams)).toMatchObject({ account: 'fixture-db', from: '2026-09-02', to: '2026-09-04', level: 'adset', view: 'detail', campaign: 'campaign-2', adset: 'set-7' })
    navigation.search = 'overview_event=purchase&overview_q=set-7'
    const purchase = row(comparison(render()), 'set-7')
    expect(value(purchase, 'purchase_count')).toContain('>1')
    expect(value(purchase, 'cost_per_purchase')).toContain('$60.00')
    expect(value(purchase, 'purchase_roas')).toContain('1.67×')
    expect(purchase).not.toContain('data-hierarchy-metric="bookings"')
  })
  it('preserves the campaign level and links to its complete ad-set population', () => {
    navigation.search = 'overview_level=campaign'
    const html = comparison(render())
    expect(rowIds(html)).toEqual(['campaign-1', 'campaign-2', 'campaign-3'])
    expect(html).toContain('3 campaigns · All supplied statuses')
    expect(html).toContain('Professional productions')
    expect(links(html).some(url => url.searchParams.get('level') === 'campaign' && url.searchParams.get('view') === 'detail' && url.searchParams.get('campaign') === 'campaign-2')).toBe(true)
  })
  it.each(['campaign', 'adset'] as const)('keeps all children reachable through the new %s detail', level => {
    const data = executiveFixture()
    for (const parent of data.meta.data!.entities.filter(entity => entity.level === level)) {
      const id = parent.id
      navigation.path = '/dashboard'; navigation.search = `overview_level=${level}&overview_q=${id}`
      const target = links(comparison(render(data))).find(url => url.searchParams.get('view') === 'detail' && url.searchParams.get(level) === id)!
      expect(target).toBeDefined()
      expect(Object.fromEntries(target.searchParams)).toMatchObject({ account: data.context.account.id, from: data.context.range.from, to: data.context.range.to })
      navigation.search = target.search; navigation.path = '/performance'
      const detail = renderToStaticMarkup(<AdsReport data={data} />)
      const label = level === 'campaign' ? 'All ad sets in this campaign' : 'All ads in this ad set'
      const anchor = detail.match(new RegExp(`<a[^>]*aria-label="${label}"[^>]*>`))![0]
      const next = new URL(anchor.match(/href="([^"]+)"/)![1].replaceAll('&amp;', '&'), 'https://maxx.test')
      expect(next.pathname).toBe('/performance')
      expect(next.searchParams.get(level)).toBe(id)
      expect(next.searchParams.get('view')).toBe(null)
      navigation.search = next.search
      const children = renderToStaticMarkup(<AdsReport data={data} />)
      const expected = data.meta.data!.entities.filter(entity => entity.level === (level === 'campaign' ? 'adset' : 'ad')
        && (level === 'campaign' ? entity.campaignId : entity.adsetId) === id)
      expect(expected.length).toBeGreaterThan(0)
      for (const child of expected) expect(children).toContain(child.name)
    }
  })

  it('surfaces an exception below the first six without labeling unknown results as zero', () => {
    const html = comparison(render())
    expect(rowIds(html)).toContain('set-7')
    expect(row(html, 'set-7')).toContain('Spend with 0 Meta AppointmentConfirmed events')
    expect(value(row(html, 'set-7'), 'bookings')).toContain('>0')
    expect(value(row(html, 'set-10'), 'bookings')).toContain('Unavailable')
    expect(row(html, 'set-10')).not.toContain('Spend with 0')
    expect(row(html, 'set-9')).not.toContain('Spend with 0')
  })
  it.each(['event', 'unit', 'entity', 'window'] as const)('does not classify a %s mismatch as zero AppointmentConfirmed bookings', mismatch => {
    navigation.search = 'overview_q=set-7'
    const data = executiveFixture()
    const entity = data.meta.data!.entities.find(row => row.id === 'set-7')!
    const metric = entity.metrics.bookings
    entity.metrics = { ...entity.metrics, bookings: { ...metric, event: mismatch === 'event' ? 'Purchase' : metric.event,
      current: { ...metric.current, unit: mismatch === 'unit' ? 'money' : metric.current.unit,
        entity: mismatch === 'entity' ? { ...metric.current.entity, id: 'another-set' } : metric.current.entity,
        window: mismatch === 'window' ? { ...metric.current.window, start: '2026-08-01' } : metric.current.window } } }
    const html = comparison(render(data))
    expect(rowIds(html)).toEqual(['set-7'])
    expect(value(row(html, 'set-7'), 'spend')).toContain('$60.00')
    expect(value(row(html, 'set-7'), 'bookings')).toContain('Unavailable')
    expect(row(html, 'set-7')).not.toContain('Spend with 0')
  })
  it('keeps zero and missing rows searchable and supplies a clear no-match state', () => {
    navigation.search = 'overview_q=Unmeasured'
    expect(rowIds(comparison(render()))).toEqual(['set-10'])
    expect(value(row(comparison(render()), 'set-10'), 'bookings')).toContain('Unavailable')
    navigation.search = 'overview_q=Audience+9'
    expect(rowIds(comparison(render()))).toEqual(['set-9'])
    expect(value(row(comparison(render()), 'set-9'), 'bookings')).toContain('>0')
    navigation.search = 'overview_q=does-not-exist'
    expect(rowIds(comparison(render()))).toEqual([])
    expect(comparison(render())).toContain('No ad sets match this search')
  })
  it('removes cancellation reporting while retaining booked value and named-event ROAS in details', () => {
    const html = render()
    expect(html).not.toContain('Canceled appointments')
    expect(html).not.toContain('<th>Canceled</th>')
    expect(html).toContain('Booked value')
    const details = renderToStaticMarkup(<AudienceReport data={executiveFixture()} />)
    expect(details).toContain('AppointmentConfirmed ROAS')
  })
  it('carries complete campaign/ad-set results to the Results export and excludes cancellation metrics everywhere', () => {
    const data = executiveFixture()
    const rows = collectReportExportRows(data, 'results')
    expect(rows.some(row => row.entity.includes('adset set-7') && row.event === 'AppointmentConfirmed')).toBe(true)
    expect(rows.some(row => row.entity.includes('campaign campaign-3'))).toBe(true)
    expect(rows.some(row => /cancel/i.test(row.metric))).toBe(false)
    expect(renderToStaticMarkup(<MeasurementEvidence data={data} />)).not.toContain('Website confirmations later canceled</p>')
  })
})
