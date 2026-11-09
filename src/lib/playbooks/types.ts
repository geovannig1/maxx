// Per-question-type REASONING PROCEDURES — the "processing thoughts".
//
// Before these existed, only launch-readiness and the performance diagnosis had deterministic guidance;
// scale/kill/testing/budget/audience/bidding questions fell to free-form LLM prose — which is exactly
// where generic, hole-ridden advice came from. A playbook is not prose: it is the ordered procedure a
// strong media buyer runs (which evidence to pull, via which tools), the decision rules (citing the
// central thresholds, the knowledge corpus, and the champion baseline), and the hard "never" list.
//
// Numbers are NOT restated here — decision rules cite REC_THRESHOLDS / target-ranges / corpus keys so
// values stay single-sourced. Playbooks guide; the grounding gate still judges any resulting action.

import { outcomeWords } from '@/config/outcome-nouns'

const OW = outcomeWords()

export type PlaybookIntent =
  | 'scale_decision'
  | 'kill_or_keep'
  | 'creative_testing'
  | 'creative_refresh'
  | 'budget_allocation'
  | 'structure_audience'
  | 'optimization_event'
  | 'measurement_tracking'
  | 'launch_setup'
  | 'profit_economics'
  | 'seasonality'

export interface PlaybookStep {
  step: string
  /** MCP tool that produces this evidence (must exist in TOOL_DEFINITIONS — enforced by test). */
  tool?: string
  /** What to check in the result before moving on. */
  check: string
}

export interface Playbook {
  intent: PlaybookIntent
  /** The owner-question shape this answers. */
  question: string
  /** Evidence to gather BEFORE forming a view (tool names; test-enforced). */
  required_evidence: string[]
  procedure: PlaybookStep[]
  /** IF/THEN rules citing REC_THRESHOLDS fields, corpus entry keys, and the champion baseline. */
  decision_rules: string[]
  /** Hard prohibitions — each one traces to a real past miss or a platform mechanic. */
  never: string[]
  /** corpus entry keys this playbook leans on (must resolve — test-enforced). */
  corpus_refs: string[]
  champion_context: string
}

/** The account's proven possibility frontier — every scale/kill/keep judgment is relative to this.
 *  ILLUSTRATIVE PLACEHOLDER: replace with your own account's proven baseline (a consolidated conversion
 *  ad set that ran long enough to be a benchmark). The numbers below are round examples, not data. */
export const CHAMPION_CONTEXT =
  `Champion baseline — EXAMPLE ONLY (USD example): one consolidated conversion ad set over ~6 months: $9,000 → 300 ${OW.many} = $30 lifetime CPA (Meta-attributed); ` +
  `prime months (USD example) $20–30 CPA at ~12 ${OW.many}/week on ~$40–60/day; ONE consolidated conversion ad set, likely Learning-Limited throughout. ` +
  'Its final period showed delivery signals consistent with creative wear (rising frequency, eroding CTR, rising modelled CPA), but the cause was not identified by a controlled comparison. ' +
  'Owner constraint: the account-total daily budget is capped by DAILY_BUDGET_CEILING; raising it requires provably beating this champion.'
