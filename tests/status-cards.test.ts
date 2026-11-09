import './_support/outcome-noun-booking'
import { describe, it, expect } from 'vitest'
import { computeStatusCards, DIAGNOSTICS_ANCHORS, type StatusCard, type StatusCardsInput } from '@/lib/trust/status-cards'
import type { TrustScore, TrustLevel } from '@/lib/trust/trust'
import type { UtmCoverageStats } from '@/lib/tracking/utm-validator'

function card(cards: StatusCard[], key: StatusCard['key']): StatusCard {
  const c = cards.find((x) => x.key === key)
  if (!c) throw new Error(`missing card ${key}`)
  return c
}

function trust(level: TrustLevel, score: number): TrustScore {
  return { score, level, meetsBar: score >= 95, factors: [], ceilings: [], gaps: [], headline: `${level} (${score}%)` }
}

function utm(over: Partial<UtmCoverageStats>): UtmCoverageStats {
  return { adsTotal: 0, adsCorrect: 0, adsMissing: 0, adsMisconfigured: 0, adsUnverified: 0, coverage: null, ...over }
}

describe('computeStatusCards — tracking', () => {
  it('unknown when neither GA4 nor UTM is measured', () => {
    const c = card(computeStatusCards({}), 'tracking')
    expect(c.status).toBe('unknown')
    expect(c.headline).toMatch(/Not measured/)
  })
  it('watch when GA telemetry is unavailable because business totals are independently unaffected', () => {
    expect(card(computeStatusCards({ ga4Available: false }), 'tracking').status).toBe('watch')
  })
  it('watch when GA4 is up but no ad carries UTM tags', () => {
    const c = card(computeStatusCards({ ga4Available: true, utm: utm({ adsTotal: 3, adsMissing: 3, coverage: 0 }) }), 'tracking')
    expect(c.status).toBe('watch')
  })
  it('good when GA4 is reporting and every observed ad carries readable UTM fields — the paid limit stays stated', () => {
    const c = card(computeStatusCards({ ga4Available: true, utm: utm({ adsTotal: 4, adsCorrect: 4, coverage: 1 }) }), 'tracking')
    expect(c.status).toBe('good')
    expect(c.headline).toMatch(/Tracking is healthy/)
    expect(c.detail).toMatch(/never unlocks paid ROAS/i)
  })
  it('stays watch when only some observed ads are tagged', () => {
    const c = card(computeStatusCards({ ga4Available: true, utm: utm({ adsTotal: 4, adsCorrect: 3, adsMissing: 1, coverage: 0.75 }) }), 'tracking')
    expect(c.status).toBe('watch')
  })
  it('watch when GA4 is reporting because telemetry health is not a paid-tracking contract', () => {
    const c = card(computeStatusCards({ ga4Available: true }), 'tracking')
    expect(c.status).toBe('watch')
    expect(c.headline).toMatch(/CampaignPlan/)
    expect(c.href).toBe(`/diagnostics#${DIAGNOSTICS_ANCHORS.attribution}`)
  })
})

describe('computeStatusCards — attribution', () => {
  it('unknown when neither attributed share nor UTM coverage is present', () => {
    expect(card(computeStatusCards({}), 'attribution').status).toBe('unknown')
  })
  // Owner decision (2026-11): complete, healthy telemetry reads as healthy. The card still says it is
  // telemetry and never outcome authority; that limit moved from the headline to the detail.
  it('good when telemetry coverage clears the floor, still stating it is not outcome authority', () => {
    const c = card(computeStatusCards({ attributedShare: 0.7 }), 'attribution')
    expect(c.status).toBe('good')
    expect(c.headline).toMatch(/meeting the 50% goal/)
    expect(c.detail).toMatch(/diagnostic telemetry/i)
    expect(c.detail).toMatch(/never unlocks paid ROAS/i)
  })
  it('bad when attributed share is below the floor', () => {
    const c = card(computeStatusCards({ attributedShare: 0.2 }), 'attribution')
    expect(c.status).toBe('bad')
    expect(c.headline).toMatch(/diagnostic goal ≥ 50%/)
  })
  it('bad via low UTM coverage when share is unknown (headline quotes coverage)', () => {
    const c = card(computeStatusCards({ utm: utm({ adsTotal: 10, adsCorrect: 4, adsMissing: 6, coverage: 0.4 }) }), 'attribution')
    expect(c.status).toBe('bad')
    expect(c.headline).toMatch(/Readable UTM coverage is 40%/)
  })
  it('good when every ad carries tags, still stating coverage never unlocks paid ROAS', () => {
    const c = card(computeStatusCards({ utm: utm({ adsTotal: 5, adsCorrect: 5, coverage: 1 }) }), 'attribution')
    expect(c.status).toBe('good')
    expect(c.detail).toMatch(/never unlocks paid ROAS/i)
  })
})

