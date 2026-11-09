import '../_support/outcome-noun-booking'
import { describe, it, expect } from 'vitest'
import { detectMetaGa4Mismatch, detectMetaDeliveryHealth, detectReportNarrativeFailure } from '@/lib/monitoring/detectors'

describe('Wave C — strengthened attribution-mismatch detector', () => {
  // Spend on both planes at zero is NOT self-evidently an outage, and ALL-SOURCE ledger
  // volume cannot establish one — an organic, phone or staff-created appointment does not contradict
  // a paid or telemetry subset. Only WEBSITE-ORIGIN appointments can, and only about the GA tag.
  it('spend flowing, both planes at zero, and WEBSITE-ORIGIN bookings exist ⇒ GA tag looks broken', () => {
    const f = detectMetaGa4Mismatch({ metaBookings: 0, ga4Available: true, ga4ConfirmationEvents: 0,
      websiteOriginAppointments: 6, metaSpend: 120 })
    expect(f?.severity).toBe('warning')
    expect(f?.message).toMatch(/browser tag looks broken/i)
    expect(f?.message).toMatch(/6 WEBSITE-ORIGIN booking/i)
    // It must NOT extend the claim to Meta, which needs CAPI evidence to judge.
    expect(f?.message).toMatch(/says nothing about Meta delivery/i)
  })

  it('same spend and zeros, but NO website-origin bookings ⇒ observation only, not an outage claim', () => {
    const f = detectMetaGa4Mismatch({ metaBookings: 0, ga4Available: true, ga4ConfirmationEvents: 0,
      websiteOriginAppointments: 0, metaSpend: 120 })
    expect(f?.severity).toBe('info')                        // not 'warning'
    expect(f?.message).not.toMatch(/browser tag looks broken/i)   // the diagnosis is withheld
    expect(f?.message).toMatch(/consistent with ordinary poor performance/i)
  })

  it('evidence NOT READ says so, rather than passing silence off as agreement', () => {
    const f = detectMetaGa4Mismatch({ metaBookings: 0, ga4Available: true, ga4ConfirmationEvents: 0,
      websiteOriginAppointments: null, metaSpend: 120 })
    expect(f?.severity).toBe('info')
    expect(f?.message).toMatch(/Website-origin ledger activity was NOT read/i)
  })

  it('does NOT flag the outage when spend is negligible (genuinely dormant)', () => {
    expect(detectMetaGa4Mismatch({ metaBookings: 0, ga4Available: true, ga4ConfirmationEvents: 0,
      websiteOriginAppointments: 6, metaSpend: 5 })).toBeNull()
  })

  it('still flags Meta-claims-conversions-but-GA-zero, in telemetry language', () => {
    const f = detectMetaGa4Mismatch({ metaBookings: 4, ga4Available: true, ga4ConfirmationEvents: 0,
      websiteOriginAppointments: 10, metaSpend: 200 })
    expect(f?.message).toMatch(/GA recorded ZERO confirmation events/i)
    expect(f?.message).toMatch(/Neither figure is a booking count/i)   // no telemetry-as-bookings
  })

  it('metaSpend is optional and defaults to 0 — no spend, nothing to diagnose', () => {
    expect(detectMetaGa4Mismatch({ metaBookings: 0, ga4Available: true, ga4ConfirmationEvents: 0,
      websiteOriginAppointments: 6 })).toBeNull()
  })
})

describe('partial CAPI loss must be visible', () => {
  const W = { start: '2026-07-22', end: '2026-07-28' }

  it('R8: 1 accepted of 10 eligible is a WARNING naming the 9 missing, not silence', () => {
    // The previous shape fired only at ZERO delivered, so nine bookings Meta never received produced
    // no finding at all.
    const f = detectMetaDeliveryHealth({ metaSpend: 500, capiDeliveredAppointments: 1,
      capiEligibleAppointments: 10, window: W })
    expect(f).toHaveLength(1)
    expect(f[0]!.severity).toBe('warning')
    expect(f[0]!.message).toMatch(/PARTIAL CAPI delivery/)
    expect(f[0]!.message).toMatch(/1 of 10/)
    expect(f[0]!.message).toMatch(/9 MISSING/)
    expect(f[0]!.message).toMatch(/10% accepted/)
  })

  it('ANY shortfall is reported — there is no tolerated-loss threshold', () => {
    // A percentage floor would hide exactly the missing server events this check exists to surface.
    const f = detectMetaDeliveryHealth({ metaSpend: 500, capiDeliveredAppointments: 99,
      capiEligibleAppointments: 100, window: W })
    expect(f).toHaveLength(1)
    expect(f[0]!.message).toMatch(/1 MISSING/)
  })

  it('0 of N with spend is CRITICAL', () => {
    const f = detectMetaDeliveryHealth({ metaSpend: 500, capiDeliveredAppointments: 0,
      capiEligibleAppointments: 10, window: W })
    expect(f[0]!.severity).toBe('critical')
    expect(f[0]!.message).toMatch(/NO accepted live CAPI event/)
  })

  it('N of N is healthy — no finding', () => {
    expect(detectMetaDeliveryHealth({ metaSpend: 500, capiDeliveredAppointments: 10,
      capiEligibleAppointments: 10, window: W })).toHaveLength(0)
  })

  it('unknown-origin confirmations get their OWN not-evaluable finding', () => {
    const f = detectMetaDeliveryHealth({ metaSpend: 500, capiDeliveredAppointments: 10,
      capiEligibleAppointments: 10, originUnknownConfirmations: 4, window: W })
    expect(f).toHaveLength(1)
    expect(f[0]!.severity).toBe('info')
    expect(f[0]!.message).toMatch(/NOT EVALUABLE/)
    expect(f[0]!.message).toMatch(/not a claim that they were website bookings/)
  })

  it('a query failure is NOT READ, never zero', () => {
    const f = detectMetaDeliveryHealth({ metaSpend: 500, capiDeliveredAppointments: null,
      capiEligibleAppointments: null, window: W })
    expect(f[0]!.message).toMatch(/NOT READ/)
    expect(f[0]!.message).toMatch(/not a claim that zero events were delivered/)
  })
})

describe('Wave C — LLM narrative-failure detector', () => {
  it('warns when a report persisted but the narrative did not generate (model_used none) + provider configured', () => {
    const f = detectReportNarrativeFailure('none', true)
    expect(f?.severity).toBe('warning')
    expect(f?.area).toBe('llm')
    expect(f?.message).toMatch(/narrative did NOT generate/i)
  })

  it('also catches null / empty model_used', () => {
    expect(detectReportNarrativeFailure(null, true)).not.toBeNull()
    expect(detectReportNarrativeFailure('', true)).not.toBeNull()
  })

  it('stays silent when NO provider is configured (metrics-only is expected then)', () => {
    expect(detectReportNarrativeFailure('none', false)).toBeNull()
  })

  it('stays silent when the narrative DID generate', () => {
    expect(detectReportNarrativeFailure('claude-opus-4', true)).toBeNull()
  })
})
