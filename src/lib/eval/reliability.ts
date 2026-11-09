export interface ReliabilitySummary {
  k: number
  total: number
  passedAtLeastOnce: number
  passedEveryTrial: number
  passAtKRate: number
  passToKRate: number
}

/** Summarize pass@k and pass^k without treating a missing trial as a pass. */
export function summarizeReliability(scenarios: readonly (readonly boolean[])[]): ReliabilitySummary {
  if (scenarios.length === 0) throw new Error('At least one evaluation scenario is required.')
  const k = scenarios[0]?.length ?? 0
  if (k === 0) throw new Error('Every evaluation scenario requires at least one trial.')
  if (scenarios.some((trials) => trials.length !== k)) {
    throw new Error('Every evaluation scenario must use the same number of trials.')
  }
  const passedAtLeastOnce = scenarios.filter((trials) => trials.some(Boolean)).length
  const passedEveryTrial = scenarios.filter((trials) => trials.every(Boolean)).length
  return {
    k,
    total: scenarios.length,
    passedAtLeastOnce,
    passedEveryTrial,
    passAtKRate: passedAtLeastOnce / scenarios.length,
    passToKRate: passedEveryTrial / scenarios.length,
  }
}
