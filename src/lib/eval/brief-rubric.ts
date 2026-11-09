import type { AnswerBrief, AnswerBriefClaim } from '@/lib/maxx/answer-brief'
import type { MetricClaim } from '@/lib/cockpit/contracts'

/**
 * Scores the STRUCTURED AnswerBrief, not the rendered text.
 *
 * WHY THIS REPLACES KEYWORD SCORING. An earlier commit changed runMaxxChat so that every return path is
 * either a fixed English string or `renderAnswerBrief(...)` — a server-composed template. The model's
 * surviving output is JSON with no prose-bearing field left open: `summary` is
 * literal('governed_claims'), `next_check` is null, and everything else is a claim ID. (A `direction`
 * literal used to be listed here too; the id-only schema removed the field outright.) The model
 * therefore cannot write a sentence, and golden-questions.ts — which keyword-matches sentences — was
 * left grading a template.
 *
 * That is not a weak rubric, it is an inverted one. Measured on the real render: a correct governed
 * answer citing a valid claim scores 0.00 with 0/4 mentions on all four scenarios and cannot reach the
 * 0.6 pass mark, while the string "Maxx chat is disabled." scores 0.25 on two of them. Every trial
 * fails, always, whatever Maxx does. CI went dark in the same commit, so nothing reported it.
 *
 * What the model DOES control is the selection: which governed claims enter `observations`, which are
 * declared in `unavailable_claim_ids`, and which persisted ActionDecisions are referenced. That
 * selection is the whole of its judgement, and it is exactly what these gates read. A gate here cannot
 * be satisfied by phrasing, because there is no phrasing — only claim ids, evidence planes, entity
 * levels, windows and measurement lanes, each already validated against the claim it names.
 */

export type BriefGateId =
  | 'G1_evidence_planes'
  | 'G2_no_modelled_substitution'
  | 'G3_unavailable_declared'
  | 'G4_entity_level'
  | 'G5_window_respected'
  | 'G6_action_decisions'

export interface BriefGateResult {
  gate: BriefGateId
  passed: boolean
  /** What the brief actually did — never a restatement of the rule. Read by a human triaging a fail. */
  detail: string
}

export interface BriefExpectation {
  id: string
  /** Planes the answer must reach to be complete. A reconciliation question is not answered by one. */
  requiredPlanes: ReadonlyArray<MetricClaim['source']['evidencePlane']>
  /**
   * Metric keys whose business-truth answer is what was asked. If a modelled claim for one of these is
   * cited and no business-plane claim for it is either cited or declared unavailable, the answer has
   * quietly substituted Meta's model for the business outcome — the single error this account is most
   * prone to, and the one Meta's own chat made.
   */
  businessTruthMetrics: readonly string[]
  /** Metric keys known to be unmeasurable here. Omitting them reads as confidence; declaring them is the answer. */
  mustDeclareUnavailable: readonly string[]
  /**
   * Entity levels this question accepts, PER EVIDENCE PLANE.
   *
   * Not a single level. Entity level is a property of the plane, not of the question: `commonClaim`
   * stamps every `outcome_business` claim `level: 'business'` because a booking belongs to the
   * business, while Meta delivery claims are account/campaign/adset/ad. A question pinned to one
   * global level therefore rejects the correct multi-plane answer — with q1 pinned to 'account', a
   * brief citing Meta Results AND an outcome-source booking count failed G4 while a brief that merely
   * DECLARED bookings unavailable passed, because unavailable predicates are not level-checked.
   * Since admissibility is all-gates-pass, that made silence score higher than the correct answer:
   * an eval rewarding exactly the behaviour the claim supply exists to end.
   *
   * A cited claim whose plane has no entry here FAILS. That is deliberate — a new plane must be
   * declared rather than inheriting a silent exemption.
   */
  entityLevels: Partial<
    Record<
      MetricClaim['source']['evidencePlane'],
      ReadonlyArray<MetricClaim['entity']['level']>
    >
  > | null
  /** Inclusive date bounds the cited windows must fall within, when the question pins a period. */
  window: { start: string; end: string } | null
  /** Whether a persisted final ActionDecision is expected to be referenced. */
  actionDecisions: 'required' | 'forbidden' | 'either'
}

export interface BriefScore {
  id: string
  gates: BriefGateResult[]
  /** Fraction of gates passed. Reported for triage; admissibility is all-gates-pass, not a threshold. */
  score: number
  /** A brief is admissible only if EVERY gate passes. A partial score never admits an answer. */
  admissible: boolean
  failedGates: BriefGateId[]
}

function allCitedIds(brief: AnswerBrief): string[] {
  return brief.observations.flatMap((observation) => observation.claim_ids)
}

const MODELLED_LANES = new Set(['modelled', 'associated_noncausal'])

