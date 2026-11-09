import { describe, it, expect } from 'vitest'
import {
  signedPct,
  reconcileSpendIntegrity,
  reconcilePlaneConflict,
  reconcileBilledContext,
  reconciliationVariancePct,
} from '@/lib/diagnostics/reconcile'
import { attributionWindowLabel, ATTRIBUTION_WINDOW_LABEL, ACTION_ATTRIBUTION_WINDOWS } from '@/lib/platforms/meta/attribution'

describe('signedPct', () => {
  it('computes signed percent change', () => {
    expect(signedPct(110, 100)).toBeCloseTo(10)
    expect(signedPct(90, 100)).toBeCloseTo(-10)
  })
  it('returns null on a zero / missing reference', () => {
    expect(signedPct(100, 0)).toBeNull()
    expect(signedPct(null, 100)).toBeNull()
  })
})

describe('reconcileSpendIntegrity', () => {
  it('reports aligned when all three sources match', () => {
    const r = reconcileSpendIntegrity({ accountInsightsSpend: 1000, reportSpend: 1000, campaignInsightsSpend: 1000, days: 7 })
    expect(r.status).toBe('aligned')
    expect(r.worstVariancePct).toBeCloseTo(0)
  })
  it('flags minor drift around a few percent', () => {
    const r = reconcileSpendIntegrity({ accountInsightsSpend: 1000, reportSpend: 1030, campaignInsightsSpend: 1000, days: 7 })
    expect(r.status).toBe('minor_drift')
    expect(r.reportVariancePct).toBeCloseTo(3)
  })
  it('flags a mismatch on a large gap', () => {
    const r = reconcileSpendIntegrity({ accountInsightsSpend: 1000, reportSpend: 1200, campaignInsightsSpend: 1000, days: 7 })
    expect(r.status).toBe('mismatch')
    expect(r.worstVariancePct).toBeCloseTo(20)
  })
  it('is honest when there is no spend to reconcile', () => {
    const r = reconcileSpendIntegrity({ accountInsightsSpend: 0, reportSpend: 0, campaignInsightsSpend: 0, days: 7 })
    expect(r.note).toMatch(/nothing to reconcile/i)
  })

  it('reports UNKNOWN (never "aligned") when spend exists but nothing is synced to compare against', () => {
    const r = reconcileSpendIntegrity({ accountInsightsSpend: 500, reportSpend: null, campaignInsightsSpend: null, days: 7 })
    expect(r.status).toBe('unknown')
    expect(r.status).not.toBe('aligned')
    expect(r.note).toMatch(/UNVERIFIED|cross-check/i)
  })
})

describe('reconcilePlaneConflict — two ESTIMATES, neither of them business truth', () => {
  it('aligns when Meta estimate ≈ GA4 actual', () => {
    const r = reconcilePlaneConflict({ metaEstimatedValue: 1020, ga4PaidEventValue: 1000, metaBookings: 10, ga4Purchases: 10, attributionCoverage: 0.8 })
    expect(r.direction).toBe('aligned')
    expect(r.available).toBe(true)
  })
  it('detects Meta over-counting', () => {
    const r = reconcilePlaneConflict({ metaEstimatedValue: 1500, ga4PaidEventValue: 1000, metaBookings: 15, ga4Purchases: 10, attributionCoverage: 0.6 })
    expect(r.direction).toBe('meta_over')
    expect(r.variancePct).toBeCloseTo(50)
  })
  it('detects Meta under-counting', () => {
    const r = reconcilePlaneConflict({ metaEstimatedValue: 700, ga4PaidEventValue: 1000, metaBookings: 7, ga4Purchases: 10, attributionCoverage: 0.6 })
    expect(r.direction).toBe('meta_under')
  })
  it('refuses to reconcile without GA4 truth', () => {
    const r = reconcilePlaneConflict({ metaEstimatedValue: 1000, ga4PaidEventValue: null, metaBookings: 10, ga4Purchases: null, attributionCoverage: null })
    expect(r.available).toBe(false)
    expect(r.variancePct).toBeNull()
    // The note used to say "GA4 remains the source of truth". It does not: neither plane
    // has appointment identity, and business truth is the Acuity ledger.
    expect(r.note).toMatch(/NEITHER is business truth/i)
    expect(r.note).not.toMatch(/GA4? (remains|is) the source of truth/i)
  })

  it('compares paid-vs-paid: organic revenue is context only and does NOT distort the variance', () => {
    // Meta paid 1000 vs GA4 paid 1000 = aligned, even though organic revenue is 5× larger. Comparing
    // Meta paid against GA4 TOTAL (1000 + 5000) would falsely read as Meta under-counting ~83%.
    const r = reconcilePlaneConflict({ metaEstimatedValue: 1000, ga4PaidEventValue: 1000, metaBookings: 10, ga4Purchases: 10, attributionCoverage: 0.8, ga4OrganicEventValue: 5000 })
    expect(r.direction).toBe('aligned')
    expect(r.ga4OrganicEventValue).toBe(5000)
  })
})

describe('reconcileBilledContext', () => {
  it('computes lifetime coverage without alarming', () => {
    const r = reconcileBilledContext({ lifetimeBilled: 10000, lifetimeTracked: 3000, spendCap: 50000 })
    expect(r.coveragePct).toBeCloseTo(30)
    expect(r.note).toMatch(/coverage gauge, not a discrepancy/i)
  })
  it('handles a missing lifetime billed figure', () => {
    const r = reconcileBilledContext({ lifetimeBilled: null, lifetimeTracked: 3000, spendCap: null })
    expect(r.coveragePct).toBeNull()
  })
})

describe('reconciliationVariancePct', () => {
  it('takes the worst disagreement across integrity and money checks', () => {
    const integrity = reconcileSpendIntegrity({ accountInsightsSpend: 1000, reportSpend: 1030, campaignInsightsSpend: 1000, days: 7 })
    const money = reconcilePlaneConflict({ metaEstimatedValue: 1500, ga4PaidEventValue: 1000, metaBookings: 15, ga4Purchases: 10, attributionCoverage: 0.6 })
    expect(reconciliationVariancePct(integrity, money)).toBeCloseTo(50)
  })

  it('is NULL when nothing could be compared — no fabricated 0% agreement fed to the Trust Engine', () => {
    const integrity = reconcileSpendIntegrity({ accountInsightsSpend: 500, reportSpend: null, campaignInsightsSpend: null, days: 7 })
    const money = reconcilePlaneConflict({ metaEstimatedValue: null, ga4PaidEventValue: null, metaBookings: null, ga4Purchases: null, attributionCoverage: null })
    expect(reconciliationVariancePct(integrity, money)).toBeNull()
  })
})

describe('attribution window label is centralized and never drifts', () => {
  it('humanizes the window codes', () => {
    expect(attributionWindowLabel(['7d_click', '1d_view'])).toBe('7-day click / 1-day view')
    expect(ATTRIBUTION_WINDOW_LABEL).toBe('7-day click / 1-day view')
  })
  it('serializes the exact JSON the Graph API expects', () => {
    expect(ACTION_ATTRIBUTION_WINDOWS).toBe('["7d_click","1d_view"]')
  })
})
