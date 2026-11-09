import { describe, it, expect } from 'vitest'
import { spendConcentration, type AdsetSpendSlice } from '@/lib/diagnostics/structure'

// "you have 4 ad sets, but effectively 1.3" is a portfolio fact the account has no read on.
//
// The trap: under CBO, concentration is Meta ALLOCATING CORRECTLY toward marginal efficiency.
// Calling that a defect would contradict the breakdown-effect doctrine. Under ABO the owner set
// the budgets, so concentration means the split does not match intent. Same number, opposite
// meaning — so budget control has to ride along with it, and neither case prescribes anything.

const slice = (name: string, spend: number): AdsetSpendSlice => ({ name, audience_type: null, spend })

describe('spend concentration', () => {
  it('reports the top share and how many ad sets the spend is EFFECTIVELY spread across', () => {
    // 90/10 across two: HHI = 0.81 + 0.01 = 0.82 → 1/0.82 ≈ 1.22
    const r = spendConcentration([slice('A', 90), slice('B', 10)], 'campaign')
    expect(r.total_spend).toBe(100)
    expect(r.top).toEqual({ name: 'A', spend: 90, share: 0.9 })
    expect(r.effective_entities).toBe(1.22)
  })

  it('an even split across four is effectively four', () => {
    const r = spendConcentration([slice('A', 25), slice('B', 25), slice('C', 25), slice('D', 25)], 'adset')
    expect(r.effective_entities).toBe(4)
    expect(r.top?.share).toBe(0.25)
  })

  it('under CBO, concentration is Meta allocating — never framed as a defect', () => {
    const r = spendConcentration([slice('A', 95), slice('B', 5)], 'campaign')
    expect(r.detail).toMatch(/campaign budget/i)
    expect(r.detail).toMatch(/expected|allocat/i)
    expect(r.detail).not.toMatch(/problem|wrong|fix|should be/i)
    expect(r.action_authority).toBe('diagnostic_only')
    expect(r.prescriptions).toEqual([])
  })

  it('under ABO, concentration means the OWNER-set split is not matching intent', () => {
    const r = spendConcentration([slice('A', 95), slice('B', 5)], 'adset')
    expect(r.detail).toMatch(/ad-set budget/i)
    // Still an observation — it reports the mismatch, it does not prescribe a reallocation.
    expect(r.prescriptions).toEqual([])
  })

  it('no spend → nulls, never a fabricated share', () => {
    const r = spendConcentration([slice('A', 0), slice('B', 0)], 'unknown')
    expect(r.top).toBeNull()
    expect(r.effective_entities).toBeNull()
    expect(r.detail).toMatch(/no spend/i)
  })

  it('a single delivering ad set is effectively one, and says so without alarm', () => {
    const r = spendConcentration([slice('Only', 500)], 'adset')
    expect(r.effective_entities).toBe(1)
    expect(r.top?.share).toBe(1)
  })
})
