// GOLDEN-QUESTIONS EVAL — the machine-readable rubric that turns the manual "surpass Meta's AI chat" scoring
// (the golden-questions design) into a repeatable, partially-deterministic harness. Each question
// carries: the tools a correct answer SHOULD call, must-mention differentiators (parity + the elements that
// beat Meta's chat), and must-NOT-claim traps (the exact mistakes Meta's chat made, plus the corrected Q1
// error). scripts/eval-maxx.ts runs each through runMaxxChat, scores these deterministically, and adds an
// optional LLM-judge score.
//
// The single VERBATIM owner audit question is deliberately NOT stored in the repo. The other three
// scenarios are curated regression probes, not owner transcripts. `fallback_prompt` keeps exploratory
// runs available; release acceptance overrides only the owner question from its private fixture.

export interface RubricCheck {
  /** Human label for the scorecard. */
  label: string
  /** Case-insensitive regex source tested against the answer text. */
  pattern: string
}

export interface GoldenQuestion {
  id: string
  /** Whether release acceptance supplies private owner wording or uses the committed curated scenario. */
  source: 'owner' | 'curated'
  theme: string
  /** Exploratory prompt; only an owner-sourced question may be overridden at run time. */
  fallback_prompt: string
  /** Every one of these read-only evidence tools is required. */
  required_tools: string[]
  /** Explicit AND groups; singleton groups preserve the full existing acceptance bar. */
  required_tool_groups: string[][]
  /** Differentiators/parity the answer SHOULD contain (each = one point). */
  must_mention: RubricCheck[]
  /** Traps the answer must NOT contain — the mistakes Meta's chat made (each hit = a violation). */
  must_not_claim: RubricCheck[]
  /** Free-text scoring guidance for the optional LLM judge. */
  rubric: string
}

