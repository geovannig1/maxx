import { describe, it, expect } from 'vitest'
import { evaluateExperiment } from '@/lib/recommendations/experiment-registry'

// The PRE-COMMITTED success contract is applied by code, not by whoever reads the numbers
// afterwards. Below either floor the result is INCONCLUSIVE by definition — that is the whole point
// of committing a floor before the run.

const floors = { min_sample: 30, min_spend: 500 }
const obs = (over: Partial<Parameters<typeof evaluateExperiment>[1]> = {}) => ({
  controlSample: 40, challengerSample: 40, controlSpend: 600, challengerSpend: 600,
  controlMetric: 10, challengerMetric: 14, ...over,
})

describe('evaluateExperiment — floors decide before the metric does', () => {
  it('a challenger that wins above BOTH floors is a success', () => {
    const r = evaluateExperiment(floors, obs())
    expect(r.outcome).toBe('success')
    expect(r.belowFloor).toBe(false)
  })

  it('a challenger that loses above both floors is a failure', () => {
    expect(evaluateExperiment(floors, obs({ challengerMetric: 6 })).outcome).toBe('failure')
  })

  it('BELOW the sample floor is inconclusive even when the challenger "wins"', () => {
    const r = evaluateExperiment(floors, obs({ challengerSample: 5, challengerMetric: 99 }))
    expect(r.outcome).toBe('inconclusive')
    expect(r.belowFloor).toBe(true)
    expect(r.reason).toMatch(/inconclusive by definition, not a winner/)
  })

  it('BELOW the spend floor is inconclusive even when the challenger "wins"', () => {
    const r = evaluateExperiment(floors, obs({ challengerSpend: 10, challengerMetric: 99 }))
    expect(r.outcome).toBe('inconclusive')
    expect(r.belowFloor).toBe(true)
  })

  it('a CONTROL arm below a floor is equally disqualifying', () => {
    expect(evaluateExperiment(floors, obs({ controlSample: 1 })).outcome).toBe('inconclusive')
    expect(evaluateExperiment(floors, obs({ controlSpend: 1 })).outcome).toBe('inconclusive')
  })

  it('a breached guardrail aborts to inconclusive regardless of the numbers', () => {
    const r = evaluateExperiment(floors, obs({ challengerMetric: 99 }), { guardrailBreached: true })
    expect(r.outcome).toBe('inconclusive')
    expect(r.reason).toMatch(/guardrail aborted the run/)
  })

  it('a missing primary metric on either arm is inconclusive, never a win', () => {
    expect(evaluateExperiment(floors, obs({ challengerMetric: null })).outcome).toBe('inconclusive')
    expect(evaluateExperiment(floors, obs({ controlMetric: null })).outcome).toBe('inconclusive')
  })

  it('a tie is inconclusive, not a success', () => {
    expect(evaluateExperiment(floors, obs({ challengerMetric: 10 })).outcome).toBe('inconclusive')
  })

  it('zero floors cannot be cleared trivially by an empty arm', () => {
    // The DB forbids running with zero floors; this guards the pure function too.
    const r = evaluateExperiment({ min_sample: 0, min_spend: 0 }, obs({ controlSample: 0, challengerSample: 0, controlMetric: null, challengerMetric: null }))
    expect(r.outcome).toBe('inconclusive')
  })
})
