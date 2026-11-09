import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ReportTrend } from '@/components/reporting/ReportTrend'
import { makeReportMetric } from '@/lib/reporting/claims'
import type { ReportMetric, ReportingContext } from '@/lib/reporting/contracts'

const context: ReportingContext = {
  account: { id: 'account-db', metaAccountId: 'act_123', name: 'Studio' },
  range: { from: '2026-09-02', to: '2026-09-04' },
  comparison: { from: '2026-08-30', to: '2026-09-01' },
  timezone: 'America/New_York', currency: 'USD', asOf: '2026-09-05T16:00:00Z',
}
const complete = { state: 'complete' as const, numerator: 1, denominator: 1 }

function metric(key: string, label: string, value: number, unit: ReportMetric['current']['unit'] = 'count', date = context.range.from) {
  return makeReportMetric({
    context: { ...context, range: { from: date, to: date } }, key, label, current: value, previous: Math.max(0, value - 1), unit,
    source: 'meta', definition: `${label} for the selected account day.`,
    coverage: complete, previousCoverage: complete,
  })
}

describe('ReportTrend', () => {
  it('keeps pending daily reads distinct from a completed response without daily evidence', () => {
    const spend = metric('spend', 'Spend', 10, 'money')
    const pending = renderToStaticMarkup(<ReportTrend context={context} metrics={{ spend }} series={[]} comparisonSeries={[]} detailsLoading />)
    expect(pending).toContain('Loading daily evidence')
    expect(pending).not.toContain('Daily evidence unavailable')
    expect(pending).not.toContain('Gaps mean unavailable')
    expect(pending).not.toContain('Unavailable')
    const completed = renderToStaticMarkup(<ReportTrend context={context} metrics={{ spend }} series={[]} comparisonSeries={[]} />)
    expect(completed).toContain('Daily evidence unavailable')
    expect(completed).not.toContain('Loading daily evidence')
  })

  it('retains supplied daily values while absent days remain pending', () => {
    const spend = metric('spend', 'Spend', 10, 'money')
    const html = renderToStaticMarkup(<ReportTrend context={context} metrics={{ spend }} detailsLoading
      series={[{ date: '2026-09-02', metrics: { spend } }]} comparisonSeries={[]} />)
    expect(html).toContain('data-series="current"')
    expect(html).toContain('$10.00')
    expect(html).toContain('Loading')
    expect(html).not.toContain('Unavailable')
  })

  it('renders current and preceding equal-period evidence in both directions', () => {
    const spend = metric('spend', 'Spend', 10, 'money')
    const html = renderToStaticMarkup(<ReportTrend
      context={context}
      metrics={{ spend }}
      series={[
        { date: '2026-09-02', metrics: { spend: metric('spend', 'Spend', 10, 'money') } },
        { date: '2026-09-03', metrics: { spend: metric('spend', 'Spend', 20, 'money', '2026-09-03') } },
      ]}
      comparisonSeries={[
        { date: '2026-08-30', metrics: { spend: metric('spend', 'Spend', 8, 'money', '2026-08-30') } },
        { date: '2026-08-31', metrics: { spend: metric('spend', 'Spend', 16, 'money', '2026-08-31') } },
      ]}
    />)

    expect(html).toContain('Spend trend for 2026-09-02 to 2026-09-04, with preceding period')
    expect(html).toContain('2026-09-02')
    expect(html).toContain('2026-08-30')
    expect(html).toContain('data-series="current"')
    expect(html).toContain('data-series="prior"')
  })

  it('uses the first available option when spend is absent', () => {
    const bookings = metric('bookings', 'AppointmentConfirmed', 3)
    const html = renderToStaticMarkup(<ReportTrend
      context={context}
      metrics={{ bookings }}
      series={[{ date: '2026-09-02', metrics: { bookings } }]}
      comparisonSeries={[]}
    />)

    expect(html).toContain('AppointmentConfirmed trend')
    expect(html).toContain('data-series="current"')
    expect(html).not.toContain('Daily evidence unavailable for this period.')
  })

  it('keeps isolated current and prior points visible without inventing a connecting line', () => {
    const clicks = metric('outbound_clicks', 'Outbound clicks', 4, 'count', '2026-09-04')
    const html = renderToStaticMarkup(<ReportTrend
      context={context}
      metrics={{ outbound_clicks: clicks }}
      series={[{ date: '2026-09-04', metrics: { outbound_clicks: clicks } }]}
      comparisonSeries={[{ date: '2026-09-01', metrics: { outbound_clicks: metric('outbound_clicks', 'Outbound clicks', 2, 'count', '2026-09-01') } }]}
    />)

    expect(html).toContain('data-series="current"')
    expect(html).toContain('data-series="prior"')
    expect(html).toContain('2026-09-01: 2')
  })

  it('bins longer ranges weekly while preserving daily-range wording for short periods', () => {
    const longContext: ReportingContext = {
      ...context,
      range: { from: '2026-08-01', to: '2026-09-04' },
      comparison: { from: '2026-06-27', to: '2026-07-31' },
    }
    const spend = metric('spend', 'Spend', 10, 'money', '2026-08-01')
    const html = renderToStaticMarkup(<ReportTrend
      context={longContext}
      metrics={{ spend }}
      series={[{ date: '2026-08-01', metrics: { spend } }]}
      comparisonSeries={[]}
    />)

    expect(html).toContain('7-day bins')
    expect(html).toContain('2026-08-01 – 2026-08-07')
    expect(html).not.toContain('Daily observed values')
  })
})
