import type { ReviewFinding } from './contracts'

export const PERFORMANCE_SIGNALS = {
  all: 'All performance assessments', zero_outcome: 'Spend with an event at zero',
  declined: 'Observed declines', mixed: 'Mixed observed changes', improved: 'Observed improvements',
} as const
export type PerformanceSignal = keyof typeof PERFORMANCE_SIGNALS
export const PERFORMANCE_LEVELS = { campaign: 'Campaigns', adset: 'Ad sets', ad: 'Ads' } as const
export type PerformanceLevel = keyof typeof PERFORMANCE_LEVELS

/** Select original prepared assessments; never reinterpret metrics or saved evidence here. */
export function matchesPerformanceSignal(finding: ReviewFinding, signal: string | null): boolean {
  if (!signal) return true
  if (!Object.hasOwn(PERFORMANCE_SIGNALS, signal) || !finding.entity
    || !Object.hasOwn(PERFORMANCE_LEVELS, finding.entity.level) || finding.area !== 'advertising'
    || finding.id !== `performance:${finding.entity.level}:${finding.entity.id}`) return false
  if (signal === 'all') return true
  if (finding.status === 'unavailable') return false
  return signal === 'zero_outcome' ? finding.zeroOutcomeSpend === true : finding.direction === signal
}

export function performanceGroups(findings: readonly ReviewFinding[]) {
  return (Object.keys(PERFORMANCE_LEVELS) as PerformanceLevel[]).map(level => {
    const members = findings.filter(finding => finding.entity?.level === level && matchesPerformanceSignal(finding, 'all'))
    const counts = Object.fromEntries((Object.keys(PERFORMANCE_SIGNALS) as PerformanceSignal[])
      .map(signal => [signal, members.filter(finding => matchesPerformanceSignal(finding, signal)).length])) as Record<PerformanceSignal, number>
    return { level, counts }
  })
}
