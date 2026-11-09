import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { interpretMetaCapiResponse, INVALID_JSON } from '@/lib/capi/acuity-capi'

// The outcome uuid recorded for Acuity appointment 12345 (the delivery ledger is keyed by it).
const OUTCOME_12345 = '00000000-0000-4000-8000-000000012345'
const outcomeLookup = vi.hoisted(() => ({ find: vi.fn() }))
vi.mock('@/lib/outcomes/adapters/acuity/outcome-source', () => ({ findAcuityOutcome: outcomeLookup.find }))

// An HTTP 2xx is NOT delivery. Meta answers 200 `{}` for a request it understood but turned
// into no event, and a proxy can return 2xx with a non-JSON body. The old sender treated
// "res.ok && !body.error" as sent and stamped capi_sent_at from it — a false positive that removed
// the booking from the retry sweep forever.

describe('interpretMetaCapiResponse — the four acceptance conditions', () => {
  it('accepts ONLY events_received exactly 1 on a 2xx with no error', () => {
    const v = interpretMetaCapiResponse(true, 200, { events_received: 1, messages: [], fbtrace_id: 'x' })
    expect(v.accepted).toBe(true)
    if (v.accepted) expect(v.eventsReceived).toBe(1)
  })

  it('rejects invalid JSON', () => {
    const v = interpretMetaCapiResponse(true, 200, INVALID_JSON)
    expect(v.accepted).toBe(false)
    if (!v.accepted) {
      expect(v.errorClass).toBe('invalid_json')
      expect(v.eventsReceived).toBeNull()
    }
  })

  it('rejects a null response body', () => {
    const v = interpretMetaCapiResponse(true, 200, null)
    expect(v.accepted).toBe(false)
    if (!v.accepted) expect(v.errorClass).toBe('null_response')
  })

  it('rejects {} — understood, but no event was created', () => {
    const v = interpretMetaCapiResponse(true, 200, {})
    expect(v.accepted).toBe(false)
    if (!v.accepted) {
      expect(v.errorClass).toBe('malformed_response')
      expect(v.message).toMatch(/no numeric events_received/)
    }
  })

  it('rejects events_received = 0', () => {
    const v = interpretMetaCapiResponse(true, 200, { events_received: 0 })
    expect(v.accepted).toBe(false)
    if (!v.accepted) {
      expect(v.errorClass).toBe('no_events_received')
      expect(v.eventsReceived).toBe(0)
    }
  })

  it('rejects events_received > 1 — the payload was not the single event we sent', () => {
    const v = interpretMetaCapiResponse(true, 200, { events_received: 2 })
    expect(v.accepted).toBe(false)
    if (!v.accepted) {
      expect(v.errorClass).toBe('unexpected_events_received')
      expect(v.eventsReceived).toBe(2)
    }
  })

  it('rejects an HTTP error', () => {
    const v = interpretMetaCapiResponse(false, 500, { events_received: 1 })
    expect(v.accepted).toBe(false)
    if (!v.accepted) expect(v.errorClass).toBe('http_error')
  })

  it('rejects a Meta error object even on a 200 with events_received = 1', () => {
    // The pathological case: Meta reports an error AND a count. The error wins.
    const v = interpretMetaCapiResponse(true, 200, { events_received: 1, error: { message: 'Invalid parameter', code: 100 } })
    expect(v.accepted).toBe(false)
    if (!v.accepted) {
      expect(v.errorClass).toBe('meta_error')
      expect(v.message).toMatch(/Invalid parameter/)
    }
  })

  it('surfaces the Meta error message rather than a bare status code on a 4xx', () => {
    const v = interpretMetaCapiResponse(false, 400, { error: { message: 'Invalid access token', code: 190 } })
    expect(v.accepted).toBe(false)
    if (!v.accepted) {
      expect(v.errorClass).toBe('meta_error')
      expect(v.message).toContain('Invalid access token')
    }
  })

  it('rejects an array body and a string body', () => {
    expect(interpretMetaCapiResponse(true, 200, [{ events_received: 1 }]).accepted).toBe(false)
    expect(interpretMetaCapiResponse(true, 200, 'ok').accepted).toBe(false)
  })

  it('rejects a non-numeric / NaN events_received', () => {
    expect(interpretMetaCapiResponse(true, 200, { events_received: '1' }).accepted).toBe(false)
    expect(interpretMetaCapiResponse(true, 200, { events_received: NaN }).accepted).toBe(false)
  })

  it('never returns an error class that could carry a token or customer value', () => {
    const classes = [
      interpretMetaCapiResponse(true, 200, INVALID_JSON),
      interpretMetaCapiResponse(true, 200, null),
      interpretMetaCapiResponse(true, 200, {}),
      interpretMetaCapiResponse(true, 200, { events_received: 0 }),
      interpretMetaCapiResponse(false, 500, {}),
    ].map((v) => (v.accepted ? 'accepted' : v.errorClass))
    for (const c of classes) expect(c).toMatch(/^[a-z_]+$/)
  })
})

