import { describe, it, expect } from 'vitest'
import { assessRotationBench, type BenchAd } from '@/lib/diagnostics/rotation-bench'

// Reserve creatives exist with no rotation planned. But "you have 20 unused creatives" is
// noise unless rotation is actually indicated, and in this fixture it is NOT: peak frequency across
// every ACTIVE ad sits around 0.9-1.3, nowhere near the fatigue thresholds.
//
// So the bench is INVENTORY, and whether to draw from it is a separate, evidence-gated question.
// Two tiers matter, because they are not interchangeable:
//   • proven   — has delivered AND produced attributed results (e.g. "studio-tour-video-2": $383.25
//                lifetime, 7 attributed — the highest of any ad in the account, paused 47 days)
//   • untested — created and never delivered (e.g. "Cold | Walkthrough D | April 2026")

const ad = (over: Partial<BenchAd> & { name: string }): BenchAd => ({
  status: 'PAUSED',
  ever_delivered: false,
  lifetime_spend: null,
  attributed_results: null,
  days_since_delivery: null,
  ...over,
})

const ACTIVE = [
  ad({ name: 'Warm | Studio Reel A', status: 'ACTIVE', ever_delivered: true, lifetime_spend: 296.40, attributed_results: 3, days_since_delivery: 1 }),
]

describe('rotation bench', () => {
  it('separates proven reserve from never-delivered reserve', () => {
    const r = assessRotationBench({
      ads: [
        ...ACTIVE,
        ad({ name: 'studio-tour-video-2', ever_delivered: true, lifetime_spend: 383.25, attributed_results: 7, days_since_delivery: 47 }),
        ad({ name: 'Cold | Walkthrough D | April 2026' }),
        ad({ name: 'Studio Reel C' }),
      ],
      peakFrequency: 1.21,
    })

    expect(r.proven_reserve.map((a) => a.name)).toEqual(['studio-tour-video-2'])
    expect(r.untested_reserve.map((a) => a.name)).toEqual(['Cold | Walkthrough D | April 2026', 'Studio Reel C'])
    expect(r.active_count).toBe(1)
  })

  it('does NOT indicate rotation while frequency is low — absence of fatigue is the point', () => {
    const r = assessRotationBench({
      ads: [...ACTIVE, ad({ name: 'bench-1' })],
      peakFrequency: 1.21,
      fatigueEvidence: { observed: false, basis: 'Frequency is low and CTR is stable.' },
    })
    expect(r.rotation_indicated).toBe(false)
    expect(r.detail).toMatch(/frequency/i)
    expect(r.detail).not.toMatch(/rotate now|should rotate|refresh now/i)
  })

  it('indicates rotation only when fatigue evidence supports it, and still prescribes nothing', () => {
    const r = assessRotationBench({
      ads: [...ACTIVE, ad({ name: 'studio-tour-video-2', ever_delivered: true, lifetime_spend: 383.25, attributed_results: 7, days_since_delivery: 47 })],
      peakFrequency: 5.2,
      fatigueEvidence: { observed: true, basis: 'Frequency rose while CTR fell 25% from peak.' },
    })
    expect(r.rotation_indicated).toBe(true)
    expect(r.detail).toMatch(/1 proven/i)
    expect(r.action_authority).toBe('diagnostic_only')
    expect(r.prescriptions).toEqual([])
  })

  it('does not turn high frequency alone into a fatigue verdict', () => {
    const r = assessRotationBench({
      ads: [...ACTIVE, ad({ name: 'bench-1' })],
      peakFrequency: 5.2,
    })

    expect(r.rotation_indicated).toBeNull()
    expect(r.detail).toMatch(/frequency alone/i)
    expect(r.detail).not.toMatch(/fatigue is present/i)
  })

  it('unknown frequency yields null, never a guess in either direction', () => {
    const r = assessRotationBench({ ads: [...ACTIVE, ad({ name: 'bench-1' })], peakFrequency: null })
    expect(r.rotation_indicated).toBeNull()
    expect(r.detail).toMatch(/unknown|not available/i)
  })

  it('an empty bench is stated plainly — fatigue with nothing to rotate to is the real exposure', () => {
    const r = assessRotationBench({
      ads: ACTIVE,
      peakFrequency: 5.2,
      fatigueEvidence: { observed: true, basis: 'Frequency rose while CTR fell 25% from peak.' },
    })
    expect(r.proven_reserve).toEqual([])
    expect(r.untested_reserve).toEqual([])
    expect(r.detail).toMatch(/no reserve|bench is empty/i)
  })
})
