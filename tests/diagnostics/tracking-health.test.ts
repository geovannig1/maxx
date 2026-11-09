import { describe, it, expect } from 'vitest'
import { evaluateTrackingHealth } from '@/lib/tracking/health-monitor'

// The mis-frame fix: "ads delivering + ~0 AppointmentConfirmed ATTRIBUTED" must not be reported as a
// broken pixel when the pixel IS firing site-wide — that sends the owner chasing a working pixel. It is
// an ads-not-converting / attribution issue → warning routed to the performance diagnosis, not critical.
describe('evaluateTrackingHealth — attribution vs broken-pixel', () => {
  it('does NOT cry "pixel broken" when the pixel fires site-wide but ~0 is attributed to campaigns', () => {
    const r = evaluateTrackingHealth({
      isFiring: true, appointmentLast7: 0, appointmentPrev7: 5, deliveryLast7: 240, volumeDropPct: -100,
      pixelFiringSiteWide: true,
    })
    expect(r.status).toBe('warning') // not critical
    // The conclusion is now stated from the EVIDENCE (site-wide firing shows the
    // pixel works) instead of as a bare "not broken" reassurance.
    expect(r.issues.join(' ')).toMatch(/pixel IS firing site-wide/i)
    expect(r.issues.join(' ')).toMatch(/evidence the pixel itself is installed and working/i)
    expect(r.issues.join(' ')).toMatch(/what is unresolved/i)
    expect(r.issues.join(' ')).toMatch(/diagnose_ad_performance/)
  })

  it('still flags critical when the pixel is NOT firing site-wide (genuine breakage)', () => {
    const r = evaluateTrackingHealth({
      isFiring: true, appointmentLast7: 0, appointmentPrev7: 5, deliveryLast7: 240, volumeDropPct: -100,
      pixelFiringSiteWide: false,
    })
    expect(r.status).toBe('critical')
    expect(r.issues.join(' ')).toMatch(/check the pixel/i)
  })

  it('stays conservative (critical) when site-wide firing is unknown — preserves old behavior', () => {
    const r = evaluateTrackingHealth({ isFiring: true, appointmentLast7: 0, appointmentPrev7: 5, deliveryLast7: 240, volumeDropPct: -100 })
    expect(r.status).toBe('critical')
  })

  it('dormant (no delivery) is still UNVERIFIED regardless of the new signal', () => {
    const r = evaluateTrackingHealth({ isFiring: false, appointmentLast7: 0, appointmentPrev7: 0, deliveryLast7: 0, volumeDropPct: null, pixelFiringSiteWide: true })
    expect(r.status).toBe('unverified')
    expect(r.dormant).toBe(true)
  })

  it('healthy when events are attributed and the pixel is firing', () => {
    const r = evaluateTrackingHealth({ isFiring: true, appointmentLast7: 6, appointmentPrev7: 5, deliveryLast7: 300, volumeDropPct: 20, pixelFiringSiteWide: true })
    expect(r.status).toBe('healthy')
  })
})
