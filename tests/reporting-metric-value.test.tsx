import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { ReportMetricValue, reportMetricValue } from '@/components/reporting/MetricValue'
import { makeReportMetric, COMPLETE_FIELD_COVERAGE } from '@/lib/reporting/claims'

const context = { account: { id: 'db', metaAccountId: 'act_1', name: 'Studio' },
  range: { from: '2026-09-02', to: '2026-09-04' }, comparison: { from: '2026-08-30', to: '2026-09-01' },
  timezone: 'America/New_York' as const, currency: 'USD' as const, asOf: '2026-09-05T17:00:00Z' }
const metric = makeReportMetric({ context, key: 'purchase_roas', label: 'Meta Purchase ROAS',
  definition: 'Canonical Purchase value divided by matching spend.', event: 'Purchase',
  source: 'meta', unit: 'ratio', current: 0, previous: 2,
  coverage: COMPLETE_FIELD_COVERAGE, previousCoverage: COMPLETE_FIELD_COVERAGE })

describe('visible metric evidence', () => {
  it('distinguishes measured zero, missing and previous values', () => {
    expect(reportMetricValue(metric)).toBe('0.00×')
    expect(reportMetricValue(metric, true)).toBe('2.00×')
    expect(reportMetricValue(undefined)).toBe('Unavailable')
  })
  it('renders event identity, source, dates and definition through an accessible disclosure', () => {
    const html = renderToStaticMarkup(<ReportMetricValue metric={metric} comparison />)
    expect(html).toContain('<details')
    expect(html).toContain('<summary')
    expect(html).toContain('Purchase')
    expect(html).toContain('2026-09-02')
    expect(html).toContain('2026-08-30')
    expect(html).toContain('Canonical Purchase value')
    expect(html).toContain('Meta Ads Manager')
    expect(html).not.toContain('booking ROAS')
  })
  it('keeps partial and stale qualifications visible while evidence details are closed', () => {
    const partial = makeReportMetric({ context, key: 'paid_bookings', label: 'Paid bookings', source: 'outcomes',
      definition: 'Observed active records with positive payment.', unit: 'count', current: 2,
      coverage: { state: 'partial', numerator: 2, denominator: 4 }, freshness: { state: 'stale', observedAt: context.asOf, maxAgeHours: 1 } })
    for (const compact of [true, false]) {
      const visible = renderToStaticMarkup(<ReportMetricValue metric={partial} compact={compact} />).replace(/<details[\s\S]*?<\/details>/g, '')
      expect(visible).toContain('Partial evidence')
      expect(visible).toContain('Stale evidence')
    }
  })
})