describe('computeStatusCards — freshness', () => {
  it('unknown when neither age nor sync status is checked', () => {
    expect(card(computeStatusCards({}), 'freshness').status).toBe('unknown')
  })
  it('bad when the last sync failed', () => {
    expect(card(computeStatusCards({ latestSyncFailed: true }), 'freshness').status).toBe('bad')
  })
  it('bad when there is no successful sync (age null)', () => {
    expect(card(computeStatusCards({ dataAgeHours: null }), 'freshness').status).toBe('bad')
  })
  it('watch when data is past the 26-hour bar', () => {
    const c = card(computeStatusCards({ dataAgeHours: 40, latestSyncFailed: false }), 'freshness')
    expect(c.status).toBe('watch')
    expect(c.headline).toMatch(/26-hour/)
  })
  it('good when data synced recently', () => {
    const c = card(computeStatusCards({ dataAgeHours: 3, latestSyncFailed: false }), 'freshness')
    expect(c.status).toBe('good')
    expect(c.headline).toBe('Data synced 3h ago.')
    expect(c.href).toBe(`/diagnostics#${DIAGNOSTICS_ANCHORS.reconciliation}`)
  })
})

describe('computeStatusCards — outcome authority', () => {
  it('unknown when no trust score is supplied', () => {
    expect(card(computeStatusCards({}), 'roas_trust').status).toBe('unknown')
  })
  it('reports ledger-backed business totals without relabelling blended MER as paid ROAS', () => {
    const c = card(computeStatusCards({ trust: trust('high', 82), outcomeBasis: 'business_total' }), 'roas_trust')
    expect(c.status).toBe('good')
    expect(c.label).toBe('Business totals')
    expect(c.headline).toBe('Ledger business totals are trustworthy (82/100).')
    expect(c.detail).toContain('high (82%)')
    expect(c.detail).toContain('blended MER')
    expect(c.href).toBe('/diagnostics')
  })
  it('never turns telemetry-only evidence into a paid-money trust score', () => {
    const c = card(computeStatusCards({ trust: trust('high', 82), outcomeBasis: 'telemetry_only' }), 'roas_trust')
    expect(c.status).toBe('bad')
    expect(c.label).toBe('Paid outcome authority')
    expect(c.headline).toMatch(/unavailable/i)
    expect(c.detail).toMatch(/exact booking-id join/i)
  })
  it('scores an exact paid outcome only when explicitly identified as exact', () => {
    expect(card(computeStatusCards({ trust: trust('moderate', 68), outcomeBasis: 'exact_paid' }), 'roas_trust').status).toBe('watch')
    expect(card(computeStatusCards({ trust: trust('low', 30), outcomeBasis: 'exact_paid' }), 'roas_trust').status).toBe('bad')
  })
})

describe('computeStatusCards — single vocabulary across surfaces', () => {
  it('a dashboard-shaped input and a diagnostics-shaped input for the SAME state produce identical cards', () => {
    // One underlying account state.
    const state = {
      ga4: true,
      coverage: utm({ adsTotal: 10, adsCorrect: 4, adsMissing: 6, coverage: 0.4 }),
      attributedShare: 0.3,
      ageHours: 5,
      syncFailed: false,
      trust: trust('moderate', 70),
    }
    // The dashboard assembles the card input from what it computes.
    const dashboardInput: StatusCardsInput = {
      ga4Available: state.ga4,
      utm: state.coverage,
      attributedShare: state.attributedShare,
      dataAgeHours: state.ageHours,
      latestSyncFailed: state.syncFailed,
      trust: state.trust,
      outcomeBasis: 'telemetry_only',
    }
    // Diagnostics has the same state plus benign reconciliation context (aligned adds no caveat).
    const diagnosticsInput: StatusCardsInput = {
      ...dashboardInput,
      integrityStatus: 'aligned',
      moneyDirection: 'aligned',
    }
    expect(computeStatusCards(diagnosticsInput)).toEqual(computeStatusCards(dashboardInput))
  })
})
