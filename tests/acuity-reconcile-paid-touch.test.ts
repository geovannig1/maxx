import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  getAppointment: vi.fn(),
  link: vi.fn(),
  send: vi.fn(),
}))

vi.mock('@/lib/outcomes/adapters/acuity/client', () => ({
  getAppointment: state.getAppointment,
  getAppointments: vi.fn(),
  isAcuityConfigured: vi.fn(() => true),
}))
vi.mock('@/lib/outcomes/adapters/acuity/paid-touch-link', () => ({
  paidTouchLinkConfig: vi.fn(() => ({ fieldId: 42, tokenSecret: 'secret' })),
  linkAcuityPaidTouchWithFallback: state.link,
}))
vi.mock('@/lib/capi/acuity-capi', () => ({
  resolveSendMode: vi.fn(() => 'live'),
  sendAcuityCapiEvent: state.send,
}))

function fakeSupabase() {
  let selectNumber = 0
  const from = vi.fn(() => {
    const builder: Record<string, unknown> = {}
    for (const method of ['select', 'is', 'eq', 'neq', 'gte', 'lt', 'or', 'in', 'update']) {
      builder[method] = vi.fn(() => builder)
    }
    builder.limit = vi.fn(async () => {
      selectNumber += 1
      if (selectNumber === 1) {
        return {
          data: [{
            id: '00000000-0000-4000-8000-000000000752',
            external_id: '777000103',
            ad_account_id: '00000000-0000-4000-8000-000000000751',
            fbp: null,
            conversion_send_error: null,
          }],
          error: null,
        }
      }
      return { data: [], error: null }
    })
    return builder
  })
  return { from }
}

describe('Acuity reconciliation paid-touch seam', () => {
  beforeEach(() => {
    vi.resetModules()
    state.getAppointment.mockReset()
    state.getAppointment.mockResolvedValue({
      id: 777000103, scheduledBy: null, datetimeCreated: '2026-07-30T20:00:00.000Z',
      canceled: false, forms: [],
    })
    state.link.mockReset()
    state.link.mockResolvedValue({
      status: 'linked',
      paidTouch: { fbclid: 'IwZXh0bgNhZW0CMTAAAR1', observedAt: '2026-07-30T18:30:00.000Z' },
    })
    state.send.mockReset()
    state.send.mockResolvedValue({ mode: 'live', status: 'sent', eventId: 'acuity-777000103' })
  })

  it('re-links a missed-webhook candidate from its by-id payload before retrying CAPI', async () => {
    const supabase = fakeSupabase()
    const { sweepUnsentCapi } = await import('@/lib/outcomes/adapters/acuity/reconcile')
    const result = await sweepUnsentCapi(supabase as never, new Date('2026-07-30T21:00:00Z').getTime())

    expect(result.sent).toBe(1)
    expect(supabase.from).toHaveBeenCalledWith('outcomes')
    // The Acuity API is called with the outcome's external id, never the outcome uuid.
    expect(state.getAppointment).toHaveBeenCalledWith(777000103)
    expect(state.link).toHaveBeenCalledWith(
      supabase,
      '00000000-0000-4000-8000-000000000751',
      expect.objectContaining({ id: 777000103 }),
      { fieldId: 42, tokenSecret: 'secret' },
    )
    expect(state.send).toHaveBeenCalledWith(
      expect.objectContaining({ id: 777000103 }),
      null,
      supabase,
      { fbclid: 'IwZXh0bgNhZW0CMTAAAR1', observedAt: '2026-07-30T18:30:00.000Z' },
    )
  })
})
