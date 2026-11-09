import { beforeEach, describe, expect, it, vi } from 'vitest'

// once a generic webhook source exists, the Acuity CAPI sweep must touch only Acuity outcomes.
// Before this, it selected every unsent outcome, re-fetched each "appointment" by Number(external_id)
// and labelled every stale one 'missed-48h-window', so it would have tried to fetch webhook orders
// from Acuity and closed them out under the Acuity rules.

const state = vi.hoisted(() => ({ getAppointment: vi.fn(), send: vi.fn() }))
vi.mock('@/lib/outcomes/adapters/acuity/client', () => ({
  getAppointment: state.getAppointment,
  getAppointments: vi.fn(),
  isAcuityConfigured: vi.fn(() => true),
}))
vi.mock('@/lib/outcomes/adapters/acuity/paid-touch-link', () => ({
  paidTouchLinkConfig: vi.fn(() => null),
  linkAcuityPaidTouchWithFallback: vi.fn(),
}))
vi.mock('@/lib/capi/acuity-capi', () => ({ resolveSendMode: vi.fn(() => 'live'), sendAcuityCapiEvent: state.send }))

const NOW = Date.parse('2026-11-08T12:00:00Z')
type Row = { id: string; external_id: string; ad_account_id: string; fbp: null; conversion_send_error: null; occurred_at: string; kind: string }
const ROWS: Row[] = [
  { id: 'acuity-recent', external_id: '777000103', ad_account_id: 'a', fbp: null, conversion_send_error: null, occurred_at: new Date(NOW - 3_600_000).toISOString(), kind: 'acuity' },
  { id: 'webhook-recent', external_id: 'order-1', ad_account_id: 'a', fbp: null, conversion_send_error: null, occurred_at: new Date(NOW - 3_600_000).toISOString(), kind: 'webhook' },
  { id: 'acuity-stale', external_id: '777000109', ad_account_id: 'a', fbp: null, conversion_send_error: null, occurred_at: new Date(NOW - 72 * 3_600_000).toISOString(), kind: 'acuity' },
  { id: 'webhook-stale', external_id: 'order-2', ad_account_id: 'a', fbp: null, conversion_send_error: null, occurred_at: new Date(NOW - 72 * 3_600_000).toISOString(), kind: 'webhook' },
]

/** A fake that APPLIES the filters it is given (kind via the embedded source, occurred_at bounds). */
function filteringSupabase() {
  const updates: string[][] = []
  const from = vi.fn(() => {
    const f: { kind?: string; gte?: string; lt?: string; ids?: string[]; update?: boolean; select?: string } = {}
    const b: Record<string, unknown> = {}
    b.select = vi.fn((cols: string) => { f.select = cols; return b })
    for (const m of ['is', 'neq', 'or']) b[m] = vi.fn(() => b)
    b.eq = vi.fn((col: string, val: string) => { if (col === 'outcome_sources.kind') f.kind = val; return b })
    b.gte = vi.fn((_c: string, v: string) => { f.gte = v; return b })
    b.lt = vi.fn((_c: string, v: string) => { f.lt = v; return b })
    b.update = vi.fn(() => { f.update = true; return b })
    b.in = vi.fn(async (_c: string, ids: string[]) => { updates.push(ids); return { error: null } })
    b.limit = vi.fn(async () => {
      // The kind filter only binds through an inner-joined embedded source, as in PostgREST.
      const joined = /outcome_sources![a-z_]+!inner\(kind\)/.test(f.select ?? '')
      const data = ROWS.filter((r) => (!joined || !f.kind || r.kind === f.kind)
        && (!f.gte || r.occurred_at >= f.gte) && (!f.lt || r.occurred_at < f.lt))
      return { data, error: null }
    })
    return b
  })
  return { from, updates }
}

describe('Acuity CAPI sweep source scope', () => {
  beforeEach(() => {
    vi.resetModules()
    state.getAppointment.mockReset().mockImplementation(async (id: number) => ({ id, scheduledBy: null, canceled: false }))
    state.send.mockReset().mockResolvedValue({ mode: 'live', status: 'sent' })
  })

  it('retries and closes out only Acuity outcomes', async () => {
    const db = filteringSupabase()
    const { sweepUnsentCapi } = await import('@/lib/outcomes/adapters/acuity/reconcile')
    const result = await sweepUnsentCapi(db as never, NOW)
    expect(state.getAppointment.mock.calls.map(([id]) => id)).toEqual([777000103])
    expect(result).toMatchObject({ sent: 1, markedMissed: 1 })
    expect(db.updates).toEqual([['acuity-stale']])
  })
})
