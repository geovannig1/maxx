import { afterEach, describe, expect, it, vi } from 'vitest'

// The chat's measurement contract and its per-answer source-role disclosure name Meta's outcome event.
// That event is configuration (NEXT_PUBLIC_META_OUTCOME_EVENT), so a shop optimising for Purchase must
// not be told about "AppointmentConfirmed Results" in every answer.

vi.mock('server-only', () => ({}))

const EVIDENCE = [{
  tool: 'get_performance_cockpit', sources: ['Meta'], dateWindow: '2026-08-01 to 2026-08-20', scope: 'account',
  freshness: 'fresh', availability: 'returned', caveat: 'none', observedAt: null,
}] as const

async function governanceFor(env: { event?: string; noun: string }) {
  vi.resetModules()
  vi.stubEnv('NEXT_PUBLIC_OUTCOME_NOUN', env.noun)
  vi.stubEnv('NEXT_PUBLIC_META_OUTCOME_EVENT', env.event ?? '')
  const governance = await import('@/lib/maxx/chat-governance')
  const answer = governance.governMaxxAnswer('Spend was steady.', [...EVIDENCE] as never, 'server_composed')
  return { prompt: governance.MAXX_CHAT_MEASUREMENT_GOVERNANCE, answer, govern: governance.governMaxxAnswer }
}

describe('chat governance names the configured Meta outcome event', () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.resetModules() })

  it('a booking business on the default event keeps AppointmentConfirmed Results', async () => {
    const { prompt, answer } = await governanceFor({ noun: 'booking/bookings' })
    expect(prompt).toContain('modelled AppointmentConfirmed Results')
    expect(answer).toContain('Meta = platform delivery + modelled AppointmentConfirmed Results.')
  })

  it('a purchase business sees its own event, never AppointmentConfirmed', async () => {
    const { prompt, answer } = await governanceFor({ event: 'Purchase', noun: 'order/orders' })
    expect(prompt).toContain('modelled Purchase Results')
    expect(prompt).toMatch(/never be counted or blended into Purchase Results/)
    expect(answer).toContain('Meta = platform delivery + modelled Purchase Results.')
    expect(`${prompt}\n${answer}`).not.toMatch(/AppointmentConfirmed|appointment|booking/i)
  })

  it('the prose boundary still refuses an alias blended into the configured event', async () => {
    const { govern } = await governanceFor({ event: 'Purchase', noun: 'order/orders' })
    const blended = 'The generic custom conversion alias was added to Purchase Results for the total.'
    expect(govern(blended, [...EVIDENCE] as never, 'model_authored')).toContain('crossed a governed measurement boundary')
  })
})
