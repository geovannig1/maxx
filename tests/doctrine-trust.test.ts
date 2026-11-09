import './_support/outcome-noun-booking'
import { describe, it, expect } from 'vitest'
import { computeTrust } from '@/lib/trust/trust'
import { MAXX_INSTRUCTIONS } from '@/mcp/instructions'

// Residual coverage: the three-plane doctrine (brain) + the Acuity trust source.

describe('three-plane doctrine (instructions)', () => {
  it('MER is defined revenue ÷ spend, not the inverse', () => {
    // The active-only amount is distinct from settled/net revenue and remains amount_paid ÷ spend.
    expect(MAXX_INSTRUCTIONS).toMatch(/Blended active-booking amount\/spend ratio = amount_paid on active bookings ÷ ad spend/i)
    expect(MAXX_INSTRUCTIONS).toMatch(/amount_paid on active bookings/i)
    expect(MAXX_INSTRUCTIONS).toMatch(/Owner-excluded post-sale exception topics stay out of reporting for the business/i)
    expect(MAXX_INSTRUCTIONS).not.toMatch(/refund[^.\n]*cancel|cancel[^.\n]*refund/i)
    expect(MAXX_INSTRUCTIONS).not.toMatch(/MER[^\n]{0,20}spend ÷ (Acuity |booked )?(revenu|value)e/)
  })

  it('drops the strict "Acuity ≥ GA4 ≥ Meta by design" inequality', () => {
    expect(MAXX_INSTRUCTIONS).not.toMatch(/Acuity ≥ GA4 ≥ Meta by design/)
    // The replacement frames a gap as a reconciliation signal, not an impossibility.
    expect(MAXX_INSTRUCTIONS).toMatch(/RECONCILIATION SIGNAL/)
  })
})

describe('Acuity trust source', () => {
  const base = { spend: 500, bookings: 20, windowDays: 30, dataAgeHours: 2, revenueClaim: true, dataSourcesCount: 2 }

  it('outcome_actual scores as canonical (no meta-estimate penalty, attribution N/A)', () => {
    const acuity = computeTrust({ ...base, sourceOfTruth: 'outcome_business_total' })
    // The source + attribution factors must not appear as caps/penalties for a directly-measured total.
    const attribution = acuity.factors.find((f) => f.key === 'attribution')
    expect(attribution?.weight).toBe(0) // N/A, not penalized
    const source = acuity.factors.find((f) => f.key === 'source')
    expect(source?.score).toBe(1)
    // A meta_estimate revenue claim is capped at 0.6; outcome_actual must not hit that ceiling.
    const metaEst = computeTrust({ ...base, sourceOfTruth: 'meta_modelled' })
    expect(acuity.score).toBeGreaterThan(metaEst.score)
  })
})
