import { describe, it, expect } from 'vitest'
import { compareUnknownLast, metricSortValue, sumMeasured } from '@/lib/metrics/collation'

/**
 * These pin the distinction between "measured zero" and "unknown" in entity tables.
 * Before this, all four performance pages read metrics with `?? 0`, which made the two
 * indistinguishable.
 */

interface Row {
  name: string
  metrics: { spend: number; cpa: number | null } | null
}

const rows: Row[] = [
  { name: 'measured-cheap', metrics: { spend: 100, cpa: 20 } },
  { name: 'measured-zero-cpa', metrics: { spend: 50, cpa: 0 } },
  { name: 'unknown-cpa', metrics: { spend: 75, cpa: null } },
  { name: 'no-metrics-row', metrics: null },
]

const byCpa = (dir: 'asc' | 'desc') =>
  [...rows]
    .sort((a, b) =>
      compareUnknownLast(metricSortValue(a.metrics, 'cpa'), metricSortValue(b.metrics, 'cpa'), dir),
    )
    .map(r => r.name)

describe('metricSortValue', () => {
  it('reads a measured zero as 0, not as unknown', () => {
    expect(metricSortValue({ cpa: 0 }, 'cpa')).toBe(0)
  })

  it('reads a null column as unknown, not as 0', () => {
    expect(metricSortValue({ cpa: null }, 'cpa')).toBeNull()
  })

  it('reads an absent metrics object as unknown, not as 0', () => {
    expect(metricSortValue(null, 'cpa')).toBeNull()
    expect(metricSortValue(undefined, 'cpa')).toBeNull()
  })

  it('reads a missing key as unknown', () => {
    expect(metricSortValue({ spend: 10 }, 'cpa')).toBeNull()
  })
})

describe('compareUnknownLast', () => {
  it('never ranks an unknown CPA as the cheapest', () => {
    // The regression: with `?? 0`, both unknown rows collated as 0 and led an ascending sort.
    const asc = byCpa('asc')
    expect(asc[0]).toBe('measured-zero-cpa')
    expect(asc.slice(0, 2)).toEqual(['measured-zero-cpa', 'measured-cheap'])
    expect(asc.slice(2).sort()).toEqual(['no-metrics-row', 'unknown-cpa'])
  })

  it('keeps unknowns last in BOTH directions, so toggling never promotes them', () => {
    expect(byCpa('asc').slice(2).sort()).toEqual(['no-metrics-row', 'unknown-cpa'])
    expect(byCpa('desc').slice(2).sort()).toEqual(['no-metrics-row', 'unknown-cpa'])
  })

  it('orders known values normally within each direction', () => {
    expect(byCpa('desc').slice(0, 2)).toEqual(['measured-cheap', 'measured-zero-cpa'])
  })
})

describe('sumMeasured', () => {
  it('does not add a zero for rows carrying no metrics', () => {
    const result = sumMeasured(rows, r => r.metrics, 'spend')
    expect(result.total).toBe(225) // 100 + 50 + 75 — the row with no metrics contributes nothing
    expect(result.unmeasured).toBe(1)
  })

  it('counts a null column as unmeasured rather than summing it as 0', () => {
    const result = sumMeasured(rows, r => r.metrics, 'cpa')
    expect(result.total).toBe(20) // only the one measured non-zero cpa, plus the measured 0
    expect(result.unmeasured).toBe(2) // null cpa + absent metrics row
  })

  it('reports zero unmeasured when every row is complete', () => {
    const complete = rows.slice(0, 2)
    expect(sumMeasured(complete, r => r.metrics, 'spend')).toEqual({ total: 150, unmeasured: 0 })
  })
})
