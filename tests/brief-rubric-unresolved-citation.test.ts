import { describe, expect, it } from 'vitest'
import { scoreBrief, type BriefGateId } from '@/lib/eval/brief-rubric'
import {
  CORRECT_BRIEF, RECONCILIATION_EXPECTATION, brief, citation, fixtureClaims,
} from './fixtures/brief-defects'

/**
 * A citation the governed claim set does not contain must fail EVERY evidence gate.
 *
 * This is the fail-open fix, and mutation testing found it completely unverified: `&& evidenceResolves`
 * could be removed from G1, G2, G3, G4 or G5 individually — or from all five at once, reverting the
 * whole fix — and the whole suite passed every time. No test anywhere scored a brief containing an
 * unresolved citation, so the guard existed only as source text.
 *
 * Why it has to be every gate rather than G1 alone. Under the old predicate schema an unresolved
 * citation still carried its own transcribed plane, level, window and lane, so G2-G5 could read those
 * and reach a verdict. A brief now carries ids: an unresolved id resolves to nothing and simply drops
 * out of each gate's input, so four gates pass VACUOUSLY on evidence that does not exist. `admissible`
 * requires all gates so the verdict stayed correct — but the SCORE rises as the evidence gets worse,
 * and the score is what a human reads when triaging a run.
 */

const EVIDENCE_GATES: BriefGateId[] = [
  'G1_evidence_planes',
  'G2_no_modelled_substitution',
  'G3_unavailable_declared',
  'G4_entity_level',
  'G5_window_respected',
]

const claims = fixtureClaims()
const gate = (id: BriefGateId, scored: ReturnType<typeof scoreBrief>) =>
  scored.gates.find((g) => g.gate === id)!

describe('an unresolved citation fails every gate that reads evidence', () => {
  // The correct brief with ONE id the claim set does not contain, appended. Everything else about it
  // is admissible, so any gate that still passes is passing on evidence it never saw.
  const withGhost = brief(
    [...CORRECT_BRIEF.observations.flatMap((o) => o.claim_ids), 'ghost-claim-id'],
    [...CORRECT_BRIEF.unavailable_claim_ids],
  )

  it('the same brief WITHOUT the ghost id is admissible (guards this test against proving nothing)', () => {
    const scored = scoreBrief(RECONCILIATION_EXPECTATION, CORRECT_BRIEF, claims)
    expect(scored.admissible).toBe(true)
    expect(scored.score).toBe(1)
  })

  it.each(EVIDENCE_GATES)('%s fails when a cited id does not resolve', (id) => {
    const scored = scoreBrief(RECONCILIATION_EXPECTATION, withGhost, claims)
    expect(gate(id, scored).passed).toBe(false)
  })

  it('names the offending id rather than restating the rule', () => {
    const scored = scoreBrief(RECONCILIATION_EXPECTATION, withGhost, claims)
    for (const id of EVIDENCE_GATES) expect(gate(id, scored).detail).toContain('ghost-claim-id')
  })

  it('drives the score DOWN, not up — the whole point of the fix', () => {
    const clean = scoreBrief(RECONCILIATION_EXPECTATION, CORRECT_BRIEF, claims)
    const ghosted = scoreBrief(RECONCILIATION_EXPECTATION, withGhost, claims)
    expect(ghosted.score).toBeLessThan(clean.score)
    expect(ghosted.admissible).toBe(false)
  })

  it('G6 is unaffected by a ghost CLAIM id, because it reads decisions', () => {
    const scored = scoreBrief(RECONCILIATION_EXPECTATION, withGhost, claims)
    expect(gate('G6_action_decisions', scored).passed).toBe(true)
  })
})

describe('a fabricated action-decision id fails G6', () => {
  // G6 counted `brief.action_decision_ids.length` and resolved nothing, so a brief citing three
  // invented ids scored admissible on an expectation of `required`. The only thing catching it was
  // `renderAnswerBrief` on the live path — the precondition that had been deleted as "no longer
  // guarding anything", which was true for claims and false for decisions.
  const expectation = { ...RECONCILIATION_EXPECTATION, actionDecisions: 'required' as const }
  const cited = [...CORRECT_BRIEF.observations.flatMap((o) => o.claim_ids)]
  const withDecision = (ids: string[]) => brief(cited, [...CORRECT_BRIEF.unavailable_claim_ids], ids)

  it('passes when every referenced decision resolves', () => {
    const scored = scoreBrief(expectation, withDecision(['decision-1']), claims, new Set(['decision-1']))
    expect(gate('G6_action_decisions', scored).passed).toBe(true)
    expect(gate('G6_action_decisions', scored).detail).toContain('all resolved')
  })

  it('FAILS on an id no persisted final decision matches', () => {
    const scored = scoreBrief(expectation, withDecision(['fabricated-decision-id']), claims, new Set(['decision-1']))
    expect(gate('G6_action_decisions', scored).passed).toBe(false)
    expect(gate('G6_action_decisions', scored).detail).toContain('fabricated-decision-id')
    expect(scored.admissible).toBe(false)
  })

  it('says the ids were NOT verified when no decision set is supplied, rather than implying they were', () => {
    const scored = scoreBrief(expectation, withDecision(['anything-at-all']), claims)
    expect(gate('G6_action_decisions', scored).passed).toBe(true)
    expect(gate('G6_action_decisions', scored).detail).toContain('ids unverified')
  })
})

describe('an unresolved id in the UNAVAILABLE list is caught too', () => {
  // Mutation M7e: dropping `unavailable_claim_ids` from the `unresolved` set was invisible. Under the
  // predicate schema those citations escaped resolution checking entirely, so this is new coverage of
  // a hole that predates the change.
  const ghostUnavailable = brief(
    [...CORRECT_BRIEF.observations.flatMap((o) => o.claim_ids)],
    ['ghost-unavailable-id'],
  )

  it.each(EVIDENCE_GATES)('%s fails when a DECLARED-UNAVAILABLE id does not resolve', (id) => {
    const scored = scoreBrief(RECONCILIATION_EXPECTATION, ghostUnavailable, claims)
    expect(gate(id, scored).passed).toBe(false)
  })

  it('names it', () => {
    const scored = scoreBrief(RECONCILIATION_EXPECTATION, ghostUnavailable, claims)
    expect(gate('G1_evidence_planes', scored).detail).toContain('ghost-unavailable-id')
  })
})

describe('resolution is checked against the SUPPLIED claim set, not a global registry', () => {
  it('a real fixture id fails when scored against a claim set that lacks it', () => {
    // The 6-of-16 defect in another form: an id that resolves somewhere is not an id that resolves
    // HERE. `scoreBrief` must judge against the evidence its caller actually supplied.
    const realId = citation({ metric_key: 'meta_results' })
    const empty = new Map()
    const scored = scoreBrief(RECONCILIATION_EXPECTATION, brief([realId]), empty)
    expect(gate('G1_evidence_planes', scored).passed).toBe(false)
    expect(gate('G1_evidence_planes', scored).detail).toContain(realId)
  })
})
