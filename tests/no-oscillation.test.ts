import { describe, it, expect } from 'vitest'
import { checkNoOscillation } from '@/lib/recommendations/no-oscillation'

describe('checkNoOscillation', () => {
  const base = {
    window_days: 14,
    spend: 400,
    bookings: 8,
    days_since_last_change: 14,
    exited_learning: true,
    trend_stable: true,
    basis: 'observed_performance' as const,
  }

  it('does not apply to non-reversal recommendations', () => {
    const r = checkNoOscillation({ ...base, recommendation_type: 'launch_test' })
    expect(r.is_reversal_class).toBe(false)
    expect(r.allowed).toBe(true)
  })

  it('allows a fully grounded reversal (scale)', () => {
    const r = checkNoOscillation({ ...base, recommendation_type: 'scale' })
    expect(r.is_reversal_class).toBe(true)
    expect(r.allowed).toBe(true)
    expect(r.blocking_factors).toHaveLength(0)
  })

  it('blocks reversing a change made too recently (oscillation)', () => {
    const r = checkNoOscillation({ ...base, recommendation_type: 'pause', days_since_last_change: 2, exited_learning: false })
    expect(r.allowed).toBe(false)
    expect(r.blocking_factors.join(' ')).toMatch(/2d ago|maturity/i)
  })

  it('reports learning separately and does not use it as a decision gate', () => {
    const inLearning = checkNoOscillation({ ...base, recommendation_type: 'scale', exited_learning: false })
    const exited = checkNoOscillation({ ...base, recommendation_type: 'scale', exited_learning: true })
    expect(inLearning).toEqual(exited)
  })

  it('blocks a reversal on a thin window / volume', () => {
    const r = checkNoOscillation({ ...base, recommendation_type: 'reduce_budget', window_days: 1, spend: 5, bookings: 0 })
    expect(r.allowed).toBe(false)
    expect(r.blocking_factors.length).toBeGreaterThanOrEqual(2)
  })

  it('blocks a reversal justified only by external best practice', () => {
    const r = checkNoOscillation({ ...base, recommendation_type: 'change_optimization_event', basis: 'external_best_practice' })
    expect(r.allowed).toBe(false)
    expect(r.blocking_factors.join(' ')).toMatch(/external best practice/)
  })

  it('blocks a reversal when the trend is not confirmed stable', () => {
    const r = checkNoOscillation({ ...base, recommendation_type: 'scale', trend_stable: null })
    expect(r.allowed).toBe(false)
    expect(r.blocking_factors.join(' ')).toMatch(/stable|volatility/)
  })
})
