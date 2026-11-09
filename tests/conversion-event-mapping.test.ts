import { describe, expect, it } from 'vitest'
import { decideConversionEvent, DEFAULT_CONVERSION_EVENTS } from '@/lib/conversions/event-mapping'
import { OUTCOME_TYPES } from '@/lib/outcomes/model'
import { getOutcomeAdapter } from '@/lib/outcomes/registry'
import { buildAcuityCapiEvent } from '@/lib/capi/acuity-capi'

const webhook = getOutcomeAdapter('webhook')!.capabilities
const acuity = getOutcomeAdapter('acuity')!.capabilities
const base = { origin: 'website' as const, status: 'confirmed' as const, capabilities: webhook }

describe('conversion event by outcome type (ADR-058)', () => {
  it('maps exactly the four documented types', () => {
    expect(DEFAULT_CONVERSION_EVENTS).toEqual({
      lead: 'Lead', sale: 'Purchase', booking: 'Schedule', signup: 'CompleteRegistration',
    })
  })

  it.each([
    ['lead', 'Lead'], ['sale', 'Purchase'], ['booking', 'Schedule'], ['signup', 'CompleteRegistration'],
  ] as const)('sends a website %s as %s', (outcomeType, eventName) => {
    expect(decideConversionEvent({ ...base, outcomeType })).toEqual({ send: true, eventName })
  })

  it.each(OUTCOME_TYPES.filter((t) => !(t in DEFAULT_CONVERSION_EVENTS)))('never sends an unmapped type: %s', (outcomeType) => {
    expect(decideConversionEvent({ ...base, outcomeType })).toEqual({ send: false, reason: 'unmapped_type' })
  })

  it.each(['staff_or_manual', 'unknown', null] as const)('never sends origin %s, whatever the type', (origin) => {
    for (const outcomeType of OUTCOME_TYPES) {
      expect(decideConversionEvent({ ...base, origin, outcomeType })).toEqual({ send: false, reason: 'origin_not_website' })
    }
  })

  it.each(['pending', 'cancelled', 'refunded'] as const)('never sends a %s outcome', (status) => {
    expect(decideConversionEvent({ ...base, status, outcomeType: 'sale' })).toEqual({ send: false, reason: 'not_confirmed' })
  })

  it('never mirrors an event the source already sends natively (per-source config)', () => {
    const native = ['Purchase']
    expect(decideConversionEvent({ ...base, outcomeType: 'sale', sourcePlatformNativeEvents: native }))
      .toEqual({ send: false, reason: 'platform_native' })
    // Control: the same source's leads are not native, so they are still sent.
    expect(decideConversionEvent({ ...base, outcomeType: 'lead', sourcePlatformNativeEvents: native }))
      .toEqual({ send: true, eventName: 'Lead' })
  })

  it('applies an adapter\'s own native events and event-name override (the Acuity example)', () => {
    // Acuity's integration sends Schedule itself; Maxx sends AppointmentConfirmed instead.
    expect(decideConversionEvent({ ...base, capabilities: acuity, outcomeType: 'booking' }))
      .toEqual({ send: true, eventName: 'AppointmentConfirmed' })
    expect(decideConversionEvent({ ...base, capabilities: acuity, outcomeType: 'sale' }))
      .toEqual({ send: false, reason: 'platform_native' })
  })

  it('agrees with the event the byte-identical Acuity builder emits', () => {
    const built = buildAcuityCapiEvent(
      { id: 9001, datetimeCreated: '2026-06-15T10:00:00.000Z', scheduledBy: null, price: '125.00' } as never,
      { currency: 'USD', nowMs: Date.parse('2026-06-15T12:00:00.000Z') },
    )
    const decided = decideConversionEvent({ ...base, capabilities: acuity, outcomeType: 'booking' })
    expect(decided.send && decided.eventName).toBe(built.payload!.data[0].event_name)
  })

  it('refuses to send when the per-source native list is malformed (fails closed)', () => {
    expect(decideConversionEvent({ ...base, outcomeType: 'sale', sourcePlatformNativeEvents: 'Purchase' as never }))
      .toEqual({ send: false, reason: 'invalid_source_config' })
  })
})