export const GOLDEN_QUESTIONS: readonly GoldenQuestion[] = [
  {
    id: 'q1-flagship-diagnosis',
    source: 'owner',
    theme: 'Owner audit — campaign structure, tracking integrity, diagnosis, and safe scaling',
    fallback_prompt:
      'Audit my current Meta campaign, including warm and cold ad sets and recent tracking changes. What do you see, what should I fix, and what evidence would justify scaling?',
    required_tools: ['diagnose_ad_performance', 'get_reconciliation', 'get_operating_mode', 'get_recommendations'],
    required_tool_groups: [
      ['diagnose_ad_performance'], ['get_reconciliation'],
      ['get_operating_mode'], ['get_recommendations'],
    ],
    must_mention: [
      { label: 'learning is delivery state, not decision sample', pattern: 'learning.*(delivery|state|not.*sample|not.*proof)|50.*(not.*proof|not.*decision)' },
      { label: 'GA4↔Meta↔outcome-source reconciliation', pattern: 'GA4.*Meta|Meta.*GA4|the outcome source.*Meta|reconcil|source of truth' },
      { label: 'exact paid result unavailable', pattern: 'exact paid|paid (CPA|ROAS|bookings?).*unavailable|appointment[- ]id' },
      { label: 'measurement break or maturity', pattern: 'measurement.*(break|discontinu|matur|definition)|definition.*(break|discontinu)' },
      { label: 'governed scaling boundary', pattern: 'scale.*(evidence|recommendation|decision|not.*yet)|recommendation.*scale|hold.*scale' },
    ],
    must_not_claim: [
      { label: 'treats 50 learning events as statistical proof', pattern: '50 (events|conversions|results).*(proves?|enough to (decide|trust)|statistically significant)' },
      { label: 'claims Meta-modelled bookings are paid truth', pattern: 'Meta (proves?|confirmed|generated|drove).*(booking|revenue|ROAS)' },
      { label: 'credits the LPV definition jump to performance', pattern: 'landing page.*(improved|better).*(July 20|2\\.4|jump)|LPV.*(proves|shows).*(page|creative).*(improved|better)' },
      { label: 'scales from Meta-modelled results alone', pattern: '(scale|increase).*(budget|spend).*(because|based on).*(Meta|platform).*(result|booking|ROAS)' },
    ],
    rubric:
      'SURPASS if it audits structure and tracking before direction; separates delivery learning, measurement maturity, and decision sufficiency; reconciles Meta, GA4 and the outcome source; states exact paid outcomes are unavailable; checks the governed recommendation feed; and scales only when evidence supports the decision. It must not convert the learning counter, modelled attribution, or the LPV discontinuity into business proof or scale from Meta-modelled results alone.',
  },
  {
    id: 'q2-adset-optimized',
    source: 'curated',
    theme: 'Ad/ad-set level — is this ad set optimized / set up right?',
    fallback_prompt: 'Is my Warm retargeting ad set set up and optimized correctly? What would you change?',
    required_tools: ['diagnose_ad_performance', 'get_expert_knowledge', 'get_recommendations', 'get_playbook'],
    required_tool_groups: [
      ['diagnose_ad_performance'], ['get_expert_knowledge'],
      ['get_recommendations'], ['get_playbook'],
    ],
    must_mention: [
      { label: 'learning counter / threshold math', pattern: 'learning|counter|threshold|\\b50\\b|events?\\/week' },
      { label: 'holds the goal event', pattern: "never abandon|keep .*goal|don't (switch|abandon)|goal event" },
      { label: 'labels the audience mixed', pattern: 'mixed (acquisition )?(audience|cohort)|not strict retargeting|not warm[- ]only' },
      { label: 'controls versus suggestions', pattern: 'controls?.*suggestions?|suggestions?.*controls?' },
      { label: 'governed action boundary', pattern: 'CampaignPlan|governed recommendation|no (live )?change|diagnostic' },
    ],
    must_not_claim: [
      // RESTORED 2026-08-23. Deleted by an earlier commit with NO successor instrument. Unlike the keyword
      // must_mention criteria that commit correctly removed, these are CO-OCCURRENCE traps — they
      // require an action verb, an object and a purpose clause together, which is the same sound form
      // as the traps that commit added. The doctrines they measure are still enforced in
      // src/lib/playbooks/playbooks.ts ("NEVER abandon the goal event reflexively"; "the configured geo radius
      // is a business constraint, never widened to fix Learning Limited") — but a playbook is an INPUT
      // to the model, not a MEASUREMENT of it. Deleting the only check on a doctrine you still enforce
      // is uncompensated loss of eval coverage.
      { label: 'reflexively switch the goal event as a learning fix', pattern: 'switch (to|the) .*(event|optimization).*(exit|fix) learning|change the goal to exit learning' },
      { label: 'widen the geo radius to fix delivery', pattern: 'widen (the )?(radius|geo)|expand (the )?(radius|geography|20)' },
      { label: 'calls the mixed audience strict warm', pattern: '(is|remains|counts as) (a )?(strict|pure|warm[- ]only) retargeting' },
      { label: 'uses a universal retargeting spend share', pattern: '(10.?20%|20%).*(must|should|correct|rule).*(retarget|warm)|retarget.*(must|should).*(10.?20%|20%)' },
      { label: 'cuts a breakdown segment from average CPA', pattern: '(exclude|cut|remove).*(age|gender|placement).*(CPA|cost)' },
    ],
    rubric:
      'SURPASS if it inherits ad-to-ad-set learning state, derives the Warm audience identity from targeting fields, distinguishes strict controls from suggestions, holds the goal event, and withholds action absent a CampaignPlan/current recommendation. It must not widen geography or switch the event as a learning fix, call a mixed audience strict retargeting, apply a universal spend split, or turn breakdown averages into exclusions.',
  },
  {
    id: 'q3-creative-quality',
    source: 'curated',
    theme: 'Creative quality / diversity — are my creatives good / diverse enough?',
    fallback_prompt: 'Are my ad creatives good and diverse enough? What should I test next?',
    required_tools: ['get_creative_insights', 'get_creative_performance', 'get_recommendations'],
    required_tool_groups: [
      ['get_creative_insights'], ['get_creative_performance'], ['get_recommendations'],
    ],
    must_mention: [
      { label: 'format mix / diversity', pattern: 'format|diversif|all video|100% video|mix' },
      { label: 'truthful video evidence vocabulary', pattern: 'early[- ]view|video starts?|retention|25%.*video length' },
      { label: 'diagnostic / governed-decision boundary', pattern: 'diagnostic|descriptive|current recommendations?|no (creative )?verdict' },
      { label: 'CampaignPlan gate for new tests', pattern: 'CampaignPlan|campaign plan|approved.*plan|plan.*approved' },
    ],
    must_not_claim: [
      { label: 'FAIL-IF: presents a Meta estimate as verified money (this rubric DETECTS the claim, it never makes it)', pattern: 'GA4 (confirms|shows).*(hook|creative) (score|quality)' },
      { label: 'FAIL-IF: ranks from the unavailable legacy health score', pattern: 'health score.*(rank|best|winner|scale|kill|refresh)|(rank|best|winner).*health score' },
      { label: 'FAIL-IF: turns delivery telemetry directly into an instruction', pattern: '(frequency|CTR|retention).*(therefore|so|means).*(pause|scale|kill|refresh|increase|decrease)' },
    ],
    rubric:
      'SURPASS if it reports exact-account format and delivery observations with truthful video labels, states what is unavailable, checks Current Recommendations for any governed decision, and requires an approved CampaignPlan before test-production guidance. It must not rank or prescribe from a legacy score, Meta-modelled outcome, or hard fatigue band.',
  },
  {
    id: 'q4-optimization-goal-budget',
    source: 'curated',
    theme: 'Optimization goal / budget — am I optimizing for the right thing / spending right?',
    fallback_prompt: 'Am I optimizing for the right conversion event, and is my budget being spent well?',
    required_tools: ['get_playbook', 'get_decision_history', 'get_economics'],
    required_tool_groups: [['get_playbook'], ['get_decision_history'], ['get_economics']],
    must_mention: [
      { label: 'objective aligned to measurable outcome', pattern: 'objective.*(business|measurable|outcome)|measurable.*objective' },
      { label: 'conditional bid strategy', pattern: 'Highest Volume|cost[- ]per[- ]result|bid (cap|control).*(conditional|volume|economics|support)' },
      { label: 'learning versus sufficiency separation', pattern: 'learning.*(not.*proof|not.*decision|delivery state)|decision sufficiency|measurement maturity' },
    ],
    must_not_claim: [
      { label: 'recommend optimizing for Landing Page Views / clicks (the recorded miss)', pattern: 'optimize (for|to) (landing page views|LPV|link clicks|clicks)' },
      // RESTORED 2026-08-23 (see the q2 note): a co-occurrence trap deleted by an earlier commit with no
      // successor. At a couple of optimization events/week an account cannot exit learning by switching to
      // a chattier event, and that is the most tempting wrong fix available.
      { label: 'sell an event switch as a learning-exit fix at unchanged volume', pattern: '(switch|change).*(event).*(exit|fix) learning' },
      { label: 'hardcodes a universal budget multiple', pattern: '(must|always|Meta rule).*(5x|5×|five times).*(budget|CPA|cost)' },
      // Any flat economics value not attributed to the governed source (a value the model asserts on its own).
      { label: 'declares current economics authoritative', pattern: '(?<!(?:governed|configured|owner-set|saved) )(target CPA|AOV|average order value) (is|=) \\$?\\d' },
    ],
    rubric:
      'SURPASS if it aligns the objective to the measurable outcome, treats bid controls as conditional on governed economics and signal, and separates learning state from decision sufficiency. It must not prescribe LPV optimization, a universal budget multiple, or any of the conflicting ungoverned target values.',
  },
]

