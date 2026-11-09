import { describe, it, expect } from 'vitest'
import { GOLDEN_QUESTIONS, scoreAnswer } from '@/lib/eval/golden-questions'
import { TOOL_DEFINITIONS, WRITE_TOOLS } from '@/mcp/tools/index'

// CI-safe eval-harness invariants (no LLM call): the rubric parses, every referenced tool exists and is
// READ-ONLY (Maxx chat only exposes read-only tools), every regex compiles, every question has at least one
// deterministic check, and the scorer behaves (violations sink the score; full parity maxes it).

const TOOL_NAMES = new Set(TOOL_DEFINITIONS.map((t) => t.name))
const WRITE = WRITE_TOOLS // already a ReadonlySet<string>

describe('golden-questions rubric — structural invariants', () => {
  it('has four adversarial media-buyer questions with unique ids', () => {
    expect(GOLDEN_QUESTIONS.length).toBe(4)
    expect(GOLDEN_QUESTIONS.map((q) => q.id)).toEqual([
      'q1-flagship-diagnosis',
      'q2-adset-optimized',
      'q3-creative-quality',
      'q4-optimization-goal-budget',
    ])
    expect(GOLDEN_QUESTIONS.map((q) => q.source)).toEqual([
      'owner',
      'curated',
      'curated',
      'curated',
    ])
    expect(GOLDEN_QUESTIONS[1].fallback_prompt).toBe(
      'Is my Warm retargeting ad set set up and optimized correctly? What would you change?',
    )
  })

  it('every required tool exists in TOOL_DEFINITIONS and is read-only', () => {
    for (const q of GOLDEN_QUESTIONS) {
      expect(q.required_tools.length, `${q.id} needs >=1 required tool`).toBeGreaterThan(0)
      expect(q.required_tool_groups.length, `${q.id} needs >=1 evidence group`).toBeGreaterThan(0)
      for (const t of q.required_tools) {
        expect(TOOL_NAMES.has(t), `${q.id}: unknown tool ${t}`).toBe(true)
        expect(WRITE.has(t), `${q.id}: ${t} is a write tool — chat can't call it`).toBe(false)
      }
      expect(q.required_tool_groups.flat()).toEqual(q.required_tools)
    }
  })

  it('every question has >=1 deterministic check and all regexes compile', () => {
    for (const q of GOLDEN_QUESTIONS) {
      expect(q.must_mention.length + q.must_not_claim.length, `${q.id}`).toBeGreaterThan(0)
      for (const c of [...q.must_mention, ...q.must_not_claim]) {
        expect(() => new RegExp(c.pattern, 'i'), `${q.id}: bad regex ${c.pattern}`).not.toThrow()
      }
      expect(q.fallback_prompt.length).toBeGreaterThan(10)
      expect(q.rubric.length).toBeGreaterThan(20)
    }
  })
})

describe('scoreAnswer', () => {
  const q = GOLDEN_QUESTIONS[0] // q1-flagship-diagnosis
  const requiredTools = [
    'diagnose_ad_performance',
    'get_reconciliation',
    'get_operating_mode',
    'get_recommendations',
  ]

  it('rewards full tool + mention coverage with no violations', () => {
    const answer = 'Reconciling GA4, Meta, and Acuity first: learning is a delivery state, not proof. Exact paid CPA is unavailable without the appointment-id join, and the measurement definition broke on July 20. Hold scale until the evidence and governed recommendation support that decision.'
    const s = scoreAnswer(q, answer, requiredTools)
    expect(s.tool_coverage).toBe(1)
    expect(s.violations).toEqual([])
    expect(s.score).toBeGreaterThan(0.9)
  })

  it('a must-not-claim violation sinks the score below pass', () => {
    const answer = 'Reconciling GA4, Meta, and Acuity: learning is a delivery state, exact paid CPA is unavailable, and there was a measurement definition break. Hold scale until the evidence supports a decision. Meta proved it generated the bookings.'
    const s = scoreAnswer(q, answer, requiredTools)
    expect(s.violations.length).toBe(1)
    expect(s.score).toBeLessThan(0.7)
  })

  it('does NOT flag a NEGATED trap — the correct advice must not false-fail', () => {
    // The rubric asks the model to say exactly this; it must not count as a violation.
    const answer = 'Reconciling GA4, Meta, and Acuity: learning is a delivery state, not proof. Exact paid CPA is unavailable without the appointment-id join, and the measurement definition broke. Hold scale until the evidence supports a decision. Meta did NOT prove it generated bookings.'
    const s = scoreAnswer(q, answer, requiredTools)
    expect(s.violations).toEqual([])
    expect(s.score).toBeGreaterThan(0.9)
  })

  it('skipping every required tool caps the score via the tool gate', () => {
    const answer = 'Reconcile GA4, Meta, and Acuity. Learning is a delivery state, exact paid CPA is unavailable, and the measurement definition broke.'
    const s = scoreAnswer(q, answer, [])
    expect(s.tool_coverage).toBe(0)
    expect(s.score).toBeLessThanOrEqual(0.5)
  })
})
