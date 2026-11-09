import { describe, it, expect } from 'vitest'
import { CHAMPION_BENCHMARK, championVerdict } from '@/lib/economics/champion'
import { buildProfitView, proposeCpaBands } from '@/lib/economics/model'
import { retargetingShareOfSpend, auctionOverlapInference } from '@/lib/diagnostics/structure'

// champion benchmark, profit model (unknown-margin honesty), structure checks.

describe('historical champion audit comparison', () => {
  it('boundaries: ≤0.9× beats · ±10% matches · >1.1× worse', () => {
    const bar = CHAMPION_BENCHMARK.lifetime_cpa // 30 (example baseline)
    expect(championVerdict(bar * 0.85, 5).verdict).toBe('beats')
    expect(championVerdict(bar, 5).verdict).toBe('matches')
    expect(championVerdict(bar * 1.09, 5).verdict).toBe('matches')
    expect(championVerdict(bar * 1.3, 5).verdict).toBe('worse')
  })

  it('small samples are unproven — never a confident verdict', () => {
    expect(championVerdict(30, 1).verdict).toBe('unproven')
    expect(championVerdict(null, 0).verdict).toBe('unproven')
    expect(championVerdict(200, 2).verdict).toBe('unproven') // even a bad-looking CPA on 2 bookings
  })

  it('the benchmark carries wear observations without claiming a proven cause', () => {
    expect(CHAMPION_BENCHMARK.death_cause).toBe('unproven')
    expect(CHAMPION_BENCHMARK.death_signals.peak_frequency).toBe(4.5)
    expect(CHAMPION_BENCHMARK.lifetime_cpa).toBe(30)
  })

  it('always labels the comparison as historical and non-authoritative', () => {
    expect(championVerdict(30, 10)).toMatchObject({
      context_status: 'historical_audit_only', action_authority: 'none',
    })
  })
})

describe('buildProfitView — unknown-margin honesty', () => {
  it('degrades gracefully while margin is unknown: breakeven null + labeled assumption', () => {
    const v = buildProfitView({
      cpa: 60,
      bookings: 5,
      inputs: { aov: 250, gross_margin_rate: null, repeat_rate: null, source_note: 'Owner estimate' },
    })
    expect(v.breakeven_cpa).toBeNull()
    expect(v.contribution_per_booking).toBeNull()
    expect(v.assumptions.join(' ')).toMatch(/BREAKEVEN UNKNOWN/i)
    expect(v.read).toMatch(/UNKNOWN/i)
    expect(v.cpa_share_of_aov).toBeCloseTo(60 / 250, 3)
    expect(v).not.toHaveProperty('champion')
  })

  it('activates breakeven math when the owner supplies margin (+ conservative repeat default)', () => {
    const v = buildProfitView({ cpa: 60, bookings: 6, inputs: { aov: 250, gross_margin_rate: 0.8, repeat_rate: null, source_note: 'Owner estimate' } })
    expect(v.contribution_per_booking).toBe(200) // 250 × 0.8 × (1+0)
    expect(v.breakeven_cpa).toBe(200)
    expect(v.profit_per_booking).toBe(140)
    expect(v.assumptions.join(' ')).toMatch(/Repeat rate unknown/i)
  })

  it('includes repeat rate when supplied', () => {
    const v = buildProfitView({ cpa: 50, bookings: 6, inputs: { aov: 250, gross_margin_rate: 0.8, repeat_rate: 0.5, source_note: 'Owner estimate' } })
    expect(v.contribution_per_booking).toBe(300) // 250 × 0.8 × 1.5
    expect(v.profit_per_booking).toBe(250)
  })
})

