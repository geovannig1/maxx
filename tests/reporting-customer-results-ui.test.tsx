import './_support/outcome-noun-booking'
import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { BusinessOverview } from '@/components/reporting/BusinessOverview'
import { BusinessDetailReport } from '@/components/reporting/BusinessDetailReport'
import { businessReportingFixture } from './reporting-browser/business-fixture'
import { customerReportingFixture } from './reporting-browser/customer-fixture'
import { validateReportingPacket } from '@/lib/reporting/validation'
import { CustomerResultSummary } from '@/components/reporting/CustomerResultSummary'

vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams('report=business'), usePathname: () => '/reports' }))

describe('customer results in the ordinary business reading path', () => {
  it('builds the rising-value/falling-hours counterexample from a native ledger without serializing identity', () => {
    const data = customerReportingFixture(), business = data.business.data!
    validateReportingPacket({ section: 'business', context: data.context, result: data.business, notes: [] })
    expect(business.metrics.booked_value.current.value).toBe(1400)
    expect(business.metrics.booked_value.previous!.value).toBe(1200)
    expect(business.metrics.recorded_booked_hours.current.value).toBe(5)
    expect(business.metrics.recorded_booked_hours.previous!.value).toBe(7)
    const groups = business.intelligence!.customers.data!.groups
    expect(groups.map(group => [group.id, group.metrics.booked_value.current.value, group.metrics.booked_value.previous!.value]))
      .toEqual([['prior_booking', 200, 1000], ['first_observed', 1000, 0], ['unidentified', 200, 200]])
    expect(JSON.stringify(data)).not.toContain('@example.test')
    const changed = customerReportingFixture('2026-08-30', '2026-09-01').business.data!.metrics.booked_value
    expect(changed.current.value).toBe(1200)
    expect(changed.previous!.value).toBe(0)
  })
  it.each([BusinessOverview, BusinessDetailReport])('explains the loaded group result beside customer metrics in %s', Component => {
    const html = renderToStaticMarkup(<Component data={businessReportingFixture()} />)
    expect(html).toContain('data-customer-result="business_customers"')
    expect(html).toContain('What explains customer-group results')
    expect(html).toContain('2026-09-02')
    expect(html).toContain('2026-08-30')
    expect(html).toContain('First observed in retained history')
    expect(html).toContain('Unidentified bookings')
  })

  it.each([BusinessOverview, BusinessDetailReport])('puts the prepared answer and customer metrics before lengthy qualifications in %s', Component => {
    const html = renderToStaticMarkup(<Component data={customerReportingFixture()} />)
    const section = html.match(/<section[^>]*aria-label="Customer history(?: summary)?"[^>]*>([\s\S]*?)<\/section>/)![1]
    const answer = section.indexOf('data-customer-result="business_customers"')
    const metrics = section.indexOf('Identified customer records')
    const qualification = section.indexOf('Customer identity uses valid trimmed')
    expect(qualification).toBeGreaterThan(-1)
    expect(answer).toBeLessThan(qualification)
    expect(metrics).toBeLessThan(qualification)
    expect(section).toContain('2026-09-02')
    expect(section).toContain('2026-08-30')
  })

  it('qualifies a partial monetary subtotal and the comparison limit in the opening summary', () => {
    const data = structuredClone(customerReportingFixture())
    const group = data.business.data!.intelligence!.customers.data!.groups[0]
    group.metrics.booked_value.current.coverage = { state: 'partial', numerator: 1, denominator: 2 }
    const html = renderToStaticMarkup(<CustomerResultSummary data={data} />)
    expect(html).toMatch(/\$200[^<]*partial[^<]*subtotal[^<]*1 of 2/i)
    expect(html).toMatch(/price coverage[^<]*comparison|comparison[^<]*price coverage/i)
    expect(html).toContain('First observed in retained history: $1,000')
  })

  it('states the missing count reconciliation reason beside independently valid group money', () => {
    const data = structuredClone(customerReportingFixture())
    delete data.business.data!.intelligence!.customers.data!.groups[0].metrics.bookings
    const html = renderToStaticMarkup(<CustomerResultSummary data={data} />)
    expect(html).toContain('−$800')
    expect(html).toMatch(/bookings unavailable[^<]*reconcil|reconcil[^<]*bookings unavailable/i)
    expect(html).not.toMatch(/0 bookings \(prior 2\)/)
  })

  it('preserves customer detail navigation and useful business evidence when history is missing', () => {
    const data = businessReportingFixture()
    data.business.data!.intelligence!.customers = { state: 'unavailable', data: null, asOf: null, notes: ['Customer history could not be loaded.'] }
    const html = renderToStaticMarkup(<BusinessOverview data={data} />)
    expect(html).toContain('Customer history could not be loaded.')
    expect(html).toContain('Explore customer groups')
    expect(html).toContain('#business-customers')
    expect(html).toContain('$3,200.00')
    expect(html).not.toContain('data-customer-result=')
  })
})
