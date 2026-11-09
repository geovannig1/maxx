import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { gunzipSync } from 'node:zlib'
import { createReportingSnapshot, makeReportingSnapshotScope, reportingFingerprint } from '@/lib/reporting/snapshot-contract'
import { META_DETAILS_LOADING_NOTE } from '@/lib/reporting/contracts'
import { expandPacket } from '@/lib/reporting/packet-format'
import { snapshotContext, snapshotPacket } from './fixtures/reporting-snapshot'

const mocks = vi.hoisted(() => ({
  auth: vi.fn(), account: vi.fn(), load: vi.fn(), admin: vi.fn(), readSnapshot: vi.fn(), readSnapshotById: vi.fn(),
  readJob: vi.fn(), claim: vi.fn(), run: vi.fn(), after: vi.fn(), db: { from: vi.fn(), rpc: vi.fn() },
}))
vi.mock('next/server', async original => ({ ...await original<typeof import('next/server')>(), after: mocks.after }))
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: mocks.auth } }) }))
vi.mock('@/lib/supabase/admin', () => ({ getAdminClient: mocks.admin }))
vi.mock('@/lib/accounts/active-account', () => ({
  resolveOnlyActiveAccount: mocks.account,
  activeAccountErrorCode: (reason: string) => `ACTIVE_ACCOUNT_${reason.toUpperCase()}`,
}))
vi.mock('@/lib/reporting/loader', () => ({ loadReportingSection: mocks.load }))
vi.mock('@/lib/reporting/snapshot-store', () => ({ readLatestReportingSnapshot: mocks.readSnapshot, readReportingSnapshotById: mocks.readSnapshotById }))
vi.mock('@/lib/reporting/refresh-jobs', () => ({ readReportingRefreshJob: mocks.readJob, claimReportingRefresh: mocks.claim }))
vi.mock('@/lib/reporting/refresh-worker', () => ({ runReportingRefresh: mocks.run }))
import * as route from '@/app/api/reporting/route'

const mediaType = 'application/vnd.maxx.prepared-report+json'
const now = '2026-09-05T17:00:30.000Z'
const jobId = '00000000-0000-4000-8000-000000001321'
const snapshotId = '00000000-0000-4000-8000-000000001331'
const scope = makeReportingSnapshotScope('meta', snapshotContext)
const packet = snapshotPacket()
const storedSnapshot = createReportingSnapshot(scope, packet, '2026-09-05T17:00:10.000Z')
const saved = { id: snapshotId, fingerprint: reportingFingerprint(storedSnapshot), createdAt: now, snapshot: storedSnapshot }
function job(extra: Record<string, unknown> = {}) {
  return { id: jobId, scope, scopeKey: 'sha256:fixture', status: 'running', startedAt: snapshotContext.asOf,
    leaseExpiresAt: '2026-09-05T17:02:00.000Z', leaseToken: 'private-lease-token', completedAt: null,
    failureCode: null, snapshotId: null, progress: null, createdAt: snapshotContext.asOf, ...extra }
}
function request(query = '', init: RequestInit = {}) {
  return new NextRequest(`http://localhost/api/reporting?section=meta&from=2026-09-02&to=2026-09-04${query}`, {
    ...init, signal: init.signal ?? undefined, headers: { Accept: mediaType, ...init.headers },
  })
}
function post(query = '', init: RequestInit = {}) {
  return request(query, { method: 'POST', body: JSON.stringify({ refresh: false }), ...init,
    headers: { Origin: 'http://localhost', 'Content-Type': 'application/json', ...init.headers } })
}

