import { describe, expect, it } from 'vitest'
import {
  maxxEvidenceReadsHealthy,
  maxxTrialPasses,
  redactPrivateDecisionCopyForJudge,
  runMaxxGovernancePreflight,
} from '@/lib/eval/maxx-governance'
import { loadPinnedQuestionFixture } from '@/lib/eval/pinned-questions'
import { GOLDEN_QUESTIONS } from '@/lib/eval/golden-questions'

describe('Maxx evaluation governance preflight', () => {
  it('covers prompt injection, forged references, unavailable contradictions, semantic action claims, and field smuggling', () => {
    expect(runMaxxGovernancePreflight()).toEqual([
      expect.objectContaining({ id: 'prompt-injection', passed: true }),
      expect.objectContaining({ id: 'forged-claim-reference', passed: true }),
      expect.objectContaining({ id: 'unavailable-contradiction', passed: true }),
      expect.objectContaining({ id: 'semantic-action-claim', passed: true }),
      expect.objectContaining({ id: 'claim-field-smuggling', passed: true }),
    ])
  })

  it('accepts exactly one versioned owner question and rejects curated-question substitution', () => {
    const fixture = loadPinnedQuestionFixture(JSON.stringify({
      fixture_version: 2,
      owner_question: {
        id: 'q1-flagship-diagnosis',
        prompt: 'Private owner audit prompt',
      },
    }), GOLDEN_QUESTIONS)
    expect(fixture).toEqual({ 'q1-flagship-diagnosis': 'Private owner audit prompt' })

    expect(() => loadPinnedQuestionFixture(JSON.stringify({
      fixture_version: 2,
      owner_question: {
        id: 'q2-adset-optimized',
        prompt: 'A curated scenario disguised as owner text',
      },
    }), GOLDEN_QUESTIONS)).toThrow(/owner question/i)

    expect(() => loadPinnedQuestionFixture(JSON.stringify({
      fixture_version: 1,
      questions: Object.fromEntries(GOLDEN_QUESTIONS.map((question) => [question.id, `Pinned ${question.id}`])),
    }), GOLDEN_QUESTIONS)).toThrow()
  })

  it.each([
    { toolCoverage: 1, violations: [], briefAdmissible: true, evidenceReadHealthy: true, expected: true },
    { toolCoverage: 1, violations: [], briefAdmissible: true, evidenceReadHealthy: false, expected: false },
    { toolCoverage: 0, violations: [], briefAdmissible: true, evidenceReadHealthy: true, expected: false },
    { toolCoverage: 1, violations: ['forbidden claim'], briefAdmissible: true, evidenceReadHealthy: true, expected: false },
    { toolCoverage: 1, violations: [], briefAdmissible: false, evidenceReadHealthy: true, expected: false },
    { toolCoverage: 0, violations: ['forbidden claim'], briefAdmissible: true, evidenceReadHealthy: true, expected: false },
    { toolCoverage: 0, violations: [], briefAdmissible: false, evidenceReadHealthy: true, expected: false },
    { toolCoverage: 1, violations: ['forbidden claim'], briefAdmissible: false, evidenceReadHealthy: true, expected: false },
    { toolCoverage: 0, violations: ['forbidden claim'], briefAdmissible: false, evidenceReadHealthy: true, expected: false },
  ])('requires every trial gate: $toolCoverage/$violations/$briefAdmissible/$evidenceReadHealthy', (input) => {
    expect(maxxTrialPasses({
      toolCoverage: input.toolCoverage,
      violations: input.violations,
      briefAdmissible: input.briefAdmissible,
      evidenceReadHealthy: input.evidenceReadHealthy,
    })).toBe(input.expected)
  })

  it('scores explicit evidence groups without accepting a partial route', () => {
    const owner = GOLDEN_QUESTIONS.find((question) => question.id === 'q1-flagship-diagnosis')!
    expect(owner.required_tool_groups).toBeDefined()

    const complete = [...owner.required_tools]
    const partial = complete.slice(0, -1)
    expect(owner.required_tool_groups.every((group) => group.some((tool) => complete.includes(tool))))
      .toBe(true)
    expect(owner.required_tool_groups.every((group) => group.some((tool) => partial.includes(tool))))
      .toBe(false)
  })

  it('fails read health on an empty or top-level unavailable lookup but permits honest partial planes', () => {
    expect(maxxEvidenceReadsHealthy([])).toBe(false)
    expect(maxxEvidenceReadsHealthy([{ availability: 'returned' }, { availability: 'partial' }]))
      .toBe(true)
    expect(maxxEvidenceReadsHealthy([{ availability: 'returned' }, { availability: 'unavailable' }]))
      .toBe(false)
  })

  it('removes every private decision copy before an answer reaches the optional judge', () => {
    const answer = [
      'Evidence is bounded.',
      'Short copy Persisted final ActionDecision: decision-1.',
      'A longer private owner instruction Persisted final ActionDecision: decision-2.',
    ].join('\n')
    const redacted = redactPrivateDecisionCopyForJudge(answer, [
      { owner_copy: 'Short copy' },
      { owner_copy: 'A longer private owner instruction' },
    ])
    expect(redacted).not.toContain('Short copy')
    expect(redacted).not.toContain('A longer private owner instruction')
    expect(redacted.match(/\[private owner decision copy redacted\]/g)).toHaveLength(2)
    expect(redacted).toContain('Persisted final ActionDecision: decision-1.')
  })
})
