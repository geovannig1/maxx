import { describe, it, expect } from 'vitest'
import { assessReallocationPairs, suggestReallocations, type EntityPerf } from '@/lib/recommendations/reallocation'

const loser: EntityPerf = { id: 'l', name: 'Cold LAL', level: 'adset', dailyBudget: 100, spend: 300, bookings: 0, cpa: null, flag: 'loser', trust: 80 }
const winner: EntityPerf = { id: 'w', name: 'Retargeting', level: 'adset', dailyBudget: 50, spend: 200, bookings: 6, cpa: 45, flag: 'winner', trust: 96 }

describe('reallocation authority — trust never substitutes for paid-outcome authority', () => {
  it('keeps a modelled loser/winner pair as diagnosis and emits no dollar move', () => {
    const assessed = assessReallocationPairs([loser, winner])
    expect(assessed).toHaveLength(1)
    expect(assessed[0].fromId).toBe('l')
    expect(assessed[0].toId).toBe('w')
    expect(assessed[0].cut.tier).toBe('diagnostic_only')
    expect(assessed[0].scale.tier).toBe('diagnostic_only')
    expect(suggestReallocations([loser, winner])).toHaveLength(0)
  })

  it('does not promote modelled evidence even when BOTH entities clear the 95 trust bar', () => {
    const pair = [{ ...loser, trust: 96 }, { ...winner, trust: 97 }]
    expect(assessReallocationPairs(pair)[0].trust).toBe(96)
    expect(suggestReallocations(pair)).toHaveLength(0)
  })

  it('recognizes a scale_candidate as a diagnostic destination', () => {
    const r = assessReallocationPairs([loser, { ...winner, flag: 'scale_candidate' }])
    expect(r).toHaveLength(1)
    expect(r[0].scale.tier).toBe('diagnostic_only')
  })

  it('suggests nothing without both a loser AND a winner', () => {
    expect(assessReallocationPairs([loser])).toHaveLength(0)
    expect(assessReallocationPairs([winner])).toHaveLength(0)
  })

  it('excludes entities below the minimum suggest-trust', () => {
    expect(assessReallocationPairs([{ ...loser, trust: 50 }, winner])).toHaveLength(0)
    expect(assessReallocationPairs([loser, { ...winner, trust: 50 }])).toHaveLength(0)
  })

  it('ignores a loser with no usable entity budget (CBO)', () => {
    expect(assessReallocationPairs([{ ...loser, dailyBudget: null }, winner])).toHaveLength(0)
  })
})