describe('proposeCpaBands', () => {
  it('returns null while margin unknown (never proposes from invented numbers)', () => {
    expect(proposeCpaBands({ aov: 250, gross_margin_rate: null, repeat_rate: null, source_note: 'Owner estimate' })).toBeNull()
  })
  it('proposes ordered bands from explicit breakeven inputs, labeled PROPOSAL', () => {
    const bands = proposeCpaBands({ aov: 250, gross_margin_rate: 0.8, repeat_rate: 0, source_note: 'test' })!
    expect(bands.excellent).toBeLessThanOrEqual(bands.healthy)
    expect(bands.healthy).toBeLessThanOrEqual(bands.watch)
    expect(bands.rationale).toMatch(/PROPOSAL ONLY/)
    expect(bands.rationale).not.toMatch(/champion/i)
  })
})

describe('structure checks', () => {
  // The share is computed from RESOLVED targeting composition, never from the ad set name.
  it('retargeting share: reports the observed split without applying a universal norm', () => {
    const r = retargetingShareOfSpend([
      { name: 'Cold Broad | Advantage+ | $40 (7-day)', audience_type: null, spend: 83, composition: 'broad_advantage' },
      { name: 'Warm Engagers | Retargeting | $45 (7-day)', audience_type: null, spend: 171, composition: 'retargeting_only' },
    ])
    expect(r.share).toBeCloseTo(171 / 254, 2)
    expect(r.band).toBe('observed')
    expect(r.norm).toBeNull()
    expect(r.detail).toMatch(/No universal allocation benchmark/i)
    expect(r.action_authority).toBe('diagnostic_only')
    expect(r.prescriptions).toEqual([])
    expect(r.detail).not.toMatch(/champion|rebalance|consolidate|scale|cut|pause/i)
  })

  it('a NAME saying "Warm/Retargeting" cannot produce a share when the targeting resolves to MIXED', () => {
    // A realistic case: the set is named Warm/Retargeting but actually combines retargeting
    // audiences, lookalikes and Advantage expansion. A share computed from the name would assert
    // something about inventory that has not been established.
    const r = retargetingShareOfSpend([
      { name: 'Cold Broad | Advantage+', audience_type: null, spend: 83, composition: 'broad_advantage' },
      { name: 'Warm Engagers | Retargeting', audience_type: null, spend: 171, composition: 'mixed' },
    ])
    expect(r.share).toBeNull()
    expect(r.band).toBe('no_data')
    expect(r.detail).toMatch(/mixed or unresolved/)
    expect(r.detail).toMatch(/A share computed by NAME would be a claim about inventory that has not been established/)
  })

  it('UNRESOLVED composition (legacy caller, no targeting) also refuses to produce a share', () => {
    const r = retargetingShareOfSpend([
      { name: 'Cold A', audience_type: null, spend: 90 },
      { name: 'Warm Retargeting', audience_type: null, spend: 10 },
    ])
    expect(r.share).toBeNull()
    expect(r.band).toBe('no_data')
  })

  it('retargeting share: any resolved share is observational; empty input degrades to no_data', () => {
    expect(retargetingShareOfSpend([
      { name: 'Cold A', audience_type: null, spend: 90, composition: 'broad_advantage' },
      { name: 'Warm Retargeting', audience_type: null, spend: 10, composition: 'retargeting_only' },
    ]).band).toBe('observed')
    expect(retargetingShareOfSpend([]).band).toBe('no_data')
  })

  it('auction overlap: cold+warm coexisting → possible risk, ALWAYS labeled ASSUMPTION with owner check', () => {
    const o = auctionOverlapInference(['Cold Broad | Advantage+', 'Warm Engagers | Retargeting'])
    expect(o.risk).toBe('possible')
    expect(o.label).toBe('ASSUMPTION')
    expect(o.owner_check).toMatch(/overlap measurement is available/i)
    expect(o.detail).not.toMatch(/causing under-delivery|causing Learning Limited/i)
    expect(o.action_authority).toBe('diagnostic_only')
    expect(o.prescriptions).toEqual([])
    const solo = auctionOverlapInference(['Cold Broad | Advantage+'])
    expect(solo.risk).toBe('not_applicable')
  })
})
