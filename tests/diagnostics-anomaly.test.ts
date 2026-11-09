import { describe, it, expect } from 'vitest'
import { ratioDriver, rankMovers, explainMetricChange, summarizeAnomalies, type MetricChangeInput } from '@/lib/diagnostics/anomaly'

describe('ratioDriver — numerator vs denominator decomposition', () => {
  it('blames the denominator when leads fall and spend is flat (CPL spike)', () => {
    const rd = ratioDriver({ numerator: { label: 'spend', current: 1000, previous: 1000 }, denominator: { label: 'leads', current: 70, previous: 100 } })
    expect(rd).not.toBeNull()
    expect(rd!.driver).toBe('denominator')
    expect(rd!.denPct).toBeCloseTo(-30)
    // numerator + denominator effects sum to the total ΔCPL (14.29 − 10 = 4.29)
    expect(rd!.numEffect + rd!.denEffect).toBeCloseTo(1000 / 70 - 10, 4)
  })
  it('blames the numerator when spend rises and leads are flat', () => {
    const rd = ratioDriver({ numerator: { label: 'spend', current: 1400, previous: 1000 }, denominator: { label: 'leads', current: 100, previous: 100 } })
    expect(rd!.driver).toBe('numerator')
    expect(rd!.numPct).toBeCloseTo(40)
  })
})

describe('rankMovers — spend-weighted, ignores tiny-spend swings', () => {
  it('ranks a big-spend mover above a tiny-spend outlier and drops sub-floor entities', () => {
    const ranked = rankMovers([
      { id: 'a', name: 'Lookalike — Cold', spendShare: 0.4, metricCurrent: 18, metricPrevious: 11 },
      { id: 'b', name: 'Tiny Test', spendShare: 0.02, metricCurrent: 50, metricPrevious: 10 }, // 400% but 2% spend → dropped
      { id: 'c', name: 'Retargeting', spendShare: 0.3, metricCurrent: 12, metricPrevious: 11 },
    ])
    expect(ranked.map((m) => m.id)).toEqual(['a', 'c'])
    expect(ranked[0].deltaPct).toBeCloseTo(63.6, 0)
  })
})

describe('explainMetricChange', () => {
  const cplSpike: MetricChangeInput = {
    key: 'cpl', label: 'CPL', current: 1000 / 70, previous: 10, direction: 'lower_is_better', unit: '$',
    ratio: { numerator: { label: 'spend', current: 1000, previous: 1000 }, denominator: { label: 'leads', current: 70, previous: 100 } },
    entities: [{ id: 'a', name: 'Lookalike — Cold', spendShare: 0.4, metricCurrent: 18, metricPrevious: 11 }],
  }

  it('flags a worsened ratio as high severity with a driver + entity attribution', () => {
    const a = explainMetricChange(cplSpike)
    expect(a.direction).toBe('worsened')
    expect(a.severity).toBe('high')
    expect(a.driver).toMatch(/leads falling 30% \(denominator\)/i)
    expect(a.headline).toMatch(/CPL/)
    expect(a.headline).toMatch(/Lookalike — Cold/)
  })

  it('does NOT flag an improvement as an anomaly', () => {
    const a = explainMetricChange({ key: 'cpl', label: 'CPL', current: 8, previous: 10, direction: 'lower_is_better', unit: '$' })
    expect(a.direction).toBe('improved')
    expect(a.severity).toBe('none')
  })

  it('treats a CTR drop (higher-is-better) as worsened', () => {
    const a = explainMetricChange({ key: 'ctr', label: 'CTR', current: 1.0, previous: 2.0, direction: 'higher_is_better', unit: '%' })
    expect(a.direction).toBe('worsened')
    expect(a.severity).toBe('high')
  })

  it('attaches a trust score from supplied evidence', () => {
    const a = explainMetricChange({ ...cplSpike, trustCtx: { spend: 8, bookings: 0, windowDays: 1, dataAgeHours: null, revenueClaim: true } })
    expect(a.trust).not.toBeNull()
    expect(a.trust!.meetsBar).toBe(false) // thin data → the spike is low-trust, not asserted
  })
})

describe('summarizeAnomalies', () => {
  it('keeps only worsened metrics, worst first', () => {
    const out = summarizeAnomalies([
      { key: 'cpl', label: 'CPL', current: 14, previous: 10, direction: 'lower_is_better', unit: '$' }, // +40% high
      { key: 'cpc', label: 'CPC', current: 1.2, previous: 1.0, direction: 'lower_is_better', unit: '$' }, // +20% medium
      { key: 'roas', label: 'ROAS', current: 3, previous: 2, direction: 'higher_is_better', unit: 'x' }, // improved → dropped
    ])
    expect(out.map((a) => a.key)).toEqual(['cpl', 'cpc'])
  })
})

describe('ANOMALY_METRIC_SPECS (promoted from the anomalies route into anomaly.ts)', () => {
  it('covers the five efficiency metrics with consistent num/den decompositions', async () => {
    const { ANOMALY_METRIC_SPECS } = await import('@/lib/diagnostics/anomaly')
    const { emptyMetrics } = await import('@/lib/metrics/aggregate')
    expect(ANOMALY_METRIC_SPECS.map((s) => s.key)).toEqual(['cpl', 'cpa', 'cpc', 'cpm', 'ctr'])
    const m = emptyMetrics()
    for (const s of ANOMALY_METRIC_SPECS) {
      expect(s.pick(m)).toBeNull() // no data → null value, never 0
      expect(typeof s.num.pick(m)).toBe('number')
      expect(typeof s.den.pick(m)).toBe('number')
    }
    // only the booking-cost metric makes a revenue-adjacent claim
    expect(ANOMALY_METRIC_SPECS.filter((s) => s.revenueClaim).map((s) => s.key)).toEqual(['cpa'])
  })
})
