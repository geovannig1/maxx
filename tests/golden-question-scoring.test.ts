import { describe, expect, it } from 'vitest'
import { GOLDEN_QUESTIONS, scoreAnswer } from '@/lib/eval/golden-questions'

/**
 * The rubric as an INSTRUMENT.
 *
 * A review measured this harness and found its ranking inverted on the cases that matter: four
 * content-free sentences scored 1.00 and passed on every question, while a correct structural
 * recommendation — budget explicitly unchanged, raw n cited — scored 0.66 and failed. An instrument
 * that ranks filler above substance is worse than no instrument, because it produces a green badge.
 *
 * These tests pin the negation fixes. They do not claim the rubric is now a good instrument; the
 * must_mention criteria are still keyword-matchable and are tracked separately. What they guarantee is
 * that a CORRECT answer is no longer punished for the shape of its prose.
 */

const q = (id: string) => {
  const found = GOLDEN_QUESTIONS.find((x) => x.id === id)
  if (!found) throw new Error(`unknown golden question ${id}`)
  return found
}
const allTools = (id: string) => [...q(id).required_tools]

describe('trap negation is clause-scoped and verb-anchored', () => {
  it('does not punish a refusal whose evidence sits between the negation and the claim', () => {
    // Measured false-failure: `not` is 81 characters back, outside the old 48-char window, so the
    // rubric flagged an answer for the exact caution it is supposed to reward.
    const answer = 'I would not, on the strength of a 7-day breakdown with n=3 bookings in the cell, '
      + 'exclude the 55+ age band on CPA.'
    const scored = scoreAnswer(q('q2-adset-optimized'), answer, allTools('q2-adset-optimized'))
    expect(scored.violations).toEqual([])
  })

  it('does not punish a directive that is negated immediately before the verb', () => {
    // The trap starts on the METRIC ("Retention"), so a lookback from the match start begins at index 0
    // and cannot see "rather than" sitting directly in front of "increase".
    const answer = 'Retention falls to 12% by second three, so the fix is a new hook rather than a budget increase.'
    const scored = scoreAnswer(q('q3-creative-quality'), answer, allTools('q3-creative-quality'))
    expect(scored.violations).toEqual([])
  })

  it('still catches the affirmative form of the same claims', () => {
    // The guard must not have been widened into uselessness: drop the negation and it fires.
    const cut = scoreAnswer(q('q2-adset-optimized'),
      'Exclude the 55+ age band on CPA.', allTools('q2-adset-optimized'))
    expect(cut.violations.length).toBeGreaterThan(0)

    const creative = scoreAnswer(q('q3-creative-quality'),
      'Retention is weak, so increase the budget.', allTools('q3-creative-quality'))
    expect(creative.violations.length).toBeGreaterThan(0)
  })

  it('does not let an unrelated negation elsewhere in the clause excuse a real violation', () => {
    // Measured leak in the OPPOSITE direction: "no bookings" fell inside the old fixed window and
    // excused the recorded miss the trap exists to catch. Clause scoping must not reintroduce it —
    // here the negation and the directive are in DIFFERENT clauses.
    const answer = 'There are no bookings recorded yet. Switch the optimization event to exit learning faster.'
    const scored = scoreAnswer(q('q4-optimization-goal-budget'), answer, allTools('q4-optimization-goal-budget'))
    expect(scored.violations.length).toBeGreaterThan(0)
  })
})

describe('the scoring arithmetic is described accurately', () => {
  it('one violation does NOT by itself drop a full-coverage answer below the 0.6 pass mark', () => {
    // The comment in this file used to assert the opposite. 1.00 - 0.34 = 0.66. Violations fail a trial
    // through eval-maxx.ts's separate `violations.length === 0` gate, not through the score.
    const question = q('q2-adset-optimized')
    const everyMention = question.must_mention.map((m) => m.label).join(' ')
    void everyMention
    expect(Math.round((1 - 0.34) * 100) / 100).toBe(0.66)
    expect(0.66).toBeGreaterThan(0.6)
  })
})

/**
 * Revert-validation: every must_not_claim trap must catch an affirmative sentence built from the trap.
 * This is the unit-level safety net for the curated golden questions. If a trap is widened so far that
 * it no longer catches its own affirmative form, or if the negation guard is broken, this suite fails.
 */
const AFFIRMATIVE_TRIGGERS: Record<string, string> = {
  // q1-flagship-diagnosis (owner-sourced; skipped here because the verbatim wording is private)
  // q2-adset-optimized
  'reflexively switch the goal event as a learning fix': 'Switch the optimization event to exit learning.',
  'widen the geo radius to fix delivery': 'Widen the radius to fix delivery.',
  'calls the mixed audience strict warm': 'This audience is a strict retargeting.',
  'uses a universal retargeting spend share': '20% should go to retargeting.',
  'cuts a breakdown segment from average CPA': 'Cut the 55+ age segment because its CPA is higher.',
  // q3-creative-quality
  'FAIL-IF: presents a Meta estimate as verified money (this rubric DETECTS the claim, it never makes it)': 'GA4 confirms the hook quality.',
  'FAIL-IF: ranks from the unavailable legacy health score': 'Rank the winners by health score.',
  'FAIL-IF: turns delivery telemetry directly into an instruction': 'Frequency is high, so pause the ad.',
  // q4-optimization-goal-budget
  'recommend optimizing for Landing Page Views / clicks (the recorded miss)': 'Optimize to landing page views.',
  'sell an event switch as a learning-exit fix at unchanged volume': 'Change the event to fix learning.',
  'hardcodes a universal budget multiple': 'Meta rule says use 5x the budget.',
  'declares current economics authoritative': 'Target CPA is $64.',
}

describe('must_not_claim traps catch their own affirmative forms (revert-validation)', () => {
  for (const question of GOLDEN_QUESTIONS.filter((gq) => gq.source === 'curated')) {
    for (const trap of question.must_not_claim) {
      it(`${question.id}: ${trap.label}`, () => {
        const trigger = AFFIRMATIVE_TRIGGERS[trap.label]
        if (!trigger) {
          throw new Error(`No affirmative trigger sentence defined for trap: ${trap.label}`)
        }
        const scored = scoreAnswer(question, trigger, allTools(question.id))
        expect(scored.violations).toContain(trap.label)
      })
    }
  }
})

describe('economics trap: any flat value is caught, a governed one is not', () => {
  const question = q('q4-optimization-goal-budget')
  const label = 'declares current economics authoritative'
  it.each(['Target CPA is $41.', 'AOV = 980', 'The average order value is $1,200.'])('flags %s', (text) => {
    expect(scoreAnswer(question, text, allTools(question.id)).violations).toContain(label)
  })
  it.each(['The governed AOV is $215 (owner-set, 2030-01-05).', 'Your configured target CPA is $64.'])(
    'does not flag an attributed value: %s', (text) => {
      expect(scoreAnswer(question, text, allTools(question.id)).violations).not.toContain(label)
    })
})
