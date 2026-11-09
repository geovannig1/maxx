import './_support/outcome-noun-booking'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { OverviewTrends } from '@/components/reporting/OverviewTrends'
import { overviewMerBins, overviewTrendBins } from '@/lib/reporting/overview-trends'
import { makeReportMetric, COMPLETE_FIELD_COVERAGE } from '@/lib/reporting/claims'
import type { ReportMetric, ReportSeriesPoint, ReportingContext, ReportingData } from '@/lib/reporting/contracts'

const context: ReportingContext = {
  account: { id: 'studio-db', metaAccountId: 'act_123', name: 'Studio' },
  range: { from: '2026-09-02', to: '2026-09-04' }, comparison: { from: '2026-08-30', to: '2026-09-01' },
  timezone: 'America/New_York', currency: 'USD', asOf: '2026-09-05T16:00:00Z',
}
const longContext: ReportingContext = { ...context,
  range: { from: '2026-08-01', to: '2026-09-01' }, comparison: { from: '2026-06-30', to: '2026-07-31' } }
type Kind = 'business' | 'meta'

function point(date: string, value: number, kind: Kind = 'meta'): ReportSeriesPoint {
  const key = kind === 'business' ? 'booked_value' : 'spend'
  return { date, metrics: { [key]: makeReportMetric({ context: { ...context, range: { from: date, to: date } },
    key, label: kind === 'business' ? 'Booked value' : 'Spend', current: value, source: kind === 'business' ? 'outcomes' : 'meta',
    definition: 'Independent complete native daily dollars.', unit: 'money', coverage: COMPLETE_FIELD_COVERAGE,
    basis: kind === 'business' ? 'booking_created_date_et' : 'impression_date_et',
    sourceHead: 'source-snapshot', freshness: { state: 'fresh', observedAt: context.asOf, maxAgeHours: 24 },
    entity: { level: kind === 'business' ? 'business' : 'account', id: kind === 'business' ? `${context.account.id}:day:${date}` : context.account.id },
  }) } }
}
function series(from: string, count: number, value: number, kind: Kind = 'meta') {
  return Array.from({ length: count }, (_, i) => point(new Date(Date.parse(`${from}T00:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10), value, kind))
}
function changeMetric(row: ReportSeriesPoint, edit: (metric: ReportMetric) => ReportMetric) {
  const key = Object.keys(row.metrics)[0]
  return { ...row, metrics: { [key]: edit(row.metrics[key]) } }
}
function data(): ReportingData {
  return { context, business: { state: 'available', asOf: '2026-09-05T14:00:00Z', notes: [], data: {
    metrics: {}, series: series(context.range.from, 3, 1000, 'business'), comparisonSeries: series(context.comparison.from, 3, 500, 'business'),
    types: [], sourceDescription: 'Native Acuity daily test evidence',
  } }, meta: { state: 'available', asOf: '2026-09-05T15:00:00Z', notes: [], data: {
    metrics: {}, series: series(context.range.from, 3, 20), comparisonSeries: series(context.comparison.from, 3, 10),
    entities: [], breakdowns: [], observations: [], detailState: 'complete', attributionWindow: '7-day click / 1-day view',
    reportingTime: 'Impression date', sourceDescription: 'Native Meta daily test evidence',
  } }, website: { state: 'unavailable', asOf: null, data: null, notes: [] } }
}

describe('overview additive dollar bins', () => {
  it('keeps true zero and independent prior dates while missing days remain gaps', () => {
    const rows = overviewTrendBins(context, [point('2026-09-02', 0), point('2026-09-04', 25)], [point('2026-08-30', 8)], 'meta')
    expect(rows.map(row => row.current.value)).toEqual([0, null, 25])
    expect(rows[0]).toMatchObject({ label: '2026-09-02', priorLabel: '2026-08-30', days: 1, prior: { value: 8 } })
    expect(rows[1].prior.value).toBeNull()
  })
  it('uses daily columns through 31 days and sums only dollars in longer aligned 7-day bins', () => {
    expect(overviewTrendBins({ ...longContext, range: { from: '2026-08-01', to: '2026-08-31' } }, [], [], 'meta')).toHaveLength(31)
    const rows = overviewTrendBins(longContext, series('2026-08-01', 32, 10), series('2026-06-30', 32, 2), 'meta')
    expect(rows.map(row => row.current.value)).toEqual([70, 70, 70, 70, 40])
    expect(rows.map(row => row.prior.value)).toEqual([14, 14, 14, 14, 8])
    expect(rows[4]).toMatchObject({ label: '2026-08-29 – 2026-09-01', priorLabel: '2026-07-28 – 2026-07-31', days: 4, short: true })
  })
  it('accepts native Acuity day identities without substituting Meta values', () => {
    const rows = overviewTrendBins(longContext, series('2026-08-01', 32, 100, 'business'), [], 'business')
    expect(rows[0].current.value).toBe(700)
    expect(overviewTrendBins(context, [point(context.range.from, 20)], [], 'business')[0].current.value).toBeNull()
  })
  it.each(['missing', 'duplicate', 'day', 'timezone', 'unit', 'source', 'head', 'asOf', 'basis', 'entity', 'coverage', 'partial_day', 'unavailable', 'nonfinite'] as const)
    ('leaves a whole bin empty on %s conflict while the next bin remains usable', mismatch => {
      const original = series('2026-08-01', 32, 10)
      const altered = changeMetric(original[2], metric => ({ ...metric, current: { ...metric.current,
        unit: mismatch === 'unit' ? 'count' : metric.current.unit,
        value: mismatch === 'nonfinite' ? Infinity : metric.current.value,
        source: { ...metric.current.source, system: mismatch === 'source' ? 'ga4' : metric.current.source.system,
          head: mismatch === 'head' ? 'another-snapshot' : metric.current.source.head },
        asOf: mismatch === 'asOf' ? '2026-09-05T13:00:00Z' : metric.current.asOf,
        window: { ...metric.current.window, start: mismatch === 'day' ? '2026-08-02' : metric.current.window.start,
          // Deliberately malformed external evidence must be rejected at runtime.
          timezone: mismatch === 'timezone' ? 'UTC' as unknown as ReportMetric['current']['window']['timezone'] : metric.current.window.timezone,
          basis: mismatch === 'basis' ? 'booking_created_date_et' : metric.current.window.basis },
        entity: { ...metric.current.entity, id: mismatch === 'entity' ? 'another-account' : metric.current.entity.id },
        coverage: mismatch === 'coverage' ? { state: 'partial', numerator: 1, denominator: 2 } : metric.current.coverage,
        maturity: mismatch === 'partial_day' ? { state: 'partial', matureThrough: null } : metric.current.maturity,
        availability: mismatch === 'unavailable' ? { state: 'unavailable', blockerCodes: ['missing'] } : metric.current.availability,
      } }))
      const points = mismatch === 'missing' ? original.filter((_, i) => i !== 2)
        : mismatch === 'duplicate' ? [...original, original[2]] : original.map((row, i) => i === 2 ? altered : row)
      const rows = overviewTrendBins(longContext, points, series('2026-06-30', 32, 3), 'meta')
      expect(rows[0].current.value).toBeNull()
      expect(rows[0].prior.value).toBe(21)
      expect(rows[1].current.value).toBe(70)
    })
  it('does not use a daily claim’s embedded prior aggregate to fill absent prior days', () => {
    const current = changeMetric(point('2026-09-02', 20), metric => ({ ...metric, previous: { ...metric.current, value: 999 } }))
    expect(overviewTrendBins(context, [current], [], 'meta')[0].prior.value).toBeNull()
  })
})

describe('aligned interval MER', () => {
  it('derives daily values from exact compatible bins and keeps zero spend undefined', () => {
    const business = overviewTrendBins(context,
      [point('2026-09-02', 100, 'business'), point('2026-09-03', 0, 'business'), point('2026-09-04', 60, 'business')], [], 'business')
    const spend = overviewTrendBins(context,
      [point('2026-09-02', 20), point('2026-09-03', 0), point('2026-09-04', 30)], [], 'meta')
    expect(overviewMerBins(business, spend)).toEqual([
      expect.objectContaining({ label: '2026-09-02', state: 'available', value: 5 }),
      expect.objectContaining({ label: '2026-09-03', state: 'zero_spend', value: null }),
      expect.objectContaining({ label: '2026-09-04', state: 'available', value: 2 }),
    ])
  })

  it('uses interval sums and withholds missing, stale, and incompatible comparisons', () => {
    const businessPoints = series('2026-08-01', 32, 100, 'business').map((row, index) => index < 7
      ? changeMetric(row, metric => ({ ...metric, current: { ...metric.current, value: index === 0 ? 100 : 0 } })) : row)
    const spendPoints = series('2026-08-01', 32, 20).map((row, index) => index < 7
      ? changeMetric(row, metric => ({ ...metric, current: { ...metric.current, value: index === 0 ? 10 : index === 1 ? 90 : 0 } })) : row)
    const business = overviewTrendBins(longContext, businessPoints, [], 'business')
    const spend = overviewTrendBins(longContext, spendPoints, [], 'meta')
    expect(overviewMerBins(business, spend).map(row => row.value)).toEqual([1, 5, 5, 5, 5])
    expect(overviewMerBins(business, spend).at(-1)).toMatchObject({ days: 4, short: true, state: 'available' })

    const missing = overviewTrendBins(longContext, businessPoints.filter((_, index) => index !== 2), [], 'business')
    expect(overviewMerBins(missing, spend)[0]).toMatchObject({ state: 'unavailable', value: null })
    const missingSpend = overviewTrendBins(longContext, spendPoints.filter((_, index) => index !== 2), [], 'meta')
    expect(overviewMerBins(business, missingSpend)[0]).toMatchObject({ state: 'unavailable', value: null })
    const stale = overviewTrendBins(longContext, businessPoints.map((row, index) => index === 2
      ? changeMetric(row, metric => ({ ...metric, current: { ...metric.current, freshness: { ...metric.current.freshness, state: 'stale' } } })) : row), [], 'business')
    expect(overviewMerBins(stale, spend)[0]).toMatchObject({ state: 'unavailable', value: null })
    expect(overviewMerBins(business, [{ ...spend[0], end: '2026-08-06' }, ...spend.slice(1)])[0])
      .toMatchObject({ state: 'unavailable', value: null })
  })

  it.each([
    ['business', 'role'], ['business', 'plane'], ['meta', 'role'], ['meta', 'plane'],
  ] as const)('rejects a %s daily claim with the wrong source %s from its chart and MER', (kind, defect) => {
    const bad = changeMetric(point(context.range.from, kind === 'business' ? 100 : 20, kind), metric => ({ ...metric,
      current: { ...metric.current, source: { ...metric.current.source,
        role: defect === 'role' ? 'measurement_qa' : metric.current.source.role,
        evidencePlane: defect === 'plane' ? 'ga4_telemetry' : metric.current.source.evidencePlane,
      } },
    }))
    const business = overviewTrendBins(context, [kind === 'business' ? bad : point(context.range.from, 100, 'business')], [], 'business')
    const spend = overviewTrendBins(context, [kind === 'meta' ? bad : point(context.range.from, 20)], [], 'meta')
    expect((kind === 'business' ? business : spend)[0].current.value).toBeNull()
    expect(overviewMerBins(business, spend)[0]).toMatchObject({ state: 'unavailable', value: null })
  })
})

describe('OverviewTrends', () => {
  it('labels the scales with the account currency, never a fixed USD', () => {
    vi.stubEnv('NEXT_PUBLIC_ACCOUNT_CURRENCY', 'EUR')
    try {
      const html = renderToStaticMarkup(<OverviewTrends data={data()} savedId="saved-snapshot" />)
      expect(html).toContain('Booked value scale (EUR)')
      expect(html).toContain('Ad spend scale (EUR)')
      expect(html).not.toContain('(USD)')
      expect(html).not.toMatch(/· USD ·/)
    } finally { vi.unstubAllEnvs() }
  })

  it('renders separate dollar scales, patterned prior columns, keyboard points and calendar-date tables', () => {
    const html = renderToStaticMarkup(<OverviewTrends data={data()} savedId="saved-snapshot" />)
    expect(html).toContain('Results over time')
    expect(html).toContain('Bookings · All sources · Booking dates')
    expect(html).toContain('Meta · Reporting / impression dates')
    expect(html.match(/data-overview-chart=/g)).toHaveLength(2)
    expect(html).toContain('Booked value scale (USD)')
    expect(html).toContain('Ad spend scale (USD)')
    expect(html).toContain('data-series="current"')
    expect(html).toContain('data-series="prior"')
    expect(html).toContain('<pattern')
    expect(html).toContain('tabindex="0"')
    expect(html).toContain('2026-08-30')
    expect(html).toContain('$1,000.00')
    expect(html).toContain('$20.00')
    expect(html).toContain('Daily MER')
    expect(html).toContain('50.00×')
    expect(html).toContain('MER values by aligned interval')
    expect(html).toContain('Inspect chart values')
    expect(html).toContain('scope="col"')
    expect(html).toContain('2026-09-05T14:00:00Z')
    expect(html).toContain('2026-09-05T15:00:00Z')
    for (const path of ['/reports', '/performance']) expect(html).toContain(`${path}?account=studio-db&amp;from=2026-09-02&amp;to=2026-09-04&amp;saved=saved-snapshot`)
  })
  it('keeps loading local to Meta and preserves the Acuity chart', () => {
    const original = data()
    const html = renderToStaticMarkup(<OverviewTrends data={{ ...original, meta: { ...original.meta,
      data: { ...original.meta.data!, detailState: 'loading', series: [], comparisonSeries: [] } } }} />)
    expect(html).toContain('Loading Meta daily evidence')
    expect(html).toContain('data-overview-chart="business"')
    expect(html).not.toContain('Meta daily evidence unavailable')
  })
  it('reports a missing bin as partial coverage and distinguishes observed zero from gaps', () => {
    const original = data()
    const html = renderToStaticMarkup(<OverviewTrends data={{ ...original, meta: { ...original.meta,
      data: { ...original.meta.data!, series: [point(context.range.from, 0)] } } }} />)
    expect(html).toContain('Partial daily coverage')
    expect(html).toContain('data-value="0"')
    expect(html).toContain('Unavailable')
    expect(html).toContain('$0.00')
    expect(html).toContain('Zero spend · MER unavailable')
  })
  it('keeps an unavailable source local and explicitly labels the shorter final bin', () => {
    const original = data()
    const html = renderToStaticMarkup(<OverviewTrends data={{ ...original, context: longContext,
      business: { state: 'unavailable', data: null, asOf: null, notes: [] },
      meta: { ...original.meta, data: { ...original.meta.data!, series: series('2026-08-01', 32, 10), comparisonSeries: [] } } }} />)
    expect(html).toContain('Bookings daily evidence unavailable')
    expect(html).toContain('7-day bins')
    expect(html).toContain('Final bin: 4 days')
    expect(html).toContain('$40.00')
    expect(html).toContain('Interval MER')
  })
})
