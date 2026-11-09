import { describe, expect, it } from 'vitest'
import {
  resolveOutcomeSendMode,
  type OutcomeConversionRow,
} from '@/lib/conversions/outcome-conversions'
import { buildOutcomeConversionEvent } from '@/lib/platforms/meta/outcome-event'

const NOW = Date.parse('2026-11-08T12:00:00Z')
const ROW: OutcomeConversionRow = {
  id: '0b6f2a8e-3c4d-4e5f-8a9b-0c1d2e3f4a5b', source_id: 's', outcome_type: 'lead', status: 'confirmed',
  origin: 'website', origin_observed_at: '2026-11-08T11:00:00Z', occurred_at: '2026-11-08T11:00:00Z',
  gross_value: null, currency: 'GBP', email: ' Lead@Example.test ', phone: null, first_name: null, last_name: null,
  fbp: null, fbc: null, landing_page: 'https://example.test/contact', conversion_sent_at: null,
}
const build = (over: Partial<OutcomeConversionRow> = {}) =>
  buildOutcomeConversionEvent({ ...ROW, ...over }, { eventName: 'Lead', nowMs: NOW })

describe('generic outcome conversion event', () => {
  it('builds one event keyed maxx-<outcome id> at the true occurred time (good control)', () => {
    const built = build()
    expect(built.ok && built.payload.data[0]).toMatchObject({
      event_name: 'Lead', event_id: `maxx-${ROW.id}`, event_time: Date.parse('2026-11-08T11:00:00Z') / 1000,
      action_source: 'website', event_source_url: 'https://example.test/contact',
    })
  })

  it('sends no value when none was observed, and the exact value with its own currency when one was', () => {
    const none = build()
    expect(none.ok && 'custom_data' in none.payload.data[0]).toBe(false)
    const zero = build({ gross_value: '0' })
    expect(zero.ok && 'custom_data' in zero.payload.data[0]).toBe(false)
    const valued = build({ gross_value: '19.99' })
    expect(valued.ok && valued.payload.data[0].custom_data).toEqual({ value: 19.99, currency: 'GBP' })
  })

  it('never sends a value above the outcome money ceiling', () => {
    const huge = build({ gross_value: '1000000000.01' })
    expect(huge.ok && 'custom_data' in huge.payload.data[0]).toBe(false)
    const atCeiling = build({ gross_value: '1000000000' })
    expect(atCeiling.ok && atCeiling.payload.data[0].custom_data).toEqual({ value: 1000000000, currency: 'GBP' })
  })

  it("sends the outcome's own currency with the value in that currency's major units", () => {
    const data = (currency: string, gross_value: string) => {
      const built = build({ currency, gross_value })
      return built.ok ? built.payload.data[0].custom_data as { value: number; currency: string } : null
    }
    expect(data('EUR', '120.50')).toEqual({ value: 120.5, currency: 'EUR' })
    expect(data('JPY', '1500')).toEqual({ value: 1500, currency: 'JPY' })
    // A sub-yen remainder is not a JPY amount: the value is a whole number of yen.
    expect(data('JPY', '1500.4')).toEqual({ value: 1500, currency: 'JPY' })
    expect(Number.isInteger(data('JPY', '1500.4')!.value)).toBe(true)
    // Controls: two- and three-digit currencies keep their minor units.
    expect(data('USD', '129.99')).toEqual({ value: 129.99, currency: 'USD' })
    expect(data('KWD', '12.345')).toEqual({ value: 12.345, currency: 'KWD' })
  })

  it('caps a future time at now and refuses one older than Meta\'s 7-day window', () => {
    const future = build({ occurred_at: '2026-11-08T12:10:00Z' })
    expect(future.ok && future.payload.data[0].event_time).toBe(NOW / 1000)
    expect(build({ occurred_at: '2026-11-01T11:59:59Z' })).toEqual({ ok: false, skip: 'expired' })
    expect(build({ occurred_at: null })).toEqual({ ok: false, skip: 'expired' })
  })

  it.each([null, 'not a url', 'javascript:alert(1)'])('refuses event_source_url %j', (landing_page) => {
    expect(build({ landing_page })).toEqual({ ok: false, skip: 'no_event_source_url' })
  })

  it('refuses an event with nothing to match a person on', () => {
    expect(build({ email: null })).toEqual({ ok: false, skip: 'no_user_data' })
    // Control: a browser identifier alone is enough.
    expect(build({ email: null, fbp: 'fb.1.1762600000000.123' }).ok).toBe(true)
  })

  it('accepts only a well-formed fbc created no later than the outcome', () => {
    const before = build({ fbc: `fb.1.${Date.parse('2026-11-08T10:00:00Z')}.IwAR` })
    expect(before.ok && (before.payload.data[0].user_data as Record<string, unknown>).fbc).toBe(`fb.1.${Date.parse('2026-11-08T10:00:00Z')}.IwAR`)
    for (const fbc of [`fb.1.${Date.parse('2026-11-08T11:30:00Z')}.IwAR`, 'fb.1.abc.IwAR', 'IwAR']) {
      const built = build({ fbc })
      expect(built.ok && (built.payload.data[0].user_data as Record<string, unknown>).fbc).toBeUndefined()
    }
  })

  it('carries the test event code only when given', () => {
    const t = buildOutcomeConversionEvent(ROW, { eventName: 'Lead', nowMs: NOW, testEventCode: 'TEST1' })
    expect(t.ok && t.payload.test_event_code).toBe('TEST1')
  })
})

describe('generic conversions send mode', () => {
  it.each([
    [{ OUTCOME_CONVERSIONS_SEND: 'true' }, 'live'],
    [{ OUTCOME_CONVERSIONS_SEND: 'TRUE ' }, 'live'],
    [{ OUTCOME_CONVERSIONS_SEND: 'test', META_TEST_EVENT_CODE: 'T1' }, 'test'],
    [{ OUTCOME_CONVERSIONS_SEND: 'test' }, 'off'],
    [{ OUTCOME_CONVERSIONS_SEND: 'yes' }, 'off'],
    [{}, 'off'],
    // Turning on the Acuity example never turns on generic sending.
    [{ ACUITY_CAPI_SEND: 'true' }, 'off'],
  ])('%j → %s', (env, mode) => {
    expect(resolveOutcomeSendMode(env)).toBe(mode)
  })
})
