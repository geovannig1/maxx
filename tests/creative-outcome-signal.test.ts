import { describe, it, expect } from 'vitest'
import { hookHoldPct, creativeSignalNote } from '@/lib/learning/outcomes'

// creative_refresh outcomes now carry a "hook X%→Y%, hold A%→B%" context line comparing the
// pre-flag window to the post-flag window, so "did the refresh recover the hook?" is visible next to the
// CPA verdict. It is CONTEXT — it never changes the money-based worked/failed call.

describe('hookHoldPct', () => {
  it('computes hook% (p25/impressions) and hold% (thruplays/p25)', () => {
    expect(hookHoldPct(10000, 1500, 600)).toEqual({ hook: 15, hold: 40 })
  })
  it('returns null for missing video delivery (no impressions or no p25)', () => {
    expect(hookHoldPct(0, 0, 0)).toEqual({ hook: null, hold: null })
    expect(hookHoldPct(10000, 0, 0)).toEqual({ hook: null, hold: null })
  })
})

describe('creativeSignalNote', () => {
  it('renders a pre→post hook/hold delta when both windows have video data', () => {
    const note = creativeSignalNote(
      { impressions: 10000, p25: 1000, thruplays: 300 }, // hook 10%, hold 30%
      { impressions: 10000, p25: 1500, thruplays: 600 }  // hook 15%, hold 40%
    )
    expect(note).toContain('hook 10.0%→15.0%')
    expect(note).toContain('hold 30.0%→40.0%')
    expect(note).toMatch(/context, not the verdict/i)
  })

  it('is empty (no noise) when there is no video data in either window', () => {
    expect(creativeSignalNote({ impressions: 5000, p25: 0, thruplays: 0 }, { impressions: 5000, p25: 0, thruplays: 0 })).toBe('')
  })
})
