import { describe, it, expect } from 'vitest'
import { ATTRIBUTION_SETTLE_DAYS } from '@/lib/learning/outcomes'

// Frozen-window scorer: outcome scoring must wait for the post-window to attribution-SETTLE,
// not merely close. Conversions restate up to the 7d-click window and back-days only restate while
// inside the sync's rolling lookback — scoring at window-close reads undercounted bookings and mints
// false 'failed' lessons. Both scorers (flags + ledger) share the settle constant.

describe('outcome scoring — attribution settle window', () => {
  it('the settle window covers the 7d-click attribution restatement', () => {
    expect(ATTRIBUTION_SETTLE_DAYS).toBeGreaterThanOrEqual(7)
  })

  it('flag evalCutoff waits window + settle (source-level contract)', async () => {
    // The cutoff math lives inline in evaluateRecommendationOutcomes; pin the contract textually so a
    // revert to plain -EVAL_WINDOW_DAYS (scoring unsettled windows) fails this test.
    const fs = await import('fs')
    const src = fs.readFileSync('src/lib/learning/outcomes.ts', 'utf8')
    expect(src).toMatch(/evalCutoff = addDays\(today, -\(EVAL_WINDOW_DAYS \+ ATTRIBUTION_SETTLE_DAYS\)\)/)
  })

  it('ledger scoring waits for the window to settle too', async () => {
    const fs = await import('fs')
    const src = fs.readFileSync('src/lib/learning/ledger-outcomes.ts', 'utf8')
    expect(src).toMatch(/addDays\(windowEnd, ATTRIBUTION_SETTLE_DAYS\) > today/)
  })
})
