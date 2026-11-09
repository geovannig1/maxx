import { describe, expect, it } from 'vitest'
import { summarizeReliability } from '@/lib/eval/reliability'

describe('eval reliability metrics', () => {
  it('requires every deterministic trial for pass-to-k', () => {
    expect(summarizeReliability([
      [true, true, true],
      [true, true, false],
    ])).toMatchObject({
      passAtKRate: 1,
      passToKRate: 0.5,
      passedAtLeastOnce: 2,
      passedEveryTrial: 1,
    })
  })

  it('computes scenario pass-at-three across questions', () => {
    const trials = Array.from({ length: 10 }, (_, index) =>
      index === 9 ? [false, false, false] : [false, true, false],
    )
    expect(summarizeReliability(trials)).toMatchObject({
      k: 3,
      total: 10,
      passAtKRate: 0.9,
      passToKRate: 0,
    })
  })

  it('fails closed for missing trials or inconsistent trial counts', () => {
    expect(() => summarizeReliability([])).toThrow(/scenario/i)
    expect(() => summarizeReliability([[true], []])).toThrow(/trial/i)
    expect(() => summarizeReliability([[true], [true, false]])).toThrow(/same number/i)
  })
})
