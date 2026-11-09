import './_support/outcome-noun-booking'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { BusinessDetailReport, businessServiceHref } from '@/components/reporting/BusinessDetailReport'
import { BusinessOverview } from '@/components/reporting/BusinessOverview'
import { buildBusinessUpcoming } from '@/lib/reporting/business-intelligence-metrics'
import { validateReportingPacket } from '@/lib/reporting/validation'
import { businessReportingFixture as fixture } from './reporting-browser/business-fixture'

const navigation = vi.hoisted(() => ({ search: null as string | null, pathname: null as string | null }))
vi.mock('next/navigation', () => ({
  useSearchParams: () => navigation.search === null ? null : new URLSearchParams(navigation.search),
  usePathname: () => navigation.pathname,
}))
const context = fixture().context
const serviceNames = ['01 Native service', '02 Native service', '03 Native service', '04 Native service', '05 Native service', '06 Native service', '07 Low-volume seventh service', '08 Prior-only service']
const render = (data = fixture()) => renderToStaticMarkup(<BusinessDetailReport data={data} />)
function section(html: string, id: string) {
  return html.match(new RegExp(`<section[^>]*id="${id}"[^>]*>([\\s\\S]*?)<\\/section>`))?.[1] ?? ''
}
const serviceIds = (html: string) => [...html.matchAll(/data-business-service="([^"]+)"/g)].map(match => match[1])
function numeric(value: unknown): number {
  if (typeof value !== 'number') throw new Error('Expected a supplied numeric fixture value.')
  return value
}
beforeEach(() => { navigation.search = null; navigation.pathname = null })

