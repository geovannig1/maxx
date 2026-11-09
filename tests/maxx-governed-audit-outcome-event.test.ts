import { afterEach, describe, expect, it, vi } from 'vitest'

// The governed audit's Meta-modelled results claim names Meta's outcome event. That event is
// configuration (NEXT_PUBLIC_META_OUTCOME_EVENT), so a shop optimising for Purchase must not see an
// "AppointmentConfirmed Results" claim in its audit, the same rule chat-governance.ts already follows.

async function modelledResultsLabel(env: { event?: string; noun: string }) {
  vi.resetModules()
  vi.stubEnv('NEXT_PUBLIC_OUTCOME_NOUN', env.noun)
  vi.stubEnv('NEXT_PUBLIC_META_OUTCOME_EVENT', env.event ?? '')
  const { buildGovernedAuditEvidence } = await import('@/lib/maxx/governed-audit')
  const packet = buildGovernedAuditEvidence({
    focus: 'owner_ads_audit', accountId: 'act-1',
    window: { start: '2026-08-01', end: '2026-08-20' }, asOf: '2026-08-21T12:00:00.000Z',
    cockpit: null, diagnosis: { conversions: { meta_modelled_bookings: 7 } }, reconciliation: null,
    economics: null, operatingMode: null, recommendations: null, creative: null,
  })
  const modelled = packet.claims.filter((c) => c.source.system === 'meta' && c.measurementKind === 'modelled')
  expect(modelled).toHaveLength(1)
  return { label: modelled[0].label, value: modelled[0].value }
}

describe('governed audit names the configured Meta outcome event', () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.resetModules() })

  it('a booking business on the default event keeps AppointmentConfirmed Results', async () => {
    const { label, value } = await modelledResultsLabel({ noun: 'booking/bookings' })
    expect(label).toBe('Meta-modelled AppointmentConfirmed Results')
    expect(value).toBe(7)
  })

  it('a purchase business sees its own event, never AppointmentConfirmed', async () => {
    const { label, value } = await modelledResultsLabel({ event: 'Purchase', noun: 'order/orders' })
    expect(label).toBe('Meta-modelled Purchase Results')
    expect(label).not.toMatch(/AppointmentConfirmed|appointment|booking/i)
    expect(value).toBe(7)
  })
})
