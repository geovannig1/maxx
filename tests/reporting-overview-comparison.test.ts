import { describe, expect, it } from 'vitest'
import { overviewComparison } from '@/lib/reporting/overview-comparison'
import { executiveFixture } from './reporting-browser/executive-fixture'

function metric(current = 120, previous = 100) {
  const original = executiveFixture().business.data!.metrics.booked_value
  return { ...original, current: { ...original.current, value: current }, previous: { ...original.previous!, value: previous } }
}
describe('executive comparison presentation', () => {
  it('shows movement without assigning business desirability', () => {
    expect(overviewComparison(metric())).toBe('↑ 20%')
    expect(overviewComparison(metric(80))).toBe('↓ 20%')
    expect(overviewComparison(metric(100))).toBe('No change')
  })
  it('distinguishes a zero baseline from no change and does not round tiny movement to zero', () => {
    expect(overviewComparison(metric(10, 0))).toBe('No prior baseline')
    expect(overviewComparison(metric(0, 0))).toBe('No change')
    expect(overviewComparison(metric(100.01))).toBe('↑ <0.1%')
  })
  it('rejects formula drift and an overflowing derived change', () => {
    const input = metric()
    expect(overviewComparison({ ...input, previous: { ...input.previous, formula: 'A different denominator' } })).toBeNull()
    expect(overviewComparison(metric(Number.MAX_VALUE, Number.MIN_VALUE))).toBeNull()
  })
  it.each(['missing', 'coverage', 'entity', 'window', 'unit', 'basis', 'source', 'partial'] as const)('withholds a computed comparison for %s evidence', kind => {
    const input = metric()
    const previous = input.previous
    const changed = { ...previous,
      availability: kind === 'missing' ? { state: 'unavailable' as const, blockerCodes: ['missing'] } : previous.availability,
      coverage: kind === 'coverage' ? { state: 'partial' as const, numerator: 1, denominator: 2 } : previous.coverage,
      entity: kind === 'entity' ? { ...previous.entity, id: 'different-entity' } : previous.entity,
      window: { ...previous.window, start: kind === 'window' ? '2026-01-01' : previous.window.start,
        basis: kind === 'basis' ? 'service_date_et' as const : previous.window.basis },
      unit: kind === 'unit' ? 'count' as const : previous.unit,
      source: kind === 'source' ? { ...previous.source, system: 'meta' as const } : previous.source,
      maturity: kind === 'partial' ? { state: 'partial' as const, matureThrough: null } : previous.maturity,
    }
    expect(overviewComparison({ ...input, previous: changed })).toBeNull()
  })
})
