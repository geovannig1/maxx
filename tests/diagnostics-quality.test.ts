import { describe, it, expect } from 'vitest'
import { isRatedRanking, normalizeRanking, rankingInfo, qualityVerdict, rollupTier } from '@/lib/diagnostics/rankings'
import { computeDeliveryDiagnostic } from '@/lib/diagnostics/opportunity'
import { computeTrust } from '@/lib/trust/trust'

const verifiedTrust = computeTrust({ spend: 600, bookings: 12, windowDays: 14, dataAgeHours: 5, sourceOfTruth: 'exact_paid_appointment_join', revenueClaim: true, attributionCoverage: 0.95, exitedLearning: true, trendStable: true, dataSourcesCount: 2 })
const thinTrust = computeTrust({ spend: 5, bookings: 0, windowDays: 1, revenueClaim: true })

describe('rankings', () => {
  it('collapses below_average gradations and normalizes', () => {
    expect(normalizeRanking('above_average')).toBe('above_average')
    expect(normalizeRanking('below_average_10')).toBe('below_average')
    expect(normalizeRanking('below_average_35')).toBe('below_average')
    expect(normalizeRanking('average')).toBe('average')
    expect(normalizeRanking(null)).toBe('unknown')
    expect(normalizeRanking('UNKNOWN')).toBe('unknown')
  })
  it('does not count UNKNOWN or unrecognized Meta values as rated', () => {
    expect(isRatedRanking('above_average')).toBe(true)
    expect(isRatedRanking('UNKNOWN')).toBe(false)
    expect(isRatedRanking('unrated')).toBe(false)
    expect(isRatedRanking(null)).toBe(false)
  })
  it('assigns tone', () => {
    expect(rankingInfo('above_average').tone).toBe('good')
    expect(rankingInfo('below_average_20').tone).toBe('bad')
    expect(rankingInfo('average').tone).toBe('neutral')
  })
  it('summarizes a verdict across the three rankings', () => {
    expect(qualityVerdict({ quality: 'above_average', engagement: 'above_average', conversion: 'average' })).toBe('strong')
    expect(qualityVerdict({ quality: 'below_average_10', engagement: 'below_average_20', conversion: 'average' })).toBe('weak')
    expect(qualityVerdict({ quality: 'below_average_10', engagement: 'average', conversion: 'above_average' })).toBe('ok')
    expect(qualityVerdict({ quality: null, engagement: null, conversion: null })).toBe('unrated')
  })
  it('rolls an ad set up to its worst ad tier (promoted from the quality route into rankings.ts)', () => {
    expect(rollupTier(['above_average', 'below_average'])).toBe('below_average')
    expect(rollupTier(['above_average', 'average'])).toBe('above_average')
    expect(rollupTier(['average', 'unknown'])).toBe('average')
    expect(rollupTier([])).toBe('unknown')
  })
})

describe('computeDeliveryDiagnostic — delivery/auction evidence only', () => {
  it('describes available auction evidence without authorizing an action', () => {
    const diagnostic = computeDeliveryDiagnostic({
      pacing: { status: 'on', pct: 100 }, frequency: 1.8,
      qualityTier: 'above_average', trust: verifiedTrust,
    })
    expect(diagnostic.status).toBe('evidence_available')
    expect(diagnostic.summary).toMatch(/delivery|auction/i)
    expect(diagnostic.action_authority).toEqual({
      tier: 'diagnostic_only',
      prescriptions: [],
      reason_code: 'auction_delivery_evidence_only',
    })
    expect(JSON.stringify(diagnostic)).not.toMatch(/scale|hold|increase budget|decrease budget/i)
  })

  it('reports insufficient evidence when trust is below the bar', () => {
    const diagnostic = computeDeliveryDiagnostic({ pacing: { status: 'under', pct: 50 }, frequency: 1.8, qualityTier: 'above_average', trust: thinTrust })
    expect(diagnostic.status).toBe('insufficient_evidence')
    expect(diagnostic.summary).toMatch(/insufficient/i)
  })

  it('reports a notable delivery observation without a corrective instruction', () => {
    const diagnostic = computeDeliveryDiagnostic({
      pacing: { status: 'under', pct: 45 },
      frequency: 4.2, qualityTier: 'below_average', trust: verifiedTrust,
    })
    expect(diagnostic.status).toBe('notable_observation')
    expect(diagnostic.summary).toMatch(/notable/i)
    expect(JSON.stringify(diagnostic)).not.toMatch(/fix|pause|scale|budget (?:up|down)|increase|decrease/i)
  })

  it('marks unavailable signals explicitly', () => {
    const diagnostic = computeDeliveryDiagnostic({ frequency: null, trust: verifiedTrust })
    expect(diagnostic.signals.find((s) => s.key === 'frequency')?.state).toBe('unavailable')
  })

  it('keeps high-trust engagement evidence visible without pretending it clears action authority', () => {
    const deliveryTrust = computeTrust({
      spend: 600, clicks: 500, impressions: 20_000, windowDays: 14,
      dataAgeHours: 5, revenueClaim: false, dataSourcesCount: 1,
    })
    expect(deliveryTrust.meetsBar).toBe(false) // engagement-only evidence is correctly capped below 95

    const diagnostic = computeDeliveryDiagnostic({
      pacing: { status: 'on', pct: 100 }, frequency: 1.8,
      qualityTier: 'average', trust: deliveryTrust,
    })
    expect(diagnostic.status).toBe('evidence_available')
    expect(diagnostic.action_authority.prescriptions).toEqual([])
  })
})
