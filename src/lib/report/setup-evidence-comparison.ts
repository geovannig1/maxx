import type { SetupAdsetEvidence, SetupEvidenceBlockerCode } from './setup-evidence-types'

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).sort().join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${canonical(nested)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

/** A Cold/Warm label is clean only when the two cells differ by audience role, not by measurement,
 * optimization, bidding, placement, or an unobserved targeting-relaxation plane. */
export function coldWarmConfigurationBlockers(
  rows: SetupAdsetEvidence[],
): SetupEvidenceBlockerCode[] {
  if (rows.length !== 2) return []
  const [left, right] = rows
  const blockers: SetupEvidenceBlockerCode[] = []
  if (rows.some((row) => !row.objective)) blockers.push('objective_unknown')
  else if (left.objective !== right.objective) blockers.push('comparison_objective_mismatch')
  if (rows.some((row) => !row.optimization_event)) blockers.push('optimization_event_unknown')
  else if (left.optimization_event !== right.optimization_event) {
    blockers.push('comparison_optimization_event_mismatch')
  }
  if (left.optimization_goal !== right.optimization_goal) {
    blockers.push('comparison_optimization_goal_mismatch')
  }
  if (rows.some((row) => row.attribution_spec === null)) blockers.push('attribution_unknown')
  else if (canonical(left.attribution_spec) !== canonical(right.attribution_spec)) {
    blockers.push('comparison_attribution_mismatch')
  }
  if (rows.some((row) => !row.bid.strategy)) blockers.push('bid_strategy_unknown')
  else if (canonical(left.bid) !== canonical(right.bid)) blockers.push('comparison_bid_mismatch')
  if (rows.some((row) => row.placements.mode === 'unknown')) blockers.push('placements_unknown')
  else if (canonical(left.placements) !== canonical(right.placements)) {
    blockers.push('comparison_placements_mismatch')
  }
  const relaxations = rows.map((row) => row.advantage_plus.observed_targeting_relaxations)
  if (relaxations.some((value) => value === null)) blockers.push('targeting_relaxations_unknown')
  else if (canonical(relaxations[0]) !== canonical(relaxations[1])) {
    blockers.push('comparison_targeting_relaxations_mismatch')
  }
  return [...new Set(blockers)].sort()
}
