import './_support/outcome-noun-booking'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { BusinessOverview } from '@/components/reporting/BusinessOverview'
import { BusinessDetailReport } from '@/components/reporting/BusinessDetailReport'
import { OverviewContext } from '@/components/reporting/OverviewContext'
import { collectReportExportRows } from '@/components/reporting/ReportsReport'
import { buildBusinessReport, type BusinessLedgerRow } from '@/lib/reporting/business-metrics'
import { businessReportingFixture } from './reporting-browser/business-fixture'
import { referenceReportingFixture } from './reporting-browser/reference-fixture'

const navigation = vi.hoisted(() => ({ search: '' }))
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams(navigation.search),
  usePathname: () => '/reports', useRouter: () => ({ push: vi.fn() }) }))
beforeEach(() => { navigation.search = 'from=2026-09-02&to=2026-09-04&report=business' })
const driverSection = (html: string) => html.match(/<section[^>]*id="business-drivers"[^>]*>([\s\S]*?)<\/section>/)?.[1] ?? ''
const serviceChanges = (html: string) => html.split('data-overview-service-changes')[1]?.split('Customer history')[0] ?? ''

function serviceChangeFixture(alpha = 640) {
  const data = businessReportingFixture()
  const typeIds: Record<string, number> = { Alpha: 1, Beta: 2, Gone: 3, Gamma: 4, Delta: 5, Epsilon: 6, Zeta: 7 }
  const row = (id: number, service: string, price: number, prior = false): BusinessLedgerRow => ({ id,
    appointment_type_id: typeIds[service], appointment_type: service,
    booking_date_et: prior ? data.context.comparison.from : data.context.range.from,
    price, amount_paid: price, canceled: false, appointment_duration: '60',
  })
  const current = [row(1, 'Alpha', alpha), row(2, 'Beta', 415), row(3, 'Gamma', 160), row(4, 'Gamma', 160),
    row(5, 'Delta', 85), row(6, 'Epsilon', 205), row(7, 'Zeta', 120)]
  const prior = [row(101, 'Alpha', 260, true), row(102, 'Beta', 240, true), row(103, 'Gone', 285, true),
    row(104, 'Gamma', 320, true), row(105, 'Delta', 85, true), row(106, 'Epsilon', 205, true), row(107, 'Zeta', 120, true)]
  data.business.data = buildBusinessReport(data.context, current, prior)
  return data
}

