import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_META_OUTCOME_EVENT, metaOutcomeEventName } from '@/config/business-config'
import { ENV_VARS } from '@/config/env'
import { evaluateTrackingHealth, pixelFiresOutcomeEvent } from '@/lib/tracking/health-monitor'

// the Meta pixel event that marks an outcome is configuration (NEXT_PUBLIC_META_OUTCOME_EVENT), not a
// hard-coded AppointmentConfirmed. The default stays AppointmentConfirmed so existing installs read the same.

afterEach(() => vi.unstubAllEnvs())

const delivering = { isFiring: true, outcomeEventsLast7: 0, outcomeEventsPrev7: 4, deliveryLast7: 120, volumeDropPct: null, pixelFiringSiteWide: false }

describe('configurable Meta outcome event', () => {
  it('defaults to AppointmentConfirmed and reads a configured name', () => {
    expect(DEFAULT_META_OUTCOME_EVENT).toBe('AppointmentConfirmed')
    expect(metaOutcomeEventName()).toBe('AppointmentConfirmed')
    vi.stubEnv('NEXT_PUBLIC_META_OUTCOME_EVENT', ' Purchase ')
    expect(metaOutcomeEventName()).toBe('Purchase')
  })

  it('refuses a malformed event name (control)', () => {
    vi.stubEnv('NEXT_PUBLIC_META_OUTCOME_EVENT', 'bad name!')
    expect(() => metaOutcomeEventName()).toThrow(/NEXT_PUBLIC_META_OUTCOME_EVENT/)
  })

  it('reads site-wide firing of the configured event from pixel event stats', () => {
    const stats = [{ event_name: 'Purchase', count: 3 }, { event_name: 'AppointmentConfirmed', count: 0 }]
    expect(pixelFiresOutcomeEvent(stats)).toBe(false)
    vi.stubEnv('NEXT_PUBLIC_META_OUTCOME_EVENT', 'Purchase')
    expect(pixelFiresOutcomeEvent(stats)).toBe(true)
    expect(pixelFiresOutcomeEvent(undefined)).toBeNull()
  })

  it('names the configured event in tracking-health issues, and the default otherwise', () => {
    expect(evaluateTrackingHealth(delivering).issues.join(' ')).toContain('No AppointmentConfirmed events')
    vi.stubEnv('NEXT_PUBLIC_META_OUTCOME_EVENT', 'Lead')
    const text = evaluateTrackingHealth(delivering).issues.join(' ')
    expect(text).toContain('No Lead events')
    expect(text).not.toContain('AppointmentConfirmed')
  })

  it('interpolates the configured event in every tracking-health issue (dormant and site-wide-firing too)', () => {
    vi.stubEnv('NEXT_PUBLIC_META_OUTCOME_EVENT', 'Lead')
    const cases = [
      { ...delivering, deliveryLast7: 0 },
      { ...delivering, pixelFiringSiteWide: true },
      { ...delivering, outcomeEventsLast7: 1, outcomeEventsPrev7: 10, volumeDropPct: -90 },
    ]
    for (const signals of cases) {
      const text = evaluateTrackingHealth(signals).issues.join(' ')
      expect(text).toContain('Lead')
      expect(text).not.toContain('${')
      expect(text).not.toContain('AppointmentConfirmed')
    }
  })

  it('is in the environment registry and the generated configuration docs', () => {
    const spec = ENV_VARS.find((v) => v.name === 'NEXT_PUBLIC_META_OUTCOME_EVENT')
    expect(spec).toMatchObject({ default: 'AppointmentConfirmed' })
    expect(readFileSync('docs/configuration.md', 'utf8')).toContain('NEXT_PUBLIC_META_OUTCOME_EVENT')
  })
})

describe('Meta insight readers match the configured outcome event', () => {
  it('keeps the default substring match and matches a configured name only as a whole trailing token', async () => {
    const { namesOutcomeEvent } = await import('@/lib/sync/insight-outcome-readers')
    expect(namesOutcomeEvent('conversions:offsite_conversion.fb_pixel_custom.AppointmentConfirmed', 'AppointmentConfirmed')).toBe(true)
    expect(namesOutcomeEvent('offsite_conversion.fb_pixel_purchase', 'AppointmentConfirmed')).toBe(false)
    expect(namesOutcomeEvent('offsite_conversion.fb_pixel_purchase', 'Purchase')).toBe(true)
    expect(namesOutcomeEvent('offsite_conversion.fb_pixel_custom.Purchase', 'Purchase')).toBe(true)
    expect(namesOutcomeEvent('onsite_conversion.lead_grouped', 'Lead')).toBe(false)
    expect(namesOutcomeEvent('offsite_conversion.fb_pixel_custom.AppointmentConfirmed', 'Lead')).toBe(false)
  })

  it('counts Results for the configured event read at module load, not the default (control)', async () => {
    vi.resetModules()
    vi.stubEnv('NEXT_PUBLIC_META_OUTCOME_EVENT', 'Purchase')
    const { readOutcomeEventResult } = await import('@/lib/sync/insight-outcome-readers')
    const results = [
      { indicator: 'actions:offsite_conversion.fb_pixel_purchase', values: [{ value: '3', attribution_windows: ['default'] }] },
      { indicator: 'conversions:offsite_conversion.fb_pixel_custom.AppointmentConfirmed', values: [{ value: '9', attribution_windows: ['default'] }] },
    ]
    expect(readOutcomeEventResult(results as never).value).toBe(3)
    vi.resetModules()
  })
})
