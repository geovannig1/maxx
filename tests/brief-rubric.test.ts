import { describe, expect, it } from 'vitest'
import { scoreBrief } from '@/lib/eval/brief-rubric'
import {
  ADMISSIBLE_CASES, BOOKINGS_UNAVAILABLE_FIXTURE, CORRECT_BRIEF, DEFECT_CASES, META_ONLY,
  PAID_CPA_UNAVAILABLE_FIXTURE, RECONCILIATION_EXPECTATION, brief, fixtureClaims,
} from './fixtures/brief-defects'

/**
 * Validates the AnswerBrief rubric against known-broken and known-good input.
 *
 * The discipline here is localisation, not merely detection. Each defect case asserts that the named
 * gate fails AND that no other gate does. A rubric which fires several gates on one defect looks
 * thorough and is useless for triage: it cannot tell an operator what went wrong, and it hides the
 * case where a gate passes for an unrelated reason. The admissible cases exist for the opposite
 * failure — a rubric that rejects everything also shows a clean fixture suite, and tightening gates
 * is exactly when that gets shipped by accident.
 */

describe('every seeded defect trips its own gate, and only its own', () => {
  it.each(DEFECT_CASES.map((c) => [c.name, c] as const))('%s', (_name, testCase) => {
    const expectation = testCase.expectation ?? RECONCILIATION_EXPECTATION
    const scored = scoreBrief(expectation, testCase.brief, fixtureClaims())
    expect(scored.failedGates).toEqual([testCase.expected])
    expect(scored.admissible).toBe(false)
  })

  it('covers every gate the rubric defines', () => {
    // A gate with no defect fixture has never been shown to fire. Adding one to brief-rubric.ts
    // without a case here would leave it decorative, which is how unfailable criteria accumulate.
    const gatesUnderTest = new Set(DEFECT_CASES.map((c) => c.expected))
    const gatesDefined = scoreBrief(RECONCILIATION_EXPECTATION, CORRECT_BRIEF, fixtureClaims()).gates.map((g) => g.gate)
    expect([...gatesUnderTest].sort()).toEqual([...gatesDefined].sort())
  })

  it('exercises more than one distinct defect per gate', () => {
    // One fixture per gate proves the gate fires; it does not probe the boundary. Gates with a single
    // case are the ones that later turn out to match on a substring or a coincidence.
    const perGate = new Map<string, number>()
    for (const c of DEFECT_CASES) perGate.set(c.expected, (perGate.get(c.expected) ?? 0) + 1)
    for (const [gate, count] of perGate) expect(count, `${gate} has only ${count} fixture`).toBeGreaterThan(1)
  })
})

describe('the governed claim set is load-bearing, not decoration', () => {
  it('fails, naming the id, when a cited predicate does not resolve', () => {
    // The parameter was required "so a caller cannot score against no evidence" and then read by
    // nothing — eslint said so and `npm run lint` had no --max-warnings, so the gate emitted the
    // signal and swallowed it. This is the behaviour that makes it real.
    const scored = scoreBrief(RECONCILIATION_EXPECTATION, CORRECT_BRIEF, new Map())
    expect(scored.admissible).toBe(false)
    expect(scored.failedGates).toContain('G1_evidence_planes')
    const g1 = scored.gates.find((gate) => gate.gate === 'G1_evidence_planes')!
    expect(g1.detail).toMatch(/does not contain/)
  })

  it('does not throw on an unresolvable brief — a harness fault must read as a verdict', () => {
    expect(() => scoreBrief(RECONCILIATION_EXPECTATION, CORRECT_BRIEF, new Map())).not.toThrow()
  })
})

describe('correct briefs are admitted', () => {
  it.each(ADMISSIBLE_CASES.map((c) => [c.name, c] as const))('%s', (_name, testCase) => {
    const scored = scoreBrief(testCase.expectation ?? RECONCILIATION_EXPECTATION, testCase.brief, fixtureClaims())
    expect(scored.failedGates).toEqual([])
    expect(scored.admissible).toBe(true)
    expect(scored.score).toBe(1)
  })
})

describe('admissibility is all-gates, not a threshold', () => {
  it('a brief failing one gate is inadmissible however well it scores elsewhere', () => {
    // The previous rubric let a confident answer buy its way past the one thing it got wrong: a single
    // violation cost 0.34 against a 0.6 pass mark, so 1.00 - 0.34 = 0.66 still passed.
    const oneBadGate = DEFECT_CASES[0]
    const scored = scoreBrief(oneBadGate.expectation ?? RECONCILIATION_EXPECTATION, oneBadGate.brief, fixtureClaims())
    expect(scored.score).toBeGreaterThan(0.6)
    expect(scored.admissible).toBe(false)
  })
})

describe('citing the answer never scores worse than refusing to', () => {
  it('admits a brief that CITES a booking, not only one that declares bookings unavailable', () => {
    // The exploit this closes, found by executing the tightened expectation rather than reading it.
    // G4 checked only cited predicates, and every Acuity claim carries entity.level 'business' while
    // q1 pinned a single global level of 'account'. So a brief citing Meta Results plus a real Acuity
    // booking count FAILED G4, while a brief that merely declared bookings unavailable PASSED — the
    // unavailable list is never level-checked. Admissibility is all-gates-pass, so declaring silence
    // outscored the correct answer, and the eval rewarded exactly the behaviour the claim supply is
    // being built to end. The earlier escape hatch's shape: wired wired back into the quarantine.
    const cites = scoreBrief(RECONCILIATION_EXPECTATION, CORRECT_BRIEF, fixtureClaims())
    const refuses = scoreBrief(
      RECONCILIATION_EXPECTATION,
      brief([META_ONLY], [PAID_CPA_UNAVAILABLE_FIXTURE, BOOKINGS_UNAVAILABLE_FIXTURE]),
      fixtureClaims(),
    )
    expect(cites.admissible).toBe(true)
    expect(cites.score).toBeGreaterThanOrEqual(refuses.score)
  })
})

describe('gate details name what the brief did, not what the rule says', () => {
  it('a failure explains the actual selection so it can be triaged without reading the rubric', () => {
    const scored = scoreBrief(RECONCILIATION_EXPECTATION, DEFECT_CASES[0].brief, fixtureClaims())
    const failed = scored.gates.find((g) => !g.passed)!
    expect(failed.detail).toContain('outcome_business')
    expect(failed.detail).not.toContain('must')
  })
})