describe('business result explanation in the owner reading path', () => {
  it('explains booked-value change on the opening screen and links to the exact comparative detail', () => {
    const html = renderToStaticMarkup(<BusinessOverview data={businessReportingFixture()} />)
    expect(html).toContain('What explains booked value')
    expect(html).toContain('+$500.00')
    expect(html).toContain('8 of 8 services')
    expect(html).toContain('Value per positive-price booking: $300.00 → $400.00')
    expect(html).toContain('Higher value per booking offsets fewer bookings')
    expect(html).toContain('/reports?from=2026-09-02&amp;to=2026-09-04&amp;report=business#business-drivers')
  })

  it('keeps all signed service contributors, independent of the existing service-table search', () => {
    navigation.search += '&business_q=seventh'
    const html = renderToStaticMarkup(<BusinessDetailReport data={businessReportingFixture()} />)
    const section = driverSection(html)
    expect([...section.matchAll(/data-business-driver="([^"]+)"/g)]).toHaveLength(8)
    expect(section).toContain('07 Low-volume seventh service')
    expect(section).toContain('08 Prior-only service')
    expect(section).toContain('+$150.00')
    expect(section).toContain('−$500.00')
    expect(section).toContain('Booking-count component')
    expect(section).toContain('Value-per-booking component')
    expect(section).toContain('Native calculation inputs')
    expect(section).toContain('business_q=08+Prior-only+service')
    expect(section).toContain('#business-service-08%20Prior-only%20service')
    expect(section).not.toMatch(/refund|cancell|returns reporting/i)
  })

  it('retains booked-value explanation despite unknown payments and partial recorded durations', () => {
    const html = driverSection(renderToStaticMarkup(<BusinessDetailReport data={businessReportingFixture()} />))
    expect(html).toContain('+$500.00')
    expect(html).toContain('06 Native service')
    expect(html).toContain('8 of 8 services')
    expect(html).toContain('complete duration')
  })

  it('drills to the exact native row when names are identical and one service ID prefixes another', () => {
    const data = businessReportingFixture()
    const row = { id: 1, appointment_type: 'Shared name', appointment_type_id: 10, booking_date_et: data.context.range.from,
      canceled: false, price: 100, amount_paid: 100, appointment_duration: '60' }
    data.business.data = buildBusinessReport(data.context, [row, { ...row, id: 2, appointment_type_id: 100 }], [])
    navigation.search += '&business_q=outcome-type%3A10'
    const html = renderToStaticMarkup(<BusinessDetailReport data={data} />)
    expect(html).toContain('id="business-service-outcome-type%3A10"')
    expect(html).toContain('id="business-service-outcome-type%3A100"')
    expect(driverSection(html)).toContain('#business-service-outcome-type%3A10"')
    expect(driverSection(html)).toContain('#business-service-outcome-type%3A100"')
  })

  it('exports each displayed change and arithmetic components with native input identities and date context', () => {
    const data = businessReportingFixture()
    const all = collectReportExportRows(data, 'business')
    const drivers = all.filter(row => row.entity.startsWith('Booked-value drivers'))
    expect(drivers.filter(row => row.metric === 'Booked-value change')).toHaveLength(9)
    expect(drivers.find(row => row.entity.includes('08 Prior-only service') && row.metric === 'Booked-value change'))
      .toMatchObject({ value: -500, previous_value: null, source: 'maxx', from: '2026-09-02', comparison_from: '2026-08-30', date_basis: 'booking_created_date_et' })
    expect(drivers.some(row => row.metric === 'Booking-count component')).toBe(true)
    expect(drivers.some(row => row.metric === 'Value-per-booking component')).toBe(true)
    expect(drivers.every(row => row.limitations.includes('/business/data/') && row.limitations.includes('report:outcomes:'))).toBe(true)
    expect(collectReportExportRows(data, 'results')).toEqual(expect.arrayContaining(drivers))
  })

  it('does not reintroduce a rejected prior value through the native input drawer or calculated export', () => {
    const data = businessReportingFixture()
    const first = data.business.data!.types[0]
    const previous = first.metrics.booked_value.previous!
    first.metrics.booked_value = { ...first.metrics.booked_value, previous: { ...previous, value: 123456, asOf: '2026-09-06T17:00:00Z' } }
    const html = driverSection(renderToStaticMarkup(<BusinessDetailReport data={data} />))
    expect(html).not.toContain('123,456')
    expect(html).toContain('Previous: Unavailable')
    expect(html).toContain('Previous service sum: Unavailable')
    const rows = collectReportExportRows(data, 'business').filter(row => row.entity.startsWith('Booked-value drivers') && row.entity.includes(first.name))
    expect(rows.find(row => row.metric === 'Booked-value change')?.value).toBeNull()
    expect(rows.find(row => row.metric === 'Value per positive-price booking')).toMatchObject({ value: 500, previous_value: null })
  })

  it('uses the accepted source observation for derived export metadata when the current input clock is rejected', () => {
    const data = businessReportingFixture(), first = data.business.data!.types[0]
    const current = first.metrics.booked_value.current
    first.metrics.booked_value = { ...first.metrics.booked_value, current: { ...current, asOf: '2026-09-06T17:00:00Z',
      window: { ...current.window, start: '2026-08-01' } } }
    const average = collectReportExportRows(data, 'business').find(row => row.entity.startsWith('Booked-value drivers')
      && row.entity.includes(first.name) && row.metric === 'Value per positive-price booking')
    expect(average).toMatchObject({ value: null, previous_value: 250, as_of: data.business.asOf,
      from: data.context.range.from, to: data.context.range.to, timezone: data.context.timezone,
      comparison_from: data.context.comparison.from, comparison_to: data.context.comparison.to,
      attribution_scope: 'all_sources', date_basis: 'booking_created_date_et' })
  })
})

describe('dashboard largest service changes', () => {
  it('groups repeated context qualifications without changing underlying evidence states', () => {
    const data = referenceReportingFixture()
    const html = renderToStaticMarkup(<OverviewContext data={data} />)
    const customer = html.split('Customer history')[1]?.split('Booking → service date')[0] ?? ''
    const response = html.split('Advertising response')[1]?.split('Website behavior')[0] ?? ''
    const upcoming = html.split('Recorded upcoming demand')[1]?.split('</section>')[0] ?? ''
    const paid = html.split('Paid-booking evidence')[1]?.split('Paid touch → booking')[0] ?? ''

    expect(customer).toContain('Bookings · Retained customer history · Partial evidence')
    expect(customer).not.toContain('>Partial</p>')
    expect(response).toContain('Meta · Selected reporting dates · Settling')
    expect(response).not.toContain('>Settling</p>')
    const upcomingRange = data.business.data!.intelligence!.upcoming.data!.range
    expect(upcoming).toContain(`Service dates ${upcomingRange.from} – ${upcomingRange.to} · Partial evidence`)
    expect(upcoming).not.toContain('>Partial</p>')
    expect(paid).toContain('First-party paid links · Booking-created cohort · Partial evidence')
    expect(paid).not.toContain('>Partial</p>')
    expect(data.business.data!.intelligence!.customers.data!.metrics.first_observed_customers.current.coverage.state).toBe('partial')
    expect(data.meta.data!.metrics.outbound_clicks.current.maturity.state).toBe('settling')
  })

  it('shows current, prior, direction, and a derived selected subtotal plus remainder', () => {
    const html = serviceChanges(renderToStaticMarkup(<OverviewContext data={serviceChangeFixture()} savedId="saved-4" />))
    expect(html).toContain('Largest service changes')
    expect(html).toContain('2 of 7 bookings · $1,055 of $1,785')
    expect(html).toContain('Remaining services · 5 bookings · $730')
    expect(html).toMatch(/Gone[\s\S]*Prior \$285\.00 → Current \$0\.00[\s\S]*−\$285\.00/)
    expect(html).toMatch(/Alpha[\s\S]*Prior \$260\.00 → Current \$640\.00[\s\S]*\+\$380\.00/)
    expect(html).toContain('saved=saved-4')
    expect(html).toContain('#business-types')
  })

  it('derives changed fixture values and withholds incompatible reconciliation', () => {
    expect(serviceChanges(renderToStaticMarkup(<OverviewContext data={serviceChangeFixture(560)} />)))
      .toContain('2 of 7 bookings · $975 of $1,705')
    const incompatible = serviceChangeFixture()
    incompatible.business.data!.metrics.booked_value.current = {
      ...incompatible.business.data!.metrics.booked_value.current,
      availability: { state: 'unavailable', blockerCodes: ['incompatible_total'] }, value: null,
    }
    const html = serviceChanges(renderToStaticMarkup(<OverviewContext data={incompatible} />))
    expect(html).toContain('Reconciliation unavailable')
    expect(html).not.toContain('of $1,785')
  })

  it('withholds reconciliation when a service booking count has a different observation head', () => {
    const data = serviceChangeFixture()
    const alpha = data.business.data!.types.find(row => row.name === 'Alpha')!
    alpha.metrics.value_bearing_bookings.current = { ...alpha.metrics.value_bearing_bookings.current,
      source: { ...alpha.metrics.value_bearing_bookings.current.source, head: 'different-count-head' } }
    const html = serviceChanges(renderToStaticMarkup(<OverviewContext data={data} />))
    expect(html).toContain('Alpha')
    expect(html).toContain('Reconciliation unavailable')
    expect(html).not.toContain('2 of 7 bookings')
  })

  it('withholds reconciliation when a service booking count uses an incompatible clock or scope', () => {
    const data = serviceChangeFixture()
    const alpha = data.business.data!.types.find(row => row.name === 'Alpha')!
    alpha.metrics.value_bearing_bookings.current = { ...alpha.metrics.value_bearing_bookings.current,
      asOf: '2026-09-05T16:00:00Z', window: { ...alpha.metrics.value_bearing_bookings.current.window, basis: 'service_date_et' } }
    const html = serviceChanges(renderToStaticMarkup(<OverviewContext data={data} />))
    expect(html).toContain('Reconciliation unavailable')
    expect(html).not.toContain('Remaining services · 5 bookings · $730')
  })
})