/**
 * Score a brief against a question's expectation.
 *
 * `claims` is the governed claim set the tools supplied, keyed by claimId, and is REQUIRED rather
 * than defaulted. An optional map would let a caller who forgets it score against no evidence and
 * pass — a fail-open read, which is the defect class this codebase keeps paying for.
 *
 * Every CLAIM gate reads the governed claim, never the brief: a brief carries claim ids, so G1-G5
 * have no model-authored field left to read. The predicate precondition this block used to open with
 * guarded exactly that, and it is gone with it.
 *
 * G6 IS DIFFERENT, and an earlier version of this comment wrongly said otherwise. It reads
 * `brief.action_decision_ids` — model-supplied strings — and until now resolved none of them, so a
 * brief citing three fabricated decision ids scored `admissible: true` on an expectation of
 * `required`. On the live path `renderAnswerBrief` catches it (`AnswerBrief referenced unknown action
 * decision …`), which is precisely the precondition that was deleted as "no longer guarding
 * anything" — true for claims, false for decisions. `scoreBrief` now resolves them itself, so the
 * rubric no longer depends on a caller having rendered first.
 */
export function scoreBrief(
  expectation: BriefExpectation,
  brief: AnswerBrief,
  claims: ReadonlyMap<string, AnswerBriefClaim>,
  validActionDecisionIds: ReadonlySet<string> | null = null,
): BriefScore {
  const citedIds = allCitedIds(brief)
  const gates: BriefGateResult[] = []

  // Resolve every cited id to its GOVERNED claim and read the gates off that. The brief no longer
  // carries transcribed predicate fields — it carries ids — so there is nothing model-asserted left
  // for a gate to read, and the caveat this file used to open with ("only renderAnswerBrief having
  // checked every predicate field makes it safe to read them") no longer has anything to guard.
  const unresolved = [...new Set(
    [...citedIds, ...brief.unavailable_claim_ids].filter((id) => !claims.has(id)),
  )]
  const cited = citedIds
    .map((id) => claims.get(id))
    .filter((claim): claim is AnswerBriefClaim => claim !== undefined)
  const declaredUnavailable = brief.unavailable_claim_ids
    .map((id) => claims.get(id))
    .filter((claim): claim is AnswerBriefClaim => claim !== undefined)

  // An unresolved id fails EVERY evidence gate, not just G1. Under the predicate schema an unresolved
  // citation still carried its own transcribed fields, so G2-G5 could read and pass them; now it
  // resolves to nothing and would simply drop out of each gate's input, letting four gates pass
  // vacuously on evidence that does not exist. `admissible` requires all gates, so the verdict was
  // already correct — but the SCORE would have risen as the evidence got worse.
  //
  // Deliberately not a throw: a scoring harness that cannot resolve its own evidence should produce a
  // readable verdict, not an exception that reads like a crash in the thing being measured.
  const evidenceResolves = unresolved.length === 0
  const unresolvedDetail = `referenced ${unresolved.join(', ')}, which the governed claim set does not `
    + 'contain'  // "referenced", not "cited": an id here may have come from unavailable_claim_ids.

  // G1 — the answer must reach every plane the question needs. Citing three claims from one plane is
  // volume, not reconciliation.
  const planes = new Set([
    ...cited.map((c) => c.source.evidencePlane),
    ...declaredUnavailable.map((c) => c.source.evidencePlane),
  ])
  const missingPlanes = expectation.requiredPlanes.filter((plane) => !planes.has(plane))
  gates.push({
    gate: 'G1_evidence_planes',
    passed: missingPlanes.length === 0 && evidenceResolves,
    detail: !evidenceResolves
      ? unresolvedDetail
      : missingPlanes.length === 0
      ? `reached ${[...planes].sort().join(', ') || 'no planes'}`
      : `never reached ${missingPlanes.join(', ')}; cited only ${[...planes].sort().join(', ') || 'nothing'}`,
  })

  // G2 — a modelled number presented where a business outcome was asked, with the business plane
  // neither cited nor declared missing, is Meta's model wearing the business answer's clothes.
  const substituted = expectation.businessTruthMetrics.filter((metric) => {
    const modelled = cited.some((c) => c.metricKey === metric && MODELLED_LANES.has(c.measurementKind))
    if (!modelled) return false
    const grounded = [...cited, ...declaredUnavailable].some(
      (c) => c.metricKey === metric && c.source.evidencePlane === 'outcome_business',
    )
    return !grounded
  })
  gates.push({
    gate: 'G2_no_modelled_substitution',
    passed: substituted.length === 0 && evidenceResolves,
    detail: !evidenceResolves ? unresolvedDetail : substituted.length === 0
      ? 'no modelled claim stands in for an unstated business outcome'
      : `${substituted.join(', ')} presented from a modelled lane with no business-truth claim cited or declared unavailable`,
  })

  // G3 — what cannot be measured must be SAID to be unmeasurable. Silent omission is the failure this
  // account produces most: an answer that simply leaves out the unmeasurable reads as a complete one.
  const declaredKeys = new Set(declaredUnavailable.map((c) => c.metricKey))
  const availableKeys = new Set(
    cited.filter((c) => c.availability.state === 'available').map((c) => c.metricKey),
  )
  const silentlyOmitted = expectation.mustDeclareUnavailable.filter(
    (metric) => !declaredKeys.has(metric) && !availableKeys.has(metric),
  )
  gates.push({
    gate: 'G3_unavailable_declared',
    passed: silentlyOmitted.length === 0 && evidenceResolves,
    detail: !evidenceResolves ? unresolvedDetail : silentlyOmitted.length === 0
      ? `declared ${[...declaredKeys].sort().join(', ') || 'nothing'} unavailable`
      : `omitted ${silentlyOmitted.join(', ')} entirely instead of declaring it unavailable`,
  })

  // G4 — an account-level number does not answer a question about one ad set. Checked per plane,
  // because the level a claim carries is decided by its plane, not by the question.
  const levels = expectation.entityLevels
  const wrongLevel = levels === null ? [] : cited.filter((c) => {
    const allowed = levels[c.source.evidencePlane]
    return allowed === undefined || !allowed.includes(c.entity.level)
  })
  gates.push({
    gate: 'G4_entity_level',
    passed: wrongLevel.length === 0 && evidenceResolves,
    detail: !evidenceResolves ? unresolvedDetail : wrongLevel.length === 0
      ? levels === null
        ? 'no entity-level constraint on this question'
        : `every cited claim sits at a level its plane declares (${Object.entries(levels)
            .map(([plane, allow]) => `${plane}:${(allow as readonly string[]).join('|')}`).join(', ')})`
      : `cited ${wrongLevel.map((c) => `${c.metricKey}@${c.source.evidencePlane}/${c.entity.level}`).join(', ')}, which its plane does not declare`,
  })

  // G5 — a claim measured over a different period is a different claim.
  //
  // EXCEPT the prior period a cited trend explicitly declares. Per-metric trends emit `*_change` claims
  // carrying `comparison: { method: 'prior_equal_period', window }`, and the evidence behind one is
  // the same metric over that earlier window. Before this exemption existed, a brief citing
  // a trend alone scored 1.000 and admissible, while the same brief ALSO citing the prior-period
  // number it was computed from scored 0.833 and inadmissible.
  //
  // That is an incentive gradient toward less evidence — "spend was $480 then and $720 now, up
  // 50.0%" graded below "up 50.0%" — and it is the same shape as the cross-plane finding where the
  // honest label was refused and the dishonest one was not.
  //
  // Deliberately narrow: only a window a CITED trend names is exempt. An arbitrary out-of-period
  // claim still fails, and a prior window with no trend citing it still fails, so the gate keeps
  // doing the job it was written for.
  const declaredPriorWindows = new Set(
    cited
      .filter((c) => c.comparison.method === 'prior_equal_period' && c.comparison.window !== null)
      .map((c) => `${c.comparison.window!.start}:${c.comparison.window!.end}`),
  )
  const outOfWindow = expectation.window === null
    ? []
    : cited.filter((c) => {
        if (c.window.start >= expectation.window!.start && c.window.end <= expectation.window!.end) return false
        return !declaredPriorWindows.has(`${c.window.start}:${c.window.end}`)
      })
  gates.push({
    gate: 'G5_window_respected',
    passed: outOfWindow.length === 0 && evidenceResolves,
    detail: !evidenceResolves ? unresolvedDetail : outOfWindow.length === 0
      ? `all cited windows fall inside ${expectation.window ? `${expectation.window.start}..${expectation.window.end}` : 'any period'}`
      : `cited ${outOfWindow.map((c) => `${c.metricKey}(${c.window.start}..${c.window.end})`).join(', ')} outside the asked period`,
  })

  // G6 — referencing a governed decision when none supports the question is as wrong as omitting one
  // that does. Both are claims about what the system has actually decided.
  // Resolved, not counted. `null` means the caller supplied no decision set — then only the count is
  // checkable, and the gate says so rather than implying the ids were verified.
  const unknownDecisions = validActionDecisionIds === null
    ? []
    : brief.action_decision_ids.filter((id) => !validActionDecisionIds.has(id))
  const referenced = brief.action_decision_ids.length
  const countOk = expectation.actionDecisions === 'required' ? referenced > 0
    : expectation.actionDecisions === 'forbidden' ? referenced === 0
      : true
  gates.push({
    gate: 'G6_action_decisions',
    passed: countOk && unknownDecisions.length === 0,
    detail: unknownDecisions.length > 0
      ? `referenced ${unknownDecisions.join(', ')}, which no persisted final decision matches`
      : `${referenced} action decision(s) referenced${validActionDecisionIds === null ? ' (ids unverified: no decision set supplied)' : ', all resolved'}; expectation ${expectation.actionDecisions}`,
  })

  const failedGates = gates.filter((gate) => !gate.passed).map((gate) => gate.gate)
  return {
    id: expectation.id,
    gates,
    score: gates.filter((gate) => gate.passed).length / gates.length,
    // All-gates-pass, deliberately. A weighted threshold lets a confident answer buy its way past the
    // one gate it failed, which is how the previous rubric let filler outrank a correct refusal.
    admissible: failedGates.length === 0,
    failedGates,
  }
}
