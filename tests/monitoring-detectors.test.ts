import { describe, it, expect } from 'vitest'
import {
  detectStaleData,
  detectMetaGa4Mismatch,
  detectBookingRevenueMismatch,
  detectDuplicateData,
  detectReportFailure,
  detectWriteModeTripwire,
  detectCapiDeliveryBacklog,
} from '@/lib/monitoring/detectors'
import { CAPI_TERMINAL } from '@/lib/outcomes/adapters/acuity/reconcile'
import { maskSecrets, emitAlert, _resetAlertDedupe } from '@/lib/monitoring/alerts'

describe('monitoring detectors', () => {
  it('flags stale / missing data with escalating severity', () => {
    expect(detectStaleData(2)).toBeNull()
    expect(detectStaleData(30)?.severity).toBe('warning')
    expect(detectStaleData(100)?.severity).toBe('critical')
    expect(detectStaleData(null)?.severity).toBe('critical')
  })

  it('treats expected Meta under-count as info, but flags broken/over-count as warning', () => {
    const at = (metaBookings: number, ga4ConfirmationEvents: number, ga4Available = true) =>
      detectMetaGa4Mismatch({ metaBookings, ga4Available, ga4ConfirmationEvents, websiteOriginAppointments: 10 })
    expect(at(2, 8)?.severity).toBe('info')        // Meta under-counts GA: expected pixel behaviour
    expect(at(5, 0)?.severity).toBe('warning')     // GA recorded zero while Meta claims 5
    expect(at(20, 5)?.severity).toBe('warning')    // Meta materially over-attributing
    expect(at(0, 0, false)?.area).toBe('ga4')      // GA telemetry unavailable
    expect(at(4, 5)).toBeNull()                    // close enough
  })

  it('flags an implausible GA event VALUE per confirmation event (tag health)', () => {
    expect(detectBookingRevenueMismatch(10, 1500)).toBeNull() // $150/booking — fine
    expect(detectBookingRevenueMismatch(10, 50)?.area).toBe('ga_event_value_health') // $5/booking — too low
    expect(detectBookingRevenueMismatch(10, 50000)?.area).toBe('ga_event_value_health') // $5000/booking — too high
    expect(detectBookingRevenueMismatch(0, 0)).toBeNull()
  })

  it('flags duplicate rows', () => {
    expect(detectDuplicateData(100, 100)).toBeNull()
    expect(detectDuplicateData(120, 100)?.severity).toBe('warning')
  })

  it('flags a missing daily report', () => {
    expect(detectReportFailure(true)).toBeNull()
    expect(detectReportFailure(false)?.area).toBe('report')
  })

  it('treats write mode being ON as a critical tripwire', () => {
    expect(detectWriteModeTripwire(false)).toBeNull()
    expect(detectWriteModeTripwire(true)?.severity).toBe('critical')
  })
})

describe('alert emitter', () => {
  it('masks token-shaped secrets', () => {
    const masked = maskSecrets('token EAABsbCS1234567890abcdefXYZ failed')
    expect(masked).not.toContain('EAABsbCS1234567890abcdefXYZ')
    expect(masked).toMatch(/\.\.\./)
  })

  // CAPI delivery backlog. Negative controls first: the detector must stay SILENT on the healthy
  // state, or an always-firing alert would look like coverage while proving nothing.
  it('stays silent when CAPI delivery is healthy', () => {
    expect(detectCapiDeliveryBacklog({ oldestUnsentHours: null, missedWindow: 0 })).toBeNull()
    // Median real delivery is ~6s; a booking seconds old is not a backlog.
    expect(detectCapiDeliveryBacklog({ oldestUnsentHours: 0.02, missedWindow: 0 })).toBeNull()
    // Just under the webhook-failure threshold.
    expect(detectCapiDeliveryBacklog({ oldestUnsentHours: 2.9, missedWindow: 0 })).toBeNull()
  })

  it('warns when the webhook path has failed but the sweep can still recover', () => {
    const f = detectCapiDeliveryBacklog({ oldestUnsentHours: 5, missedWindow: 0 })
    expect(f?.severity).toBe('warning')
    expect(f?.area).toBe('cron')
  })

  it('escalates to critical as the 46h resend cutoff approaches', () => {
    const f = detectCapiDeliveryBacklog({ oldestUnsentHours: 31, missedWindow: 0 })
    expect(f?.severity).toBe('critical')
  })

  it('reports permanent loss even when nothing is currently backlogged', () => {
    const f = detectCapiDeliveryBacklog({ oldestUnsentHours: null, missedWindow: 2 })
    expect(f?.severity).toBe('critical')
    expect(f?.dedupeKey).toBe('capi_missed_window')
    expect(f?.message).toContain('never be delivered')
  })

  // The monitoring runner filters candidates with this exact set; if the sweep's terminal labels ever
  // change, monitoring must move with it rather than alerting on rows the sweep will never retry.
  it('shares the sweep\'s terminal label set', () => {
    expect(CAPI_TERMINAL.has('staff_created')).toBe(true)
    expect(CAPI_TERMINAL.has('missed-48h-window')).toBe(true)
    expect(CAPI_TERMINAL.has('pre-golive-baseline')).toBe(false)
  })

  it('de-dupes repeated alerts within the window', () => {
    _resetAlertDedupe()
    const first = emitAlert({ area: 'stale_data', severity: 'warning', message: 'stale' })
    const second = emitAlert({ area: 'stale_data', severity: 'warning', message: 'stale' })
    expect(first.emitted).toBe(true)
    expect(second.emitted).toBe(false)
    expect(second.reason).toBe('deduped')
  })
})
