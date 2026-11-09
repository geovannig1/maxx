import { describe, expect, it } from 'vitest'
import { cohensKappa } from '@/lib/eval/judge-agreement'

const pair = (judge: boolean, deterministic: boolean) => ({ judge, deterministic })

describe('cohensKappa', () => {
  it('is 1 when the judge matches the gates exactly and both vary', () => {
    expect(cohensKappa([pair(true, true), pair(false, false), pair(true, true), pair(false, false)]).kappa).toBe(1)
  })

  it('is about 0 for a judge that agrees only as often as chance', () => {
    // Judge passes half the time, gates pass half the time, and the overlap is exactly what
    // independence predicts — the degenerate case raw agreement would score 0.5 and flatter.
    const result = cohensKappa([pair(true, true), pair(true, false), pair(false, true), pair(false, false)])
    expect(result.rawAgreement).toBe(0.5)
    expect(result.kappa).toBeCloseTo(0, 10)
  })

  it('is negative when the judge is worse than chance', () => {
    expect(cohensKappa([pair(true, false), pair(false, true), pair(true, false), pair(false, true)]).kappa).toBeLessThan(0)
  })

  it('scores a rubber-stamp judge at zero however high its raw agreement looks', () => {
    // The headline case. A judge that says "pass" every time agrees 90% of the time on a 90%-pass
    // suite, and raw agreement reports that as excellent. Kappa is the correction: chance agreement
    // is also 0.9, so the judge is shown to carry no information. Reported, not nulled — a rubber
    // stamp is a measured finding about the judge, not an undefined statistic.
    const rubberStamp = Array.from({ length: 10 }, (_, i) => pair(true, i < 9))
    const result = cohensKappa(rubberStamp)
    expect(result.rawAgreement).toBe(0.9)
    expect(result.kappa).toBe(0)
    expect(result.note).toBeNull()
  })

  it('returns null rather than 1 when both raters are constant and identical', () => {
    // Perfect agreement carrying zero information must not be reported as perfect agreement.
    const result = cohensKappa([pair(true, true), pair(true, true), pair(true, true)])
    expect(result.rawAgreement).toBe(1)
    expect(result.kappa).toBeNull()
  })

  it('handles an empty sample without dividing by zero', () => {
    expect(cohensKappa([])).toEqual({ kappa: null, rawAgreement: 0, n: 0, note: 'no trials to compare' })
  })
})
