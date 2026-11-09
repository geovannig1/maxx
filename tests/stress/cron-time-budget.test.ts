import { describe, it, expect } from 'vitest'
import {
  budgetExceeded,
  withTimeout,
  CRON_MAX_MS,
  CRON_CRITICAL_RESERVE_MS,
} from '@/lib/cron/time-budget'

// The nightly cron's LLM-heavy enrichment steps must yield the function budget to the
// critical brain tail. These lock the guard math + the timeout wrapper that bound those steps.

describe('budgetExceeded', () => {
  const start = 1_000_000

  it('is false at the very start of the run', () => {
    expect(budgetExceeded(start, start)).toBe(false)
  })

  it('is false while more than the reserve remains', () => {
    // elapsed = 200s; cap 300s, reserve 90s ⇒ threshold 210s ⇒ still allowed
    expect(budgetExceeded(start, start + 200_000)).toBe(false)
  })

  it('flips to true once less than the reserve remains', () => {
    // elapsed = 211s > (300 - 90) = 210s ⇒ skip further optional work
    expect(budgetExceeded(start, start + 211_000)).toBe(true)
  })

  it('uses the exact cap/reserve boundary', () => {
    const threshold = CRON_MAX_MS - CRON_CRITICAL_RESERVE_MS // 210_000
    expect(budgetExceeded(start, start + threshold)).toBe(false) // not strictly greater
    expect(budgetExceeded(start, start + threshold + 1)).toBe(true)
  })

  it('honors custom reserve/cap overrides', () => {
    // cap 60s, reserve 20s ⇒ threshold 40s
    expect(budgetExceeded(start, start + 39_000, 20_000, 60_000)).toBe(false)
    expect(budgetExceeded(start, start + 41_000, 20_000, 60_000)).toBe(true)
  })

  it('guarantees at least the reserve remains whenever a step is allowed to start', () => {
    for (let elapsed = 0; elapsed <= CRON_MAX_MS; elapsed += 5_000) {
      if (!budgetExceeded(start, start + elapsed)) {
        expect(CRON_MAX_MS - elapsed).toBeGreaterThanOrEqual(CRON_CRITICAL_RESERVE_MS)
      }
    }
  })
})

describe('withTimeout', () => {
  it('resolves with the value when the promise wins the race', async () => {
    await expect(withTimeout(Promise.resolve(42), 50, 'fast')).resolves.toBe(42)
  })

  it('rejects with a labeled error when the promise is too slow', async () => {
    const slow = new Promise<number>((res) => setTimeout(() => res(1), 40))
    await expect(withTimeout(slow, 5, 'slow-op')).rejects.toThrow(/slow-op timed out after 5ms/)
  })

  it('propagates the underlying rejection (not masked by the timeout)', async () => {
    const boom = Promise.reject(new Error('provider 500'))
    await expect(withTimeout(boom, 1000, 'llm')).rejects.toThrow('provider 500')
  })
})
