import type { ReportMetric } from './contracts'

/** Movement, not a recommendation: only compare the metric's declared equal-period population. */
export function overviewComparison(metric?: ReportMetric): string | null {
  const a = metric?.current, b = metric?.previous
  if (!a || !b || a.comparison.method !== 'prior_equal_period' || !a.comparison.window
    || [a, b].some(claim => claim.availability.state !== 'available' || claim.coverage.state !== 'complete'
      || claim.maturity.state === 'partial' || typeof claim.value !== 'number' || !Number.isFinite(claim.value))
    || a.metricKey !== b.metricKey || a.unit !== b.unit || a.attributionScope !== b.attributionScope
    || a.formula !== b.formula || a.definitionVersion !== b.definitionVersion
    || a.entity.id !== b.entity.id || a.entity.level !== b.entity.level
    || a.source.system !== b.source.system || a.source.role !== b.source.role || a.source.evidencePlane !== b.source.evidencePlane
    || a.window.basis !== b.window.basis || a.window.timezone !== b.window.timezone
    || (['start', 'end', 'basis', 'timezone'] as const).some(key => a.comparison.window![key] !== b.window[key])) return null
  const change = (a.value as number) - (b.value as number)
  if (change === 0) return 'No change'
  if (b.value === 0) return 'No prior baseline'
  const amount = Math.abs(a.unit === 'percent' ? change : change / (b.value as number) * 100)
  if (!Number.isFinite(amount)) return null
  const value = amount < .1 ? '<0.1' : amount.toLocaleString('en-US', { maximumFractionDigits: 1 })
  return `${change > 0 ? '↑' : '↓'} ${value}${a.unit === 'percent' ? ' pp' : '%'}`
}
