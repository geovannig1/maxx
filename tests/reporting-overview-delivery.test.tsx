import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { OverviewDelivery } from '@/components/reporting/OverviewDelivery'
import { referenceReportingFixture } from './reporting-browser/reference-fixture'

describe('account delivery evidence boundaries', () => {
  it('reads native account reach while preserving arithmetic in the populated preview', () => {
    const data = referenceReportingFixture()
    expect(data.business.data.metrics.booked_value.current.value).toBe(500)
    expect(data.business.data.metrics.paid_bookings.current.value).toBe(5)
    expect(data.business.data.metrics.recorded_booked_hours.current.value).toBe(9)
    expect(data.meta.data.metrics.spend.current.value).toBe(120)
    const html = renderToStaticMarkup(<OverviewDelivery data={data} />)
    expect(html).toContain('Reach: 9,000.')
    expect(html).toContain('CPM: $6.28.')
  })
  it.each(['account', 'window', 'source', 'key', 'future', 'observed_clock', 'negative', 'nonfinite'] as const)
    ('does not render a plausible reach from a conflicting %s claim', problem => {
      const data = referenceReportingFixture(), reach = data.meta.data.metrics.reach
      const original = reach.current
      const edited = { ...data, meta: { ...data.meta, data: { ...data.meta.data, metrics: { ...data.meta.data.metrics,
        reach: { ...reach, current: { ...original,
          entity: problem === 'account' ? { ...original.entity, id: 'other' } : original.entity,
          window: problem === 'window' ? { ...original.window, start: '2020-01-01' } : original.window,
          source: problem === 'source' ? { ...original.source, role: 'business_truth' as const } : original.source,
          metricKey: problem === 'key' ? 'meta.impressions' : original.metricKey,
          asOf: problem === 'future' ? '2099-01-01T00:00:00Z' : original.asOf,
          freshness: problem === 'observed_clock' ? { ...original.freshness, observedAt: '2020-01-01T00:00:00Z' } : original.freshness,
          value: problem === 'negative' ? -9000 : problem === 'nonfinite' ? Infinity : original.value,
        } },
      } } } }
      const html = renderToStaticMarkup(<OverviewDelivery data={edited} />)
      expect(html).toContain('Reach: Unavailable.')
      expect(html).toContain('Impressions: 19,100.')
    })
  it('withholds a foreign prior comparison while keeping the current account total', () => {
    const data = referenceReportingFixture(), reach = data.meta.data.metrics.reach
    const edited = { ...data, meta: { ...data.meta, data: { ...data.meta.data, metrics: { ...data.meta.data.metrics,
      reach: { ...reach, previous: { ...reach.previous!, metricKey: 'meta.impressions', value: 123456789 } },
    } } } }
    const html = renderToStaticMarkup(<OverviewDelivery data={edited} />)
    expect(html).toContain('Reach: 9,000.')
    expect(html).not.toContain('123,456,789')
  })
  it('keeps qualified stale and partial observations visible instead of turning them into zero', () => {
    const data = referenceReportingFixture(), reach = data.meta.data.metrics.reach
    const edited = { ...data, meta: { ...data.meta, data: { ...data.meta.data, metrics: { ...data.meta.data.metrics,
      reach: { ...reach, current: { ...reach.current,
        freshness: { ...reach.current.freshness, state: 'stale' as const },
        coverage: { state: 'partial' as const, numerator: 1, denominator: 2 },
      } },
    } } } }
    const html = renderToStaticMarkup(<OverviewDelivery data={edited} />)
    expect(html).toContain('Reach: 9,000.')
    expect(html).toContain('Partial · Stale')
  })
})