// ── sendAcuityCapiEvent: end-to-end status contract with fetch + the delivery RPC mocked ──────────

const APPT = {
  id: 12345,
  scheduledBy: null,
  datetimeCreated: '2026-07-20T14:00:00-0400',
  email: 'x@example.com',
  price: 410,
  forms: [],
} as unknown as Parameters<typeof import('@/lib/capi/acuity-capi')['sendAcuityCapiEvent']>[0]

/** The full shape record_conversion_delivery contracts to return. */
function rpcOk(over: Record<string, unknown> = {}) {
  return { data: { event_id: 'acuity-12345', outcome_id: OUTCOME_12345, accepted: true, marked_sent: true, ...over }, error: null }
}

function fakeDb(rpcImpl: () => Promise<{ data: unknown; error: { message: string } | null }>) {
  return {
    rpc: vi.fn(rpcImpl),
    from: () => ({ select: () => ({ eq: () => ({ limit: () => ({ maybeSingle: async () => ({ data: { pixel_id: 'PIX' } }) }) }) }) }),
  } as unknown as Parameters<typeof import('@/lib/capi/acuity-capi')['sendAcuityCapiEvent']>[2]
}

function mockFetch(status: number, body: unknown, opts: { invalidJson?: boolean } = {}) {
  return vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      if (opts.invalidJson) throw new SyntaxError('Unexpected token < in JSON')
      return body
    },
  })) as unknown as typeof fetch
}

