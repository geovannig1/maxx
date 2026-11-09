import { describe, it, expect } from 'vitest'
import { METRIC_BY_KEY } from '@/lib/metrics/catalog'

// This is an AppointmentConfirmed-optimized account. The daily Meta field remains the platform's
// modelled Results column; it must never be presented as Acuity business appointments.
describe('metric catalog defaults (AppointmentConfirmed account)', () => {
  it('shows Meta Results and Meta cost / Result by default with modelled attribution labels', () => {
    expect(METRIC_BY_KEY.bookings.defaultVisible).toBe(true)
    expect(METRIC_BY_KEY.cpa.defaultVisible).toBe(true)
    expect(METRIC_BY_KEY.bookings.label).toBe('Meta Results (modelled 7dc/1dv)')
    expect(METRIC_BY_KEY.bookings.description).toMatch(/7-day click.*1-day view/i)
    expect(METRIC_BY_KEY.bookings.description).toMatch(/not.*business appointments/i)
    expect(METRIC_BY_KEY.cpa.label).toMatch(/Meta Cost.*Result/i)
    expect(METRIC_BY_KEY.cpa.bandMetric).toBeUndefined()
  })

  it('does not offer warehouse appointment value or ROAS as a Meta performance column', () => {
    expect(METRIC_BY_KEY.roas).toBeUndefined()
  })
  it('hides the structurally-zero Leads and CPL columns by default (still available in the picker)', () => {
    expect(METRIC_BY_KEY.leads.defaultVisible).toBe(false)
    expect(METRIC_BY_KEY.cpl.defaultVisible).toBe(false)
  })

  it('labels daily-only reach/frequency honestly and does not apply period-frequency bands', () => {
    expect(METRIC_BY_KEY.reach.label).toMatch(/daily/i)
    expect(METRIC_BY_KEY.reach.description).toMatch(/not selected-period/i)
    expect(METRIC_BY_KEY.frequency.label).toMatch(/daily/i)
    expect(METRIC_BY_KEY.frequency.description).toMatch(/unavailable.*multi-day/i)
    expect(METRIC_BY_KEY.frequency.bandMetric).toBeUndefined()
    expect(METRIC_BY_KEY.frequency.defaultVisible).toBe(false)
  })
})