describe('business detail and dashboard reading', () => {
  it('shares coherent native business evidence with the browser account without exposing ledger identities', () => {
    const data = fixture(), business = data.business.data!
    expect(data.context.account.id).toBe('fixture-db')
    expect(data.meta.data?.entities).toHaveLength(4)
    expect(data.website.data).not.toBeNull()
    expect(data.measurement?.state).toBe('unavailable')
    expect(validateReportingPacket({ section: 'business', context: data.context, result: data.business, notes: [] }).section).toBe('business')
    for (const key of ['paid_bookings', 'amount_paid', 'active_appointments', 'booked_value']) {
      const currentObserved = business.types.map(type => type.metrics[key].current.value).filter(value => value !== null)
      const previousObserved = business.types.map(type => type.metrics[key].previous?.value).filter(value => value !== null)
      expect(currentObserved.reduce<number>((sum, value) => sum + numeric(value), 0)).toBe(business.metrics[key].current.value)
      expect(previousObserved.reduce<number>((sum, value) => sum + numeric(value), 0)).toBe(business.metrics[key].previous!.value)
    }
    // Only recorded monetary observations reconcile; the wholly unknown service stays unknown.
    expect(business.types.find(type => type.name === '06 Native service')?.metrics.amount_paid.current.value).toBeNull()
    expect(business.types.find(type => type.name === '06 Native service')?.metrics.paid_bookings.current.value).toBeNull()
    expect(business.types.find(type => type.name === '07 Low-volume seventh service')?.metrics.booked_value.current.value).toBe(200)
    expect(business.types.find(type => type.name === '07 Low-volume seventh service')?.metrics.booked_value.previous?.value).toBe(50)
    expect(business.types.find(type => type.name === '08 Prior-only service')?.metrics.booked_value.current.value).toBe(0)
    expect(business.types.find(type => type.name === '08 Prior-only service')?.metrics.booked_value.previous?.value).toBe(500)
    expect(JSON.stringify(data)).not.toContain('@example.test')
  })

  it('keeps business and intelligence cohorts aligned when the selected dates include other retained records', () => {
    const data = fixture('2026-08-27', '2026-08-29'), business = data.business.data!
    expect(business.metrics.active_appointments.current.value).toBe(11)
    expect(business.intelligence!.leadTime.data!.metrics.eligible_bookings.current.value).toBe(11)
    expect(business.intelligence!.customers.data!.groups.reduce((sum, group) => sum + numeric(group.metrics.bookings.current.value), 0)).toBe(11)
    expect(business.intelligence!.upcoming.data!.range).toEqual({ from: '2026-09-06', to: '2026-10-03' })
    expect(data.context.range).toEqual({ from: '2026-08-27', to: '2026-08-29' })
  })

  it('retains all native services, including the seventh and prior-only values, with source scope', () => {
    const html = render()
    expect(serviceIds(html)).toEqual(serviceNames)
    expect(html).toContain('Low-volume seventh service')
    expect(html).toContain('Prior-only service')
    expect(section(html, 'business-types')).toContain('Previous: $250.00')
    expect(section(html, 'business-results')).toContain('$1,800.00')
    expect(html).toContain('Fictional business source note.')
    expect(html).toContain(context.asOf)
    expect(html).toContain('America/New_York')
    expect(html).toMatch(/booking creation/i)
  })

  it('scopes service search to its table, retaining account/customer/schedule totals and a known-false control', () => {
    const all = render()
    navigation.search = 'business_q=seventh'
    const filtered = render()
    expect(serviceIds(filtered)).toEqual(['07 Low-volume seventh service'])
    for (const id of ['business-results', 'business-customers', 'business-lead-time', 'business-upcoming']) expect(section(filtered, id)).toBe(section(all, id))
    navigation.search = 'business_q=not-a-real-service'
    const absent = render()
    expect(serviceIds(absent)).toEqual([])
    expect(absent).toContain('No services match')
    expect(absent).toContain('Clear service search')
    expect(section(absent, 'business-results')).toContain('$1,800.00')
  })

  it('preserves non-service URL state and fragment through search and clear', () => {
    const href = businessServiceHref('/reports', 'report=business&account=studio&from=2026-09-02&to=2026-09-04&review_q=offer', '#business-types', '08 Prior-only service')
    const url = new URL(href, 'https://maxx.test')
    expect(Object.fromEntries(url.searchParams)).toEqual({ report: 'business', account: 'studio', from: '2026-09-02', to: '2026-09-04', review_q: 'offer', business_q: '08 Prior-only service' })
    expect(url.hash).toBe('#business-types')
    navigation.search = url.search
    expect(serviceIds(render())).toEqual(['08 Prior-only service'])
    navigation.search = new URL(businessServiceHref(url.pathname, url.search, url.hash, ''), url.origin).search
    expect(serviceIds(render())).toHaveLength(8)
  })

  it('qualifies retained email-history cohorts and elapsed lead time without inventing acquisition or conversion lag', () => {
    const html = render()
    expect(section(html, 'business-customers')).toContain('Prior booking in retained history')
    expect(section(html, 'business-customers')).toContain('First observed in retained history')
    expect(section(html, 'business-customers')).toContain('2026-01-01')
    expect(section(html, 'business-customers')).toMatch(/not confirmed new/i)
    expect(section(html, 'business-customers')).toMatch(/lowercase|lower.case/i)
    expect(section(html, 'business-customers')).toMatch(/trim|whitespace/i)
    expect(section(html, 'business-customers')).toMatch(/not.*unique people/i)
    expect(section(html, 'business-lead-time')).toContain('7.3 days')
    expect(section(html, 'business-lead-time')).toContain('30 days or more')
    expect(section(html, 'business-lead-time')).toMatch(/not ad.touch.*lag/i)
    expect(section(html, 'business-lead-time')).toContain('7 of 8 current bookings')
    expect(section(html, 'business-lead-time')).toContain('Previous: 5.0 days')
    expect(section(html, 'business-customers')).toContain('Previous: 9')
  })

  it('shows the recorded upcoming schedule on its separate service-date range with payments distinct from price', () => {
    const schedule = section(render(), 'business-upcoming')
    expect(schedule).toContain('2026-09-06')
    expect(schedule).toContain('2026-10-03')
    expect(schedule).toContain('2026-09-30')
    expect(schedule).toContain('Future recorded service')
    expect(schedule).toContain('$2,500.00')
    expect(schedule).toContain('$1,100.00')
    expect(schedule).toMatch(/service dates/i)
    expect(schedule).toMatch(/completeness.*unverified/i)
    expect(schedule).toMatch(/omitted date.*open slot/i)
    expect(schedule).not.toMatch(/ROAS|\d+% utilization|\d+ available slots/i)
  })

  it.each(['loading', 'unavailable'] as const)('limits a %s customer source without hiding service results or other intelligence', state => {
    const data = fixture()
    data.business.data!.intelligence!.customers = { state, data: null, asOf: null, notes: ['Customer history could not be read.'] }
    const html = render(data)
    expect(section(html, 'business-customers')).toContain(state === 'loading' ? 'Loading customer history' : 'Customer history unavailable')
    expect(section(html, 'business-customers')).toContain('Customer history could not be read.')
    expect(serviceIds(html)).toHaveLength(8)
    expect(section(html, 'business-results')).toContain('$1,800.00')
    expect(section(html, 'business-lead-time')).toContain('7.3 days')
  })

  it.each([
    ['customers', 'business_customer_read_unavailable', 'Customer history could not be loaded.'],
    ['leadTime', 'business_lead_time_read_unavailable', 'Booking lead time could not be loaded.'],
    ['upcoming', 'business_upcoming_read_unavailable', 'The recorded upcoming schedule could not be loaded.'],
  ] as const)('explains a %s read failure without exposing its machine code or hiding business totals', (key, code, message) => {
    const data = fixture()
    data.business.data!.intelligence![key] = { state: 'unavailable', data: null, asOf: null, notes: [code] }
    for (const html of [render(data), renderToStaticMarkup(<BusinessOverview data={data} />)]) {
      expect(html.includes(code)).toBe(false)
      expect(html.includes(message)).toBe(true)
      expect(html.includes('Refresh the report to try again.')).toBe(true)
      expect(section(html, 'business-results')).toContain('$1,800.00')
    }
    expect(serviceIds(render(data))).toHaveLength(8)
  })

  it('preserves arbitrary source notes that are not known failure codes', () => {
    const data = fixture()
    data.business.notes = ['constructor', 'business_customer_read_unavailable_extra']
    const html = render(data)
    expect(html.includes('>constructor<')).toBe(true)
    expect(html.includes('business_customer_read_unavailable_extra')).toBe(true)
  })

  it('visibly scopes customer and lead groups when a zero-price payment belongs only to the headline cohort', () => {
    const data = fixture(context.range.from, context.range.to, { includeZeroPricePayment: true })
    const business = data.business.data!, groups = business.intelligence!.customers.data!.groups
    expect(business.metrics.amount_paid.current.value).toBe(1875)
    expect(business.metrics.paid_bookings.current.value).toBe(7)
    expect(groups.reduce((sum, group) => sum + numeric(group.metrics.amount_paid.current.value), 0)).toBe(1800)
    expect(business.intelligence!.leadTime.data!.metrics.eligible_bookings.current.value).toBe(8)
    for (const html of [render(data), renderToStaticMarkup(<BusinessOverview data={data} />)]) {
      expect(section(html, 'business-results').includes('$1,875.00')).toBe(true)
      expect(html.includes('Customer groups cover active positive-price bookings.')).toBe(true)
      expect(html.includes('Booking lead time covers active positive-price bookings.')).toBe(true)
    }
  })

  it('keeps a legacy report useful when optional intelligence is absent and does not claim empty future capacity', () => {
    const data = fixture()
    data.business.data = { ...data.business.data!, intelligence: undefined }
    const legacy = render(data)
    expect(serviceIds(legacy)).toHaveLength(8)
    expect(legacy).toContain('Customer history was not supplied')
    expect(legacy).toContain('Booking lead time was not supplied')
    expect(legacy).toContain('Recorded upcoming schedule was not supplied')
    const empty = fixture()
    empty.business.data!.intelligence!.upcoming = buildBusinessUpcoming(context, [], context.asOf)
    const upcoming = section(render(empty), 'business-upcoming')
    expect(upcoming).toContain('Unavailable')
    expect(upcoming).not.toContain('$0.00')
    expect(upcoming).not.toMatch(/\b0 bookings|\d+ open slots|\d+ available slots/)
  })

  it('provides compact business/customer/lead/schedule summaries with exact business-detail links', () => {
    navigation.search = 'account=studio&from=2026-09-02&to=2026-09-04'
    const html = renderToStaticMarkup(<BusinessOverview data={fixture()} />)
    for (const value of ['$1,800.00', '7.3 days', '$2,500.00', '2026-09-06', '2026-10-03']) expect(html).toContain(value)
    const links = [...html.matchAll(/href="([^"]+)"/g)].map(match => new URL(match[1].replaceAll('&amp;', '&'), 'https://maxx.test'))
    for (const anchor of ['#business-types', '#business-customers', '#business-lead-time', '#business-upcoming']) {
      const link = links.find(url => url.hash === anchor)!
      expect(link).toBeDefined()
      expect(link.pathname).toBe('/reports')
      expect(link.searchParams.get('report')).toBe('business')
      expect(link.searchParams.get('account')).toBe('studio')
      expect(link.searchParams.get('from')).toBe(context.range.from)
      expect(link.searchParams.get('to')).toBe(context.range.to)
    }
  })

  it('keeps all supplied table rows directly printable and omits excluded internal status metrics', () => {
    const html = render()
    expect(serviceIds(html)).toHaveLength(8)
    expect(html).toContain('data-business-day="2026-09-30"')
    expect(html).not.toMatch(/refund|canceled_appointments|cancellation|customer returns/i)
    expect(html).not.toContain('Next page')
    expect(html).toContain('print:overflow-visible')
    expect(html).toContain('print:min-w-0')
  })
})