describe('prepared owner reporting API', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(now))
    vi.stubEnv('OWNER_EMAIL', 'owner@example.test')
    vi.stubEnv('REPORTING_PREPARED_ENABLED', 'on')
    mocks.auth.mockResolvedValue({ data: { user: { id: 'owner', email: 'owner@example.test', email_confirmed_at: '2026-01-01T00:00:00Z' } } })
    mocks.account.mockResolvedValue({ ok: true, account: { id: snapshotContext.account.id,
      accountId: snapshotContext.account.metaAccountId, accountName: 'Current account name' } })
    mocks.admin.mockReturnValue(mocks.db)
    mocks.readSnapshot.mockResolvedValue(saved)
    mocks.readSnapshotById.mockResolvedValue(saved)
    mocks.readJob.mockResolvedValue(null)
    mocks.claim.mockResolvedValue({ claimed: false, job: null })
    mocks.load.mockResolvedValue(packet)
    mocks.run.mockResolvedValue({ status: 'complete', snapshotId })
  })
  afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs() })

  it('serves stored evidence without starting a source read, claiming a job, or rewriting its context', async () => {
    const response = await route.GET(request('&account=attacker&refresh=1'))
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain(mediaType)
    expect(await response.json()).toEqual({ kind: 'prepared-report', version: 1, scope, packet,
      snapshot: { id: snapshotId, fingerprint: saved.fingerprint, retrievalStartedAt: snapshotContext.asOf, retrievalCompletedAt: '2026-09-05T17:00:10.000Z' },
      job: null, needsRefresh: false })
    expect(mocks.readSnapshot).toHaveBeenCalledWith(mocks.db, scope, expect.any(AbortSignal))
    expect(mocks.load).not.toHaveBeenCalled()
    expect(mocks.claim).not.toHaveBeenCalled()
    expect(mocks.after).not.toHaveBeenCalled()
  })

  it.each(['GET', 'POST'] as const)('delivers a large prepared %s response within the host payload limit without losing evidence', async method => {
    const largePacket = { ...packet, notes: ['Full supplied report evidence. '.repeat(180_000)] }
    mocks.readSnapshot.mockResolvedValue({ ...saved, snapshot: { ...storedSnapshot, packet: largePacket } })
    const input = method === 'GET' ? request('', { headers: { 'accept-encoding': 'br, gzip;q=0.8' } })
      : post('', { headers: { 'accept-encoding': 'gzip' } })
    const response = await route[method](input)
    const bytes = new Uint8Array(await response.arrayBuffer())
    expect(response.status).toBe(200)
    expect(response.headers.get('content-encoding')).toBe('gzip')
    expect(response.headers.get('content-type')).toContain(mediaType)
    expect(response.headers.get('vary')).toContain('Accept-Encoding')
    expect(bytes.byteLength).toBeLessThan(4_500_000)
    const body = JSON.parse(gunzipSync(bytes).toString('utf8'))
    expect(body.packet).toEqual(largePacket)
    expect(body.scope).toEqual(scope)
    expect(body.snapshot.id).toBe(snapshotId)
  })

  it('keeps prepared JSON readable when gzip is explicitly refused', async () => {
    const response = await route.GET(request('', { headers: { 'accept-encoding': 'gzip;q=0' } }))
    expect(response.headers.has('content-encoding')).toBe(false)
    expect(await response.json()).toMatchObject({ packet, scope })
  })

  it('reports missing and expired saved evidence as needing refresh without mutating storage', async () => {
    mocks.readSnapshot.mockResolvedValueOnce(null)
    expect(await (await route.GET(request())).json()).toMatchObject({ packet: null, snapshot: null, needsRefresh: true })
    vi.setSystemTime(Date.parse(storedSnapshot.retrieval.completedAt) + 60_000) // exactly the 60 s expiry boundary
    expect(await (await route.GET(request())).json()).toMatchObject({ packet, needsRefresh: true })
    expect(mocks.claim).not.toHaveBeenCalled()
    expect(mocks.load).not.toHaveBeenCalled()
  })

  it('keeps requested and effective range identities and normalizes only Meta detail IDs', async () => {
    mocks.readSnapshot.mockResolvedValue(null)
    const meta = await (await route.GET(request('&details=ad-z,ad-a'))).json()
    expect(meta.scope.detailIds).toEqual(['ad-a', 'ad-z'])
    const clamped = await (await route.GET(new NextRequest('http://localhost/api/reporting?section=business&from=2026-09-02&to=2099-01-01&details=ad-z', {
      headers: { Accept: mediaType },
    }))).json()
    expect(clamped.scope).toMatchObject({ source: 'business', requestedRange: { from: '2026-09-02', to: '2099-01-01' },
      range: { from: '2026-09-02', to: '2026-09-04' }, comparison: { from: '2026-08-30', to: '2026-09-01' }, detailIds: [] })
  })

  it('publishes only public job fields and keeps prior immutable evidence while refreshing', async () => {
    const progress = { ...packet, result: { ...packet.result, data: { ...packet.result.data!, detailState: 'loading' } } }
    mocks.readJob.mockResolvedValue(job({ progress }))
    const response = await route.GET(request())
    const body = await response.json()
    expect(body.packet).toEqual(packet)
    expect(body.job).toEqual({ id: jobId, status: 'running', startedAt: snapshotContext.asOf,
      leaseExpiresAt: '2026-09-05T17:02:00.000Z', completedAt: null, failureCode: null, snapshotId: null })
    expect(JSON.stringify(body)).not.toContain('private-lease-token')
    expect(JSON.stringify(body)).not.toContain('scopeKey')
  })

  it('exposes an actual pending packet without snapshot metadata when no saved evidence exists', async () => {
    const progress = { ...packet, result: { ...packet.result,
      notes: [...packet.result.notes, META_DETAILS_LOADING_NOTE], data: { ...packet.result.data!, detailState: 'loading' } } }
    mocks.readJob.mockResolvedValue(job({ progress }))
    mocks.readSnapshot.mockResolvedValue(null)
    const body = await (await route.GET(request())).json()
    // Progress travels as packetVersion 2; its expansion is the pending packet.
    expect(body.packet.packetVersion).toBe(2)
    expect(expandPacket(body.packet)).toEqual(progress)
    expect(body.snapshot).toBeNull()
    expect(body.needsRefresh).toBe(true)
    expect(body.job.status).toBe('running')
  })

  it('stops expired progress wording without mutating the job or claiming recovery on GET', async () => {
    const progress = { ...packet, result: { ...packet.result,
      notes: [...packet.result.notes, META_DETAILS_LOADING_NOTE], data: { ...packet.result.data!, detailState: 'loading' } } }
    const expired = job({ leaseExpiresAt: '2026-09-05T17:00:20.000Z', progress })
    mocks.readSnapshot.mockResolvedValue(null)
    mocks.readJob.mockResolvedValue(expired)
    const body = await (await route.GET(request())).json()
    expect(body.job).toMatchObject({ status: 'failed', failureCode: 'interrupted' })
    expect(body.snapshot).toBeNull()
    const sent = expandPacket(body.packet) as typeof progress
    expect(sent.result.data.detailState).toBe('unavailable')
    expect(sent.result.notes).not.toContain(META_DETAILS_LOADING_NOTE)
    expect(sent.result.data.metrics).toEqual(packet.result.data!.metrics)
    expect(expired.status).toBe('running')
    expect(progress.result.data.detailState).toBe('loading')
    expect(mocks.claim).not.toHaveBeenCalled()
  })

  it('looks up the requested attempt and its exact completed snapshot instead of switching to the latest one', async () => {
    mocks.readJob.mockResolvedValue(job({ status: 'complete', completedAt: '2026-09-05T17:00:10.000Z', snapshotId }))
    const body = await (await route.GET(request(`&job=${jobId}`))).json()
    expect(body.snapshot?.id).toBe(snapshotId)
    expect(body.job?.id).toBe(jobId)
    expect(mocks.readJob).toHaveBeenCalledWith(mocks.db, scope, jobId, expect.any(AbortSignal))
    expect(mocks.readSnapshotById).toHaveBeenCalledWith(mocks.db, scope, snapshotId, expect.any(AbortSignal))
    expect(mocks.readSnapshot).not.toHaveBeenCalled()
  })

  it('rejects missing scoped jobs, malformed IDs and incomplete storage publication', async () => {
    mocks.readJob.mockResolvedValue(null)
    expect((await route.GET(request(`&job=${jobId}`))).status).toBe(404)
    expect((await route.GET(request('&job=invalid'))).status).toBe(400)
    mocks.readJob.mockResolvedValue(job({ status: 'complete', completedAt: now, snapshotId }))
    mocks.readSnapshotById.mockResolvedValue(null)
    expect((await route.GET(request(`&job=${jobId}`))).status).toBe(503)
    expect(mocks.claim).not.toHaveBeenCalled()
  })

  it('retains a failed exact job with prior evidence without starting another attempt', async () => {
    mocks.readJob.mockResolvedValue(job({ status: 'failed', completedAt: now, failureCode: 'source_unavailable' }))
    const response = await route.GET(request(`&job=${jobId}`))
    expect(await response.json()).toMatchObject({ packet, job: { id: jobId, status: 'failed', failureCode: 'source_unavailable' } })
    expect(mocks.claim).not.toHaveBeenCalled()
  })

  it.each(['GET', 'POST'] as const)('authenticates and gates ownership before prepared storage access on %s', async method => {
    for (const [user, status] of [[null, 401], [{ id: 'other', email: 'other@example.test' }, 403]] as const) {
      mocks.auth.mockResolvedValue({ data: { user } })
      const response = await route[method](method === 'GET' ? request() : post())
      expect(response.status).toBe(status)
    }
    expect(mocks.account).not.toHaveBeenCalled()
    expect(mocks.admin).not.toHaveBeenCalled()
    expect(mocks.load).not.toHaveBeenCalled()
    expect(mocks.claim).not.toHaveBeenCalled()
  })

  it.each([
    ['not_found', 'GET', 404, 'ACTIVE_ACCOUNT_NOT_FOUND'],
    ['ambiguous', 'GET', 409, 'ACTIVE_ACCOUNT_AMBIGUOUS'],
    ['unavailable', 'POST', 503, 'ACTIVE_ACCOUNT_UNAVAILABLE'],
  ] as const)('returns account-resolution code for %s on %s', async (reason, method, status, code) => {
    mocks.account.mockResolvedValue({ ok: false, reason })
    const response = await route[method](method === 'GET' ? request() : post())
    expect(response.status).toBe(status)
    expect(response.headers.get('x-reporting-error-code')).toBe(code)
    expect(await response.json()).toMatchObject({ code })
    expect(mocks.admin).not.toHaveBeenCalled()
    expect(mocks.load).not.toHaveBeenCalled()
    expect(mocks.claim).not.toHaveBeenCalled()
  })

  it('keeps feature-off GET on the legacy path and makes feature-off POST side-effect free', async () => {
    vi.stubEnv('REPORTING_PREPARED_ENABLED', 'off')
    expect((await (await route.GET(request())).json()).section).toBe('meta')
    expect(mocks.load).toHaveBeenCalledOnce()
    vi.clearAllMocks()
    expect((await route.POST(post())).status).toBe(503)
    expect(mocks.auth).not.toHaveBeenCalled()
    expect(mocks.account).not.toHaveBeenCalled()
    expect(mocks.admin).not.toHaveBeenCalled()
    expect(mocks.claim).not.toHaveBeenCalled()
  })

  it.each(['application/json', `${mediaType};q=0, application/json`])('preserves legacy JSON negotiation for %s', async accept => {
    const response = await route.GET(request('', { headers: { Accept: accept } }))
    expect((await response.json()).section).toBe('meta')
    expect(mocks.load).toHaveBeenCalledOnce()
    expect(mocks.admin).not.toHaveBeenCalled()
  })

  it('returns a claimed job before its source work completes, with a worker independent of request cancellation', async () => {
    const claimed = job()
    mocks.claim.mockResolvedValue({ claimed: true, job: claimed })
    let release!: () => void
    mocks.run.mockImplementation(() => new Promise<void>(resolve => { release = resolve }))
    const controller = new AbortController()
    const response = await route.POST(post('&account=attacker&refresh=1', { signal: controller.signal }))
    expect(response.status).toBe(202)
    expect(await response.json()).toMatchObject({ packet, job: { id: jobId, status: 'running' } })
    expect(mocks.claim).toHaveBeenCalledWith(mocks.db, scope, false, expect.any(AbortSignal))
    expect(mocks.run).not.toHaveBeenCalled()
    expect(mocks.after).toHaveBeenCalledOnce()
    controller.abort()
    const work = mocks.after.mock.calls[0][0]()
    expect(mocks.run).toHaveBeenCalledWith(mocks.db, claimed, 'Current account name')
    release()
    await work
  })

  it('joins an active matching job without scheduling duplicate work and passes explicit force to the claim', async () => {
    mocks.claim.mockResolvedValue({ claimed: false, job: job() })
    const response = await route.POST(post('', { body: JSON.stringify({ refresh: true }) }))
    expect(response.status).toBe(202)
    expect((await response.json()).job.id).toBe(jobId)
    expect(mocks.claim).toHaveBeenCalledWith(mocks.db, scope, true, expect.any(AbortSignal))
    expect(mocks.after).not.toHaveBeenCalled()
    expect(mocks.run).not.toHaveBeenCalled()
  })

  it('returns reusable evidence when a normal open requires no job', async () => {
    const response = await route.POST(post())
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ packet, job: null, needsRefresh: false })
    expect(mocks.after).not.toHaveBeenCalled()
  })

  it('bounds a body that never finishes and cancels its reader before any claim', async () => {
    vi.useFakeTimers()
    const cancel = vi.fn()
    const body = new ReadableStream<Uint8Array>({ cancel })
    const pending = route.POST(post('', { body, duplex: 'half' } as RequestInit))
    await vi.advanceTimersByTimeAsync(5_001)
    expect((await pending).status).toBe(408)
    expect(cancel).toHaveBeenCalledOnce()
    expect(mocks.account).not.toHaveBeenCalled()
    expect(mocks.claim).not.toHaveBeenCalled()
  })

  it.each([
    [{ headers: { Origin: 'https://attacker.test' } }, 403],
    [{ headers: { Origin: 'http://localhost/' } }, 403],
    [{ headers: { Origin: '' } }, 403],
    [{ headers: { Accept: 'application/json' } }, 406],
    [{ headers: { 'Content-Type': 'text/plain' } }, 415],
    [{ body: 'not json' }, 400], [{ body: '{}' }, 400],
    [{ body: '{"refresh":"true"}' }, 400], [{ body: '{"refresh":true,"account":"attacker"}' }, 400],
    [{ body: 'null' }, 400], [{ body: `{"refresh":false,"padding":"${'x'.repeat(1024)}"}` }, 413],
  ] satisfies [RequestInit, number][])('rejects invalid POST input before account resolution: %j', async (init, status) => {
    const response = await route.POST(post('', init))
    expect(response.status).toBe(status)
    expect(mocks.account).not.toHaveBeenCalled()
    expect(mocks.admin).not.toHaveBeenCalled()
    expect(mocks.claim).not.toHaveBeenCalled()
    expect(mocks.after).not.toHaveBeenCalled()
  })

  it.each(['GET', 'POST'] as const)('fails closed on missing storage for %s without exposing internals or loading sources', async method => {
    mocks.readSnapshot.mockRejectedValue(new Error('missing migration; token=private-secret'))
    mocks.claim.mockRejectedValue(new Error('missing migration; token=private-secret'))
    const response = await route[method](method === 'GET' ? request() : post())
    expect(response.status).toBe(503)
    expect(await response.text()).not.toContain('private-secret')
    expect(mocks.load).not.toHaveBeenCalled()
    expect(mocks.after).not.toHaveBeenCalled()
  })
})
