import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { gunzipSync } from 'node:zlib'
const mocks = vi.hoisted(() => ({ auth: vi.fn(), account: vi.fn(), load: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: mocks.auth } }) }))
vi.mock('@/lib/accounts/active-account', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/accounts/active-account')>()),
  resolveOnlyActiveAccount: mocks.account,
}))
vi.mock('@/lib/reporting/loader', () => ({ loadReportingSection: mocks.load }))
import { GET } from '@/app/api/reporting/route'

describe('authenticated reporting delivery', () => {
  afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs() })
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubEnv('OWNER_EMAIL', 'owner@example.test')
    mocks.auth.mockResolvedValue({ data: { user: { id: 'owner', email: 'owner@example.test', email_confirmed_at: '2026-01-01T00:00:00Z' } } })
    mocks.account.mockResolvedValue({ ok: true, account: { id: 'db', accountId: 'act_1', accountName: 'Studio' } })
    mocks.load.mockImplementation(async (section, context) => ({ section, context,
      result: { state: 'unavailable', data: null, asOf: null, notes: ['Test source unavailable.'] }, notes: [] }))
  })
  it.each(['application/json', 'application/x-ndjson'])('forwards selected parent history through %s', async accept => {
    const historyEntity = { level: 'adset', id: 'set-7' }
    const query = new URLSearchParams({ section: 'meta', from: '2026-09-02', to: '2026-09-04', historyEntity: JSON.stringify(historyEntity) })
    const response = await GET(new NextRequest(`http://localhost/api/reporting?${query}`, { headers: { Accept: accept } }))
    await response.text()
    expect(response.status).toBe(200)
    expect(mocks.load.mock.calls[0][6]).toEqual({ historyEntity })
  })
  it.each([
    { section: 'business', selector: { level: 'campaign', id: 'c1' } },
    { section: 'meta', selector: { level: 'ad', id: 'a1' } },
    { section: 'meta', selector: { level: 'campaign', id: 'c1', extra: true } },
    { section: 'meta', selector: null },
    { section: 'meta', selector: { level: 'adset', id: 'bad id' } },
    { section: 'meta', selector: { level: 'campaign', id: 'c1' }, details: 'ad1' },
  ])('rejects invalid history selection before account resolution: %j', async ({ section, selector, details }) => {
    const query = new URLSearchParams({ section, historyEntity: JSON.stringify(selector), ...(details ? { details } : {}) })
    const response = await GET(new NextRequest(`http://localhost/api/reporting?${query}`))
    expect(response.status).toBe(400)
    expect(mocks.account).not.toHaveBeenCalled()
    expect(mocks.load).not.toHaveBeenCalled()
  })
  it('rejects unauthenticated access before any account or source read', async () => {
    mocks.auth.mockResolvedValue({ data: { user: null } })
    const response = await GET(new NextRequest('http://localhost/api/reporting?section=meta'))
    expect(response.status).toBe(401)
    expect(mocks.account).not.toHaveBeenCalled()
    expect(mocks.load).not.toHaveBeenCalled()
  })
  it.each(['application/json', 'application/x-ndjson'])('rejects a non-owner before account reads for %s', async (accept) => {
    mocks.auth.mockResolvedValue({ data: { user: { id: 'other', email: 'other@example.test' } } })
    const response = await GET(new NextRequest('http://localhost/api/reporting?section=meta', { headers: { Accept: accept } }))
    expect(response.status).toBe(403)
    expect(response.headers.get('cache-control')).toContain('no-store')
    expect(mocks.account).not.toHaveBeenCalled()
    expect(mocks.load).not.toHaveBeenCalled()
  })
  it('fails closed before account reads when the production owner is unconfigured', async () => {
    vi.stubEnv('OWNER_EMAIL', '')
    vi.stubEnv('VERCEL_ENV', 'production')
    expect((await GET(new NextRequest('http://localhost/api/reporting?section=meta'))).status).toBe(403)
    expect(mocks.account).not.toHaveBeenCalled()
    expect(mocks.load).not.toHaveBeenCalled()
  })
  it('rejects invalid dates and unsupported sources', async () => {
    for (const query of ['section=meta&from=2026-02-30&to=2026-03-02', 'section=other', 'section=meta&from=2026-09-02', 'section=meta&details=1,2,3', 'section=meta&details=../other']) {
      expect((await GET(new NextRequest(`http://localhost/api/reporting?${query}`))).status).toBe(400)
    }
    expect(mocks.load).not.toHaveBeenCalled()
  })
  it('resolves the server account, preserves custom dates and uses private responses', async () => {
    const response = await GET(new NextRequest('http://localhost/api/reporting?section=business&from=2026-08-02&to=2026-08-04&account=attacker'))
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.context.account).toEqual({ id: 'db', metaAccountId: 'act_1', name: 'Studio' })
    expect(body.context.comparison).toEqual({ from: '2026-07-30', to: '2026-08-01' })
    expect(response.headers.get('cache-control')).toContain('no-store')
    expect(mocks.load).toHaveBeenCalledOnce()
  })
  it('loads booking association evidence under the same authenticated account and selected dates', async () => {
    const response = await GET(new NextRequest('http://localhost/api/reporting?section=measurement&from=2026-08-02&to=2026-08-04'))
    expect(response.status).toBe(200)
    expect(mocks.load).toHaveBeenCalledWith('measurement', expect.objectContaining({
      account: { id: 'db', metaAccountId: 'act_1', name: 'Studio' }, range: { from: '2026-08-02', to: '2026-08-04' },
    }), false, [])
  })
  it('does not select an arbitrary account when ownership is ambiguous', async () => {
    mocks.account.mockResolvedValue({ ok: false, reason: 'ambiguous' })
    expect((await GET(new NextRequest('http://localhost/api/reporting?section=meta'))).status).toBe(409)
    expect(mocks.load).not.toHaveBeenCalled()
  })
  it('compresses supported browser responses without changing the evidence or cache boundaries', async () => {
    const response = await GET(new NextRequest('http://localhost/api/reporting?section=meta&details=ad-1,ad-2', { headers: { 'accept-encoding': 'gzip' } }))
    expect(response.headers.get('content-encoding')).toBe('gzip')
    const packet = JSON.parse(gunzipSync(Buffer.from(await response.arrayBuffer())).toString('utf8'))
    expect(packet.context.account.metaAccountId).toBe('act_1')
    expect(packet.section).toBe('meta')
    expect(mocks.load.mock.calls[0][3]).toEqual(['ad-1', 'ad-2'])
    const plain = await GET(new NextRequest('http://localhost/api/reporting?section=meta', { headers: { 'accept-encoding': 'gzip;q=0' } }))
    expect(plain.headers.get('content-encoding')).toBeNull()
  })
  it('preserves packet notes when adding date-range notes', async () => {
    mocks.load.mockImplementation(async (section, context) => ({ section, context,
      result: { state: 'unavailable', data: null, asOf: null, notes: ['Test source unavailable.'] },
      notes: ['Source packet note.'],
    }))
    const response = await GET(new NextRequest('http://localhost/api/reporting?section=meta&from=2026-09-02&to=2099-01-01'))
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.notes).toEqual([
      'Source packet note.',
      'The requested end date included an open or future account day. Reporting ends yesterday in the account timezone.',
    ])
  })
  it('sanitizes unexpected failures', async () => {
    mocks.load.mockRejectedValue(new Error('token=private-secret'))
    const response = await GET(new NextRequest('http://localhost/api/reporting?section=meta'))
    expect(response.status).toBe(503)
    expect(await response.text()).not.toContain('private-secret')
  })
  it.each(['meta', 'business'])('negotiates progressive %s delivery only after authentication and exposes a packet before the loader finishes', async sectionName => {
    let release!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    mocks.load.mockImplementation(async (section, context, _refresh, _details, publish) => {
      const loading = { state: 'loading', data: null, asOf: null, notes: [] }
      const packet = { section, context, notes: ['Source packet note.'], result: { state: 'partial', asOf: context.asOf, notes: [], data: section === 'business' ? {
        metrics: {}, series: [], comparisonSeries: [], types: [], sourceDescription: 'Test', intelligence: { customers: loading, leadTime: loading, upcoming: loading },
      } : {
        metrics: {}, entities: [], series: [], comparisonSeries: [], breakdowns: [], observations: [],
        attributionWindow: 'Test window', reportingTime: 'Test', sourceDescription: 'Test', detailState: 'loading',
      } } }
      publish?.(packet)
      await held
      return { ...packet, result: { ...packet.result, data: section === 'business' ? { metrics: {}, series: [], comparisonSeries: [], types: [], sourceDescription: 'Test' } : { ...packet.result.data, detailState: 'complete' } } }
    })
    let response: Response | undefined
    const pending = GET(new NextRequest(`http://localhost/api/reporting?section=${sectionName}&from=2026-09-02&to=2099-01-01`, {
      headers: { Accept: 'application/x-ndjson, application/json' },
    })).then(value => { response = value })
    try {
      await vi.waitFor(() => expect(response).toBeDefined())
      expect(response!.headers.get('content-type')).toContain('application/x-ndjson')
      expect(response!.headers.get('cache-control')).toContain('no-store')
      expect(response!.headers.get('cache-control')).toContain('no-transform')
      expect(response!.headers.get('vary')).toContain('Accept')
      const reader = response!.body!.getReader()
      const first = JSON.parse(new TextDecoder().decode((await reader.read()).value))
      expect(first.kind).toBe('partial')
      expect(first.packet.notes).toContain('Source packet note.')
      expect(first.packet.notes).toContain('The requested end date included an open or future account day. Reporting ends yesterday in the account timezone.')
      release()
      const last = JSON.parse(new TextDecoder().decode((await reader.read()).value))
      expect(last.kind).toBe('complete')
      expect((await reader.read()).done).toBe(true)
    } finally { release(); await pending }
  })
  it('keeps ordinary JSON when streaming is explicitly unacceptable, and still rejects unauthenticated streams', async () => {
    const json = await GET(new NextRequest('http://localhost/api/reporting?section=meta', { headers: { Accept: 'application/x-ndjson;q=0, application/json' } }))
    expect(json.headers.get('content-type')).toContain('application/json')
    mocks.auth.mockResolvedValue({ data: { user: null } })
    const denied = await GET(new NextRequest('http://localhost/api/reporting?section=meta', { headers: { Accept: 'application/x-ndjson' } }))
    expect(denied.status).toBe(401)
    expect(denied.headers.get('content-type')).toContain('application/json')
  })
  it('ends a hung session check without reading account data, even if auth later resolves', async () => {
    vi.useFakeTimers()
    let release!: (value: unknown) => void
    mocks.auth.mockReturnValue(new Promise(resolve => { release = resolve }))
    let response: Response | undefined
    const finished = GET(new NextRequest('http://localhost/api/reporting?section=meta')).then(value => { response = value })
    await vi.advanceTimersByTimeAsync(10_001)
    expect(response?.status).toBe(503)
    release({ data: { user: { id: 'owner' } } })
    await finished
    expect(mocks.account).not.toHaveBeenCalled()
    expect(mocks.load).not.toHaveBeenCalled()
  })
  it('ends a hung account lookup and never starts a source read', async () => {
    vi.useFakeTimers()
    mocks.account.mockReturnValue(new Promise(() => {}))
    let response: Response | undefined
    const finished = GET(new NextRequest('http://localhost/api/reporting?section=meta')).then(value => { response = value })
    await vi.advanceTimersByTimeAsync(10_001)
    expect(response?.status).toBe(503)
    await finished
    expect(mocks.load).not.toHaveBeenCalled()
  })
  it('treats a provider outage as temporary unavailability instead of an expired session', async () => {
    mocks.auth.mockResolvedValue({ data: { user: null }, error: { status: 503, message: 'token=private-secret' } })
    const response = await GET(new NextRequest('http://localhost/api/reporting?section=meta'))
    expect(response.status).toBe(503)
    expect(await response.text()).not.toContain('private-secret')
    expect(mocks.account).not.toHaveBeenCalled()
  })
})
