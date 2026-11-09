import { describe, it, expect } from 'vitest'
import { checkZeroConversions } from '@/lib/alerts/thresholds'

// The old checkZeroLeads fired "Spending with zero leads" every day on this bookings-optimized account
// (leads ≡ 0 structurally) and on learning-phase campaigns that never convert. checkZeroConversions only
// fires when the campaign NORMALLY produces the conversion (baseline > 0) but today produced zero.

describe('checkZeroConversions', () => {
  it('does NOT fire when the metric is structurally zero (baseline 0) — e.g. leads on a bookings account', () => {
    expect(checkZeroConversions({ todayConversions: 0, spend: 100, baselineConversions: 0 })).toBeNull()
  })

  it('does NOT fire for a learning-phase campaign that has never converted (baseline 0)', () => {
    expect(checkZeroConversions({ todayConversions: 0, spend: 50, baselineConversions: 0 })).toBeNull()
  })

  it('FIRES when a normally-converting campaign gets zero today on real spend', () => {
    expect(checkZeroConversions({ todayConversions: 0, spend: 100, baselineConversions: 4 })).toBe('warning')
  })

  it('does NOT fire when the campaign converted today', () => {
    expect(checkZeroConversions({ todayConversions: 1, spend: 100, baselineConversions: 4 })).toBeNull()
  })

  it('respects the min-spend floor (no alert on trivial spend)', () => {
    expect(checkZeroConversions({ todayConversions: 0, spend: 5, baselineConversions: 4 })).toBeNull()
  })
})

// ── The detector passes bookings+leads COMBINED as todayConversions, so a
// day that produced the "other" conversion type can never fire a false zero-alert. This test documents
// the combined-contract at the threshold level.
describe('checkZeroConversions — combined-today contract', () => {
  it('does NOT fire when today produced conversions of another type (combined > 0)', () => {
    // baseline dominant metric = bookings (3), today = 0 bookings but 15 leads → combined 15
    expect(checkZeroConversions({ todayConversions: 15, spend: 60, baselineConversions: 3 })).toBeNull()
  })
})