describe('sendAcuityCapiEvent — delivery status contract', () => {
  const realFetch = globalThis.fetch
  beforeEach(() => {
    process.env.ACUITY_CAPI_SEND = 'true'
    process.env.META_PIXEL_ID = 'PIX'
    process.env.META_CAPI_ACCESS_TOKEN = 'TOKEN'
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-20T15:00:00Z'))
    outcomeLookup.find.mockReset()
    outcomeLookup.find.mockResolvedValue({ id: OUTCOME_12345, currency: 'USD' })
  })
  afterEach(() => {
    globalThis.fetch = realFetch
    vi.useRealTimers()
    vi.restoreAllMocks()
    delete process.env.ACUITY_CAPI_SEND
    delete process.env.META_PIXEL_ID
    delete process.env.META_CAPI_ACCESS_TOKEN
  })

  const send = async (
    status: number,
    body: unknown,
    rpc: () => Promise<{ data: unknown; error: { message: string } | null }> = async () => rpcOk(),
    opts: { invalidJson?: boolean } = {},
  ) => {
    globalThis.fetch = mockFetch(status, body, opts)
    const { sendAcuityCapiEvent } = await import('@/lib/capi/acuity-capi')
    return sendAcuityCapiEvent(APPT, null, fakeDb(rpc))
  }

  it('events_received = 1 with a durable audit row => sent', async () => {
    const out = await send(200, { events_received: 1 })
    expect(out.status).toBe('sent')
    expect(out.deliveryRecorded).toBe(true)
    expect(out.eventId).toBe('acuity-12345')
  })

  it('events_received = 0 => error, NOT sent', async () => {
    const out = await send(200, { events_received: 0 })
    expect(out.status).toBe('error')
    expect(out.errorClass).toBe('no_events_received')
    expect(out.eventsReceived).toBe(0)
  })

  it('events_received = 2 => error, NOT sent', async () => {
    const out = await send(200, { events_received: 2 })
    expect(out.status).toBe('error')
    expect(out.errorClass).toBe('unexpected_events_received')
  })

  it('a 200 with {} => error, NOT sent (the false positive the old sender accepted)', async () => {
    const out = await send(200, {})
    expect(out.status).toBe('error')
    expect(out.errorClass).toBe('malformed_response')
  })

  it('a 200 with a null body => error', async () => {
    const out = await send(200, null)
    expect(out.status).toBe('error')
    expect(out.errorClass).toBe('null_response')
  })

  it('invalid JSON => error', async () => {
    const out = await send(200, undefined, undefined, { invalidJson: true })
    expect(out.status).toBe('error')
    expect(out.errorClass).toBe('invalid_json')
  })

  it('an HTTP error => error', async () => {
    const out = await send(503, {})
    expect(out.status).toBe('error')
    expect(out.errorClass).toBe('http_error')
  })

  it('a Meta error object => error', async () => {
    const out = await send(200, { error: { message: 'Invalid parameter', code: 100 } })
    expect(out.status).toBe('error')
    expect(out.errorClass).toBe('meta_error')
  })

  it('Meta ACCEPTED but the audit write failed => accepted_unrecorded (critical, retryable)', async () => {
    const out = await send(200, { events_received: 1 }, async () => ({ data: null, error: { message: 'connection reset' } }))
    expect(out.status).toBe('accepted_unrecorded')
    expect(out.errorClass).toBe('audit_persistence_failed')
    expect(out.deliveryRecorded).toBe(false)
    // Meta has the event; delivery state stays unset so the sweep retries the SAME event_id.
    expect(out.eventId).toBe('acuity-12345')
    expect(out.eventsReceived).toBe(1)
  })

  it('an RPC that returns no state is treated as a failed audit write, not a success', async () => {
    const out = await send(200, { events_received: 1 }, async () => ({ data: null, error: null }))
    expect(out.status).toBe('accepted_unrecorded')
  })

  // ── The sender no longer trusts the RPC's word ──
  it('a MISMATCHED event_id from the RPC is treated as a failed audit write', async () => {
    const out = await send(200, { events_received: 1 }, async () => rpcOk({ event_id: 'acuity-99999' }))
    expect(out.status).toBe('accepted_unrecorded')
    expect(out.errorClass).toBe('audit_persistence_failed')
  })

  it('a MISMATCHED outcome_id from the RPC is treated as a failed audit write', async () => {
    const out = await send(200, { events_received: 1 }, async () => rpcOk({ outcome_id: '00000000-0000-4000-8000-000000000999' }))
    expect(out.status).toBe('accepted_unrecorded')
  })

  it('an RPC that DISAGREES about acceptance is treated as a failed audit write', async () => {
    const out = await send(200, { events_received: 1 }, async () => rpcOk({ accepted: false }))
    expect(out.status).toBe('accepted_unrecorded')
  })

  it('a live acceptance that did NOT mark the parent stays retryable', async () => {
    const out = await send(200, { events_received: 1 }, async () => rpcOk({ marked_sent: false }))
    expect(out.status).toBe('accepted_unrecorded')
    expect(out.deliveryRecorded).toBe(false)
  })

  it('an RPC that throws is treated as a failed audit write', async () => {
    const out = await send(200, { events_received: 1 }, async () => { throw new Error('pool exhausted') })
    expect(out.status).toBe('accepted_unrecorded')
  })

  it('a FAILED send still records lineage, with the error class and no acceptance', async () => {
    let captured: Record<string, unknown> | null = null
    globalThis.fetch = mockFetch(200, { events_received: 0 })
    const { sendAcuityCapiEvent } = await import('@/lib/capi/acuity-capi')
    const db = fakeDb(async () => rpcOk({ accepted: false, marked_sent: false })) as unknown as {
      rpc: (name: string, args: Record<string, unknown>) => Promise<unknown>
    }
    const orig = db.rpc
    db.rpc = async (name: string, args: Record<string, unknown>) => { captured = args; return orig(name, args) }
    await sendAcuityCapiEvent(APPT, null, db as never)
    expect(captured).not.toBeNull()
    expect(captured!.p_events_received).toBe(0)
    expect(captured!.p_error_state).toBe('no_events_received')
    expect(captured!.p_event_id).toBe('acuity-12345')
  })

  it('passes the stable deterministic event_id and the api version to the audit RPC', async () => {
    let captured: Record<string, unknown> | null = null
    globalThis.fetch = mockFetch(200, { events_received: 1 })
    const { sendAcuityCapiEvent } = await import('@/lib/capi/acuity-capi')
    const db = { rpc: async (_n: string, a: Record<string, unknown>) => { captured = a; return rpcOk() } }
    await sendAcuityCapiEvent(APPT, null, db as never)
    expect(captured!.p_event_id).toBe('acuity-12345')
    expect(captured!.p_outcome_id).toBe(OUTCOME_12345)
    expect(captured!.p_send_mode).toBe('live')
    expect(captured!.p_value).toBe(410)
    expect(captured!.p_currency).toBe('USD')
    expect(String(captured!.p_api_version)).toMatch(/^v\d+\.\d+$/)
  })

  it("sends and records the outcome's own currency (EUR, JPY), never a fixed USD", async () => {
    for (const [currency, price, value] of [['EUR', 410.5, 410.5], ['JPY', 1500, 1500]] as const) {
      let captured: Record<string, unknown> | null = null
      const fetchMock = mockFetch(200, { events_received: 1 })
      globalThis.fetch = fetchMock
      const { sendAcuityCapiEvent } = await import('@/lib/capi/acuity-capi')
      const db = { rpc: async (_n: string, a: Record<string, unknown>) => { captured = a; return rpcOk() } }
      outcomeLookup.find.mockResolvedValueOnce({ id: OUTCOME_12345, currency })
      const out = await sendAcuityCapiEvent({ ...APPT, price } as typeof APPT, null, db as never)
      expect(out.status, currency).toBe('sent')
      const body = JSON.parse(String((fetchMock as unknown as { mock: { calls: Array<[string, RequestInit]> } }).mock.calls[0][1].body))
      expect(body.data[0].custom_data, currency).toEqual({ value, currency })
      expect(captured!.p_currency, currency).toBe(currency)
      expect(captured!.p_value, currency).toBe(value)
    }
  })

  it('retrying the same appointment always produces the SAME event_id (no double-count)', async () => {
    const seen: string[] = []
    globalThis.fetch = mockFetch(200, { events_received: 1 })
    const { sendAcuityCapiEvent } = await import('@/lib/capi/acuity-capi')
    const db = { rpc: async (_n: string, a: Record<string, unknown>) => { seen.push(String(a.p_event_id)); return rpcOk() } }
    await sendAcuityCapiEvent(APPT, null, db as never)
    await sendAcuityCapiEvent(APPT, null, db as never)
    expect(seen).toEqual(['acuity-12345', 'acuity-12345'])
  })

  it('never sends an event whose delivery has no recorded outcome to audit it', async () => {
    const fetchMock = mockFetch(200, { events_received: 1 })
    globalThis.fetch = fetchMock
    const { sendAcuityCapiEvent } = await import('@/lib/capi/acuity-capi')
    const rpc = vi.fn(async () => rpcOk())
    const db = { rpc }

    outcomeLookup.find.mockResolvedValueOnce(null)
    const unresolved = await sendAcuityCapiEvent(APPT, null, db as never)
    expect(outcomeLookup.find).toHaveBeenCalledWith(db, 12345)
    outcomeLookup.find.mockRejectedValueOnce(new Error('lookup failed'))
    const lookupFailed = await sendAcuityCapiEvent(APPT, null, db as never)

    for (const out of [unresolved, lookupFailed]) {
      expect(out.status).toBe('error')
      expect(out.errorClass).toBe('outcome_unresolved')
      expect(out.deliveryRecorded).toBe(false)
      expect(out.eventId).toBe('acuity-12345')
    }
    expect(fetchMock).not.toHaveBeenCalled()
    expect(rpc).not.toHaveBeenCalled()
  })
})
