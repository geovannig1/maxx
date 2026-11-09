import './_support/outcome-noun-booking'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AdDetail } from '@/components/reporting/AdDetail'
import { ReportTrend } from '@/components/reporting/ReportTrend'
import { BusinessOverview } from '@/components/reporting/BusinessOverview'
import { BusinessDetailReport } from '@/components/reporting/BusinessDetailReport'
import { collectReportExportRows } from '@/components/reporting/ReportsReport'
import { SavedViewSchema } from '@/lib/reporting/saved-contract'
import * as temporal from '@/lib/reporting/trend'
import { makeReportMetric } from '@/lib/reporting/claims'
import type { ReportSeriesPoint, ReportingContext } from '@/lib/reporting/contracts'
import { businessReportingFixture } from './reporting-browser/business-fixture'

const navigation = vi.hoisted(() => ({ search: '' }))
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams(navigation.search), usePathname: () => '/reports', useRouter: () => ({}) }))
const context: ReportingContext = {
  account: { id: 'fixture-db', metaAccountId: 'act_fixture', name: 'Fictional studio' },
  range: { from: '2026-09-02', to: '2026-09-04' }, comparison: { from: '2026-08-30', to: '2026-09-01' },
  asOf: '2026-09-05T16:00:00Z', timezone: 'America/New_York', currency: 'USD',
}
function day(date: string, value: number | null, source: 'outcomes' | 'meta' = 'outcomes', key = 'booked_value'): ReportSeriesPoint {
  const dayContext = { ...context, range: { from: date, to: date }, comparison: { from: date, to: date } }
  return { date, metrics: { [key]: makeReportMetric({ context: dayContext, key, label: key === 'purchase_roas' ? 'Purchase ROAS' : key === 'bookings' ? 'AppointmentConfirmed' : 'Booked value',
    current: value, previous: undefined, unit: key === 'purchase_roas' ? 'ratio' : key === 'bookings' ? 'count' : 'money', source,
    definition: 'Native selected-day observation.', event: key === 'purchase_roas' ? 'Purchase' : key === 'bookings' ? 'AppointmentConfirmed' : null,
    coverage: { state: 'complete', numerator: 1, denominator: 1 }, entity: { level: source === 'outcomes' ? 'business' : 'account', id: context.account.id },
    basis: source === 'outcomes' ? 'booking_created_date_et' : 'impression_date_et' }) } }
}
function trend(series: ReportSeriesPoint[], comparisonSeries: ReportSeriesPoint[] = [], extra = {}) {
  return renderToStaticMarkup(<ReportTrend {...{ context, metrics: series[0]?.metrics ?? {}, series, comparisonSeries, kind: 'business' as const, ...extra }} />)
}
beforeEach(() => { navigation.search = '' })

