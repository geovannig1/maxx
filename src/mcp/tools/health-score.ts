import { outcomeWords } from '@/config/outcome-nouns'

// What this business calls its outcomes (NEXT_PUBLIC_OUTCOME_NOUN).
const OW = outcomeWords()
const UNAVAILABLE_REASON =
  `Creative health scores are unavailable for action use: the persisted legacy score includes a CPA component derived from Meta-modelled ${OW.many}. ` +
  'Without exact unit-scoped paid outcomes, a ranked grade could be mistaken for money or immediate-action authority.'

/** Fail closed instead of returning a legacy composite as a current scale/kill signal. */
export async function getCreativeHealthScores(args: {
  min_spend?: number
  limit?: number
}): Promise<object> {
  void args
  return {
    status: 'unavailable',
    action_authority_tier: 'diagnostic_only',
    prescriptions: [],
    ads: [],
    unavailable_reason: UNAVAILABLE_REASON,
  }
}
