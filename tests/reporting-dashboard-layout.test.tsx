import './_support/outcome-noun-booking'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { SavedReportProvider } from '@/components/reporting/SavedReportContext'
import type { OpenSavedReportingReportReply } from '@/lib/reporting/saved-contract'
import { OverviewReport } from '@/components/reporting/OverviewReport'
import { overviewEvent, overviewHref, overviewEventMetric, OVERVIEW_EVENTS } from '@/lib/reporting/overview-model'
import { executiveFixture } from './reporting-browser/executive-fixture'

describe('approved executive dashboard', () => {
  it('keeps AppointmentConfirmed explicit even when only Purchase totals are available', () => {
    const data = executiveFixture()
    const html = renderToStaticMarkup(<OverviewReport data={data} showFindings={false} />)
    expect(html).toContain('<option value="appointment_confirmed" selected="">')
    expect(html).not.toContain('Purchase selected')
    expect(overviewEvent('purchase')).toBe('purchase')
    expect(overviewEvent('unexpected')).toBe('appointment_confirmed')
  })
  it('puts distinct source results before creatives and retains business context during a Meta outage', () => {
    const fixture = executiveFixture()
    const data = { ...fixture, meta: { state: 'unavailable' as const, data: null, asOf: null, notes: [] } }
    const html = renderToStaticMarkup(<OverviewReport data={data} showFindings={false} />)
    expect(html).toContain('Bookings with recorded payment')
    expect(html).toContain('Recorded booked hours')
    expect(html).toContain('Booking economics &amp; outlook')
    expect(html).toContain('After the click')
    expect(html).toContain('Booked value')
    expect(html.indexOf('Business results')).toBeLessThan(html.indexOf('Creative comparison'))
    expect(html).not.toMatch(/refund|cancellation|customer return/i)
  })
  it('preserves account, dates, selected entity and saved identity on detail navigation', () => {
    const context = executiveFixture().context
    const url = new URL(overviewHref(context, '/creative', { ad: 'ad-8', account: 'wrong-account', from: '2000-01-01', to: '2000-01-02' }, 'saved-1'), 'https://maxx.test')
    expect(Object.fromEntries(url.searchParams)).toEqual({ account: context.account.id, from: context.range.from,
      to: context.range.to, ad: 'ad-8', saved: 'saved-1' })
    expect(url.searchParams.has('overview_event')).toBe(false)
  })
  it('withholds a mislabeled event without hiding independently valid spend or the selected event', () => {
    const data = executiveFixture(), metrics = data.meta.data!.metrics
    expect(overviewEventMetric(metrics, 'purchase_count', OVERVIEW_EVENTS.purchase)).toBeDefined()
    const mismatched = { ...metrics, purchase_count: { ...metrics.purchase_count, event: 'AppointmentConfirmed' } }
    expect(overviewEventMetric(mismatched, 'purchase_count', OVERVIEW_EVENTS.purchase)).toBeUndefined()
    expect(overviewEventMetric({ ...metrics, purchase_count: { ...metrics.purchase_count,
      current: { ...metrics.purchase_count.current, unit: 'money' } } }, 'purchase_count', OVERVIEW_EVENTS.purchase)).toBeUndefined()
  })
  it('keeps saved paid-link inspection inside the matching frozen reporting destination', () => {
    const data = executiveFixture()
    const saved = { saved: { id: 'saved-dashboard' } } as OpenSavedReportingReportReply
    const html = renderToStaticMarkup(<SavedReportProvider value={saved}><OverviewReport data={data} showFindings={false} /></SavedReportProvider>)
    const href = html.match(/href="([^"]+#measurement-evidence)"/)?.[1]?.replaceAll('&amp;', '&')
    expect(href).toBeDefined()
    const url = new URL(href!, 'https://maxx.test')
    expect(url.pathname).toBe('/reports')
    expect(url.searchParams.get('report')).toBe('website')
    expect(url.searchParams.get('saved')).toBe('saved-dashboard')
    expect(url.searchParams.get('account')).toBe(data.context.account.id)
  })

  it.each(['window', 'account', 'source', 'clock'] as const)('keeps current event results but strips a conflicting prior %s', problem => {
    const data = executiveFixture(), metrics = data.meta.data!.metrics, metric = metrics.purchase_count
    const previous = metric.previous!
    const edited = { ...metrics, purchase_count: { ...metric, previous: { ...previous, value: 123456789,
      window: problem === 'window' ? { ...previous.window, start: '1999-01-01' } : previous.window,
      entity: problem === 'account' ? { ...previous.entity, id: 'other' } : previous.entity,
      source: problem === 'source' ? { ...previous.source, role: 'business_truth' as const } : previous.source,
      asOf: problem === 'clock' ? '2099-01-01T00:00:00Z' : previous.asOf,
    } } }
    const selected = overviewEventMetric(edited, 'purchase_count', OVERVIEW_EVENTS.purchase, data.context, data.meta.asOf)
    expect(selected?.current).toEqual(metric.current)
    expect(selected?.previous).toBeNull()
  })

})