describe('temporal business and advertising reading', () => {
  it('makes the business trajectory available on the executive and full business surfaces', () => {
    for (const Component of [BusinessOverview, BusinessDetailReport]) {
      const html = renderToStaticMarkup(<Component data={businessReportingFixture()} />)
      expect(html).toContain('Business results over time')
      expect(html).toContain('business-trend')
      expect(html).toContain('2026-08-30')
    }
  })

  it('keeps equal totals with opposite daily trajectories visible against their actual prior dates', () => {
    const current = [day('2026-09-02', 100), day('2026-09-03', 0), day('2026-09-04', 0)]
    const prior = [day('2026-08-30', 0), day('2026-08-31', 0), day('2026-09-01', 100)]
    const html = trend(current, prior)
    expect(html).toContain('2026-09-02: $100.00')
    expect(html).toContain('2026-09-04: $0.00')
    expect(html).toContain('2026-08-30: $0.00')
    expect(html).toContain('2026-09-01: $100.00')
    expect(html).toContain('Booking dates')
    expect(current.every(point => point.metrics.booked_value.previous === null)).toBe(true)
  })

  it('shows Purchase return rather than silently falling back to spend', () => {
    const current = [day('2026-09-02', 1.25, 'meta', 'purchase_roas')]
    const html = trend(current, [], { kind: 'meta', selectedMetric: 'purchase_roas' })
    expect(html).toContain('Purchase ROAS trend')
    expect(html).toContain('1.25×')
    expect(html).toContain('value="purchase_roas" selected')
  })

  it('preserves a prior-only observation and gaps without inventing a connecting line', () => {
    const html = trend([day('2026-09-02', 100), day('2026-09-04', 50)], [day('2026-08-31', 30)])
    expect(html).toContain('2026-08-31: $30.00')
    expect(html).not.toContain('data-series="current-line"')
    expect(html).toContain('Unavailable')
    expect(html).toContain('2026-09-03')
  })

  it('rejects wrong-day claims and conflicting duplicate dates instead of plotting a plausible amount', () => {
    const wrong = structuredClone(day('2026-09-02', 999, 'meta', 'spend'))
    wrong.metrics.spend.current.window.start = '2026-09-01'
    const html = trend([wrong, day('2026-09-03', 777, 'meta', 'spend'), day('2026-09-03', 888, 'meta', 'spend')], [], { kind: 'meta' })
    expect(html).not.toContain('$999.00')
    expect(html).not.toContain('$777.00')
    expect(html).not.toContain('$888.00')
    expect(html).toContain('Unavailable')
  })

  it('prints qualifications and independent daily definitions with the observations', () => {
    const current = structuredClone(day('2026-09-02', 100))
    current.metrics.booked_value.current.coverage = { state: 'partial', numerator: 1, denominator: 2 }
    current.metrics.booked_value.current.freshness.state = 'stale'
    const html = trend([current], [day('2026-08-30', 80)])
    expect(html.match(/<p>First observed:([\s\S]*?)<\/p>/)?.[1] ?? '').toContain('Partial evidence')
    expect(html).toContain('Partial evidence')
    expect(html).toContain('Stale evidence')
    expect(html).toContain('Native selected-day observation.')
    expect(html).toContain('print:max-h-none')
  })

  it('keeps native and canonical booking days visible without drawing one continuous outcome series', () => {
    const native = day('2026-09-02', 0, 'meta', 'bookings')
    const canonical = structuredClone(day('2026-09-03', 2, 'meta', 'bookings'))
    canonical.metrics.bookings.current.source.head = 'meta-campaign-daily-authority:act_fixture:2026-09-05T16:00:00Z'
    const html = trend([native, canonical], [], { kind: 'meta', selectedMetric: 'bookings' })
    expect(html).toContain('native account daily AppointmentConfirmed')
    expect(html).toContain('exact-day campaign authority')
    expect(html).not.toContain('data-series="current-line"')
    expect(html).toContain('data-series="current"')
  })

  it('identifies a complete canonical daily sum that differs from its period headline', () => {
    const today = structuredClone(day('2026-09-02', 1, 'meta', 'bookings'))
    today.metrics.bookings.current.source.head = 'meta-campaign-daily-authority:act_fixture:2026-09-05T16:00:00Z'
    const headline = day('2026-09-02', 2, 'meta', 'bookings').metrics
    const oneDay = { ...context, range: { from: '2026-09-02', to: '2026-09-02' }, comparison: { from: '2026-09-01', to: '2026-09-01' } }
    const html = trend([today], [], { kind: 'meta', selectedMetric: 'bookings', metrics: headline, context: oneDay })
    expect(html).toContain('Reported daily sum: 1. Period aggregate: 2.')
    expect(html).toContain('independent readings disagree')
  })

  it('restores the business metric from URL state while keeping service filters scoped to their table', () => {
    navigation.search = 'report=business&business_trend=amount_paid&business_q=seventh'
    const html = renderToStaticMarkup(<BusinessDetailReport data={businessReportingFixture()} />)
    expect(html).toContain('value="amount_paid" selected')
    expect(html).toContain('Amount paid trend')
    expect(html).toContain('All sources')
  })

  it('preserves temporal selections in saved report definitions and rejects unsupported keys', () => {
    const query = { meta_trend: 'purchase_roas', business_trend: 'amount_paid', ad_trend: 'purchase_value', ad_trend_period: 'previous' }
    expect(SavedViewSchema.safeParse({ pathname: '/reports', query }).success).toBe(true)
    expect(SavedViewSchema.safeParse({ pathname: '/reports', query: { ...query, false_temporal_key: 'yes' } }).success).toBe(false)
  })

  it.each(['results', 'attention'] as const)('restores the ad daily selection across the %s metric group', initialGroup => {
    navigation.search = 'ad_trend=purchase_value&ad_trend_period=previous'
    const data = businessReportingFixture(), meta = data.meta.data!
    const entity = meta.entities.find(row => row.level === 'ad')!
    const html = renderToStaticMarkup(<AdDetail entity={entity} context={data.context} meta={meta} initialGroup={initialGroup} />)
    expect(html).toContain('value="purchase_value" selected')
    expect(html).toContain('value="previous" selected')
  })

  it('exports the exact ad daily observations in both periods from the ad reading path', () => {
    const data = businessReportingFixture(), entity = data.meta.data!.entities.find(row => row.level === 'ad')!
    const make = (date: string, value: number) => ({ date, metrics: { spend: makeReportMetric({
      context: { ...data.context, range: { from: date, to: date } }, key: 'spend', label: 'Spend', current: value, previous: undefined,
      source: 'meta', unit: 'money', entity: { level: 'ad', id: entity.id }, definition: 'Native ad-day spend.',
      coverage: { state: 'complete', numerator: 1, denominator: 1 }, basis: 'impression_date_et' }) } })
    const ad = { ...entity, series: [make('2026-09-02', 14)], comparisonSeries: [make('2026-08-30', 8)] }
    const html = renderToStaticMarkup(<AdDetail entity={ad} context={data.context} meta={data.meta.data!} />)
    expect(html).toContain('Export ad daily CSV')
    const rows = temporal.adDailyExportRows?.(ad, data.context) ?? []
    expect(rows.map(row => [row.from, row.to, row.value])).toEqual([['2026-09-02', '2026-09-02', 14], ['2026-08-30', '2026-08-30', 8]])
    expect(rows.every(row => row.entity.includes(ad.id))).toBe(true)
  })

  it('retains a selected daily-only ad metric when the period summary and current group omit it', () => {
    navigation.search = 'ad_trend=purchase_value&ad_trend_period=previous'
    const data = businessReportingFixture(), meta = data.meta.data!, original = meta.entities.find(row => row.level === 'ad')!
    const ad = { ...original, metrics: {}, series: [], comparisonSeries: [day('2026-08-30', 80, 'meta', 'purchase_value')] }
    const html = renderToStaticMarkup(<AdDetail entity={ad} context={data.context} meta={meta} initialGroup="attention" />)
    expect(html).toContain('value="purchase_value" selected')
    expect(html).toContain('$80.00')
  })

  it('includes Meta current and prior day evidence in the full results export', () => {
    const data = businessReportingFixture()
    data.meta.data!.series = [day('2026-09-02', 1.25, 'meta', 'purchase_roas')]
    data.meta.data!.comparisonSeries = [day('2026-08-30', 2.5, 'meta', 'purchase_roas')]
    const rows = collectReportExportRows(data, 'results')
    expect(rows.some(row => row.source === 'meta' && row.from === '2026-09-02' && row.to === '2026-09-02' && row.value === 1.25)).toBe(true)
    expect(rows.some(row => row.source === 'meta' && row.from === '2026-08-30' && row.to === '2026-08-30' && row.value === 2.5)).toBe(true)
  })
})
