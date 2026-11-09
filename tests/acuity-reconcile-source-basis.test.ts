import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  exhaustive: vi.fn(),
  windowed: vi.fn(),
  ingest: vi.fn(),
}))

vi.mock('@/lib/outcomes/adapters/acuity/client', () => ({
  isAcuityConfigured: vi.fn(() => true),
  fetchAllAppointmentsByDateWindows: state.exhaustive,
  getAppointments: state.windowed,
  getAppointment: vi.fn(),
}))
vi.mock('@/lib/outcomes/adapters/acuity/ledger', () => ({
  ingestAppointments: state.ingest,
  resolveAdAccountId: vi.fn(async () => '00000000-0000-4000-8000-000000000701'),
}))
vi.mock('@/lib/outcomes/adapters/acuity/paid-touch-link', () => ({
  linkAcuityPaidTouchWithFallback: vi.fn(),
  paidTouchLinkConfig: vi.fn(() => null),
}))
vi.mock('@/lib/capi/acuity-capi', () => ({
  resolveSendMode: vi.fn(() => 'off'),
  sendAcuityCapiEvent: vi.fn(),
}))

function fakeSupabase() {
  const builder: Record<string, unknown> = {}
  for (const method of ['from', 'select', 'gte', 'eq']) builder[method] = vi.fn(() => builder)
  // The webhook-miss count is scoped to the account's Acuity source, found first.
  builder.maybeSingle = vi.fn(async () => ({ data: { id: '00000000-0000-4000-b000-000000000701' }, error: null }))
  builder.neq = vi.fn(async () => ({ count: 0, error: null }))
  return builder
}

describe('Acuity reconciliation source-window basis', () => {
  beforeEach(() => {
    state.exhaustive.mockReset().mockResolvedValue({
      rows: [{ id: 1 }], complete: true, blocker: null, queriedWindows: 1,
    })
    state.windowed.mockReset().mockResolvedValue([{ id: 1 }])
    state.ingest.mockReset().mockResolvedValue(1)
  })

  it('certifies booking-created-date coverage only after the exhaustive default sweep', async () => {
    const { reconcileAcuityLedger } = await import('@/lib/outcomes/adapters/acuity/reconcile')
    const result = await reconcileAcuityLedger({
      supabase: fakeSupabase() as never,
      adAccountId: '00000000-0000-4000-8000-000000000701',
    })
    expect(result).toMatchObject({
      available: true,
      sourceWindowBasis: 'booking_date_et',
      windowStartDate: '1900-01-01',
      truncated: false,
    })
    expect(state.exhaustive).toHaveBeenCalledOnce()
  })

  it('keeps a targeted list pull labeled as appointment-date evidence', async () => {
    const { reconcileAcuityLedger } = await import('@/lib/outcomes/adapters/acuity/reconcile')
    const result = await reconcileAcuityLedger({
      supabase: fakeSupabase() as never,
      adAccountId: '00000000-0000-4000-8000-000000000701',
      minDate: '2026-01-01',
      maxDate: '2026-12-31',
    })
    expect(result).toMatchObject({
      sourceWindowBasis: 'appointment_date',
      windowStartDate: '2026-01-01',
      windowEndDate: '2026-12-31',
      truncated: false,
    })
    expect(state.windowed).toHaveBeenCalledOnce()
  })
})