export interface DeterministicScore {
  id: string
  tool_coverage: number // fraction of required evidence groups satisfied
  tool_groups_hit: number
  tool_groups_total: number
  tools_hit: string[]
  mentions_hit: string[]
  mentions_missed: string[]
  violations: string[] // must_not_claim patterns that matched (each is a real problem)
  /** 0..1 — mention coverage minus a heavy penalty per violation, gated by tool coverage. */
  score: number
}

// A trap phrase preceded by a negation in the SAME clause ("do not add a retargeting layer") is the
// CORRECT advice, not a violation — the rubric explicitly asks for that framing. Without this, the best
// answers false-fail.
//
// TWO FIXES (2026-08-23), both for false-failures measured against real answer shapes:
//
// 1. CLAUSE-SCOPED, not a fixed 48-character window. A careful answer puts its evidence BETWEEN the
//    negation and the claim — "I would not, on the strength of a 7-day breakdown with n=3 bookings in
//    the cell, exclude the 55+ age band on CPA" places `not` 81 characters back. The old window scored
//    that as a violation, so the rubric penalised an answer precisely for citing its reasons.
//
// 2. ANCHOR ON THE DIRECTIVE VERB, not the start of the whole match. A trap like
//    /(frequency|CTR|retention).*(therefore|so|means).*(pause|scale|increase)/ begins on the METRIC, so
//    a lookback from the match start begins at index 0 and can never see the negation sitting directly
//    in front of the verb: "Retention falls to 12% by second three, so the fix is a new hook rather
//    than a budget increase" was scored as prescribing a budget increase.
//
// src/lib/authority/action-authority.ts:336 (`clauseNegatesDirective`) already solved exactly this,
// and its comment records why — "which is what the q1/q4 eval failures showed". That fix never reached
// this file. Kept local rather than imported: the eval needs a wider cue set than the money-imperative
// filter ("rather than", "instead of", "avoid"), and the eval must not depend on authority internals.
const NEGATION_CUE = /\b(not|no|never|none|don'?t|doesn'?t|didn'?t|cannot|can'?t|won'?t|would ?n'?t|should ?n'?t|avoid|without|instead of|rather than|nor)\b/i
const CLAUSE_BOUNDARY = /[.!?;:\n]|—/g

/** Start index of the clause containing `at`. */
function clauseStart(text: string, at: number): number {
  let start = 0
  CLAUSE_BOUNDARY.lastIndex = 0
  for (let m = CLAUSE_BOUNDARY.exec(text); m && m.index < at; m = CLAUSE_BOUNDARY.exec(text)) {
    start = m.index + m[0].length
  }
  return start
}

function isNegated(text: string, verbAt: number): boolean {
  return NEGATION_CUE.test(text.slice(clauseStart(text, verbAt), verbAt))
}

/** PURE: deterministic score for one answer. Regexes are case-insensitive. A violation is heavily
 *  penalized because must_not_claim encodes the exact mistakes we must never repeat — but a trap phrase
 *  that is NEGATED ("do not add retargeting") is the correct advice and is NOT counted. */
export function scoreAnswer(q: GoldenQuestion, answerText: string, toolsUsed: string[]): DeterministicScore {
  const text = answerText ?? ''
  const toolsSet = new Set(toolsUsed ?? [])
  const tools_hit = q.required_tools.filter((t) => toolsSet.has(t))
  const groups = q.required_tool_groups
  const tool_groups_hit = groups.filter((group) => group.some((tool) => toolsSet.has(tool))).length
  const tool_groups_total = groups.length
  const tool_coverage = tool_groups_total === 0 ? 1 : tool_groups_hit / tool_groups_total

  const mentions_hit: string[] = []
  const mentions_missed: string[] = []
  for (const m of q.must_mention) {
    if (new RegExp(m.pattern, 'i').test(text)) mentions_hit.push(m.label)
    else mentions_missed.push(m.label)
  }
  // A violation counts only when the trap matches WITHOUT a preceding negation (an affirmative recommendation).
  const violations: string[] = []
  for (const v of q.must_not_claim) {
    // `d` exposes capture indices so the negation lookback can anchor on the directive verb — the LAST
    // captured group — instead of whatever token the pattern happens to start on.
    const re = new RegExp(v.pattern, 'gdi')
    let m: RegExpExecArray | null
    let affirmative = false
    while ((m = re.exec(text)) !== null) {
      const groups = (m as RegExpExecArray & { indices?: Array<[number, number] | undefined> }).indices
      const verbAt = groups?.slice(1).filter(Boolean).pop()?.[0] ?? m.index
      if (!isNegated(text, verbAt)) { affirmative = true; break }
      if (m.index === re.lastIndex) re.lastIndex++ // guard against zero-width matches
    }
    if (affirmative) violations.push(v.label)
  }

  const mentionCoverage = q.must_mention.length === 0 ? 1 : mentions_hit.length / q.must_mention.length
  // Tool coverage gates the score at 0.5 (an answer that skipped every required tool can't score high).
  // Each violation subtracts 0.34. NOTE: this does NOT by itself drop a strong answer below the 0.6
  // pass mark — 1.00 - 0.34 = 0.66 — the earlier comment here asserted otherwise and was simply wrong.
  // Violations fail a trial through the separate `violations.length === 0` gate in scripts/eval-maxx.ts,
  // which is what actually enforces them; this subtraction only orders the survivors.
  const toolGate = 0.5 + 0.5 * tool_coverage
  const score = Math.max(0, mentionCoverage * toolGate - 0.34 * violations.length)

  return {
    id: q.id,
    tool_coverage,
    tool_groups_hit,
    tool_groups_total,
    tools_hit,
    mentions_hit,
    mentions_missed,
    violations,
    score: Math.round(score * 100) / 100,
  }
}
