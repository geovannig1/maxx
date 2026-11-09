import { outcomeWords } from '@/config/outcome-nouns'

// What this business calls its outcomes (NEXT_PUBLIC_OUTCOME_NOUN).
const OW = outcomeWords()
const UNAVAILABLE_REASON =
  `CPA trajectory is unavailable: the legacy forecast uses Meta-modelled daily ${OW.many} rather than exact unit-scoped paid outcomes, ` +
  `and omits zero-${OW.one} days from the fitted series. That contract cannot support a money forecast or action.`

/**
 * Fail closed until the warehouse has exact, unit-scoped paid outcomes for a complete time series.
 * The legacy predictor remains available to historical tests but is not exposed as current authority.
 */
export async function getTrajectoryForecast(args: { window_days?: number }): Promise<object> {
  void args
  return {
    status: 'unavailable',
    action_authority_tier: 'diagnostic_only',
    prescriptions: [],
    trajectories: [],
    unavailable_reason: UNAVAILABLE_REASON,
  }
}
