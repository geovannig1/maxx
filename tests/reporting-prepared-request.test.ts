import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { requestReportingPacket } from '@/lib/reporting/request-packet'
import { REPORTING_PREPARED_TYPE } from '@/lib/reporting/prepared-contract'
import { REPORTING_REQUEST_TIMEOUT_MS } from '@/lib/reporting/deadline'
import { preparedReply, preparedRunning, preparedComplete, preparedKey, preparedJobId } from './fixtures/reporting-prepared'

const fetcher = vi.fn<typeof fetch>()
function response(value: unknown) { return Response.json(value, { headers: { 'Content-Type': REPORTING_PREPARED_TYPE } }) }
function request(progress = vi.fn(), refresh = false, signal = new AbortController().signal) {
  return requestReportingPacket('meta', preparedKey, signal, refresh, progress)
}
async function settlePoll() { await vi.advanceTimersByTimeAsync(1_000) }
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-05T17:02:20Z'))
  fetcher.mockReset(); vi.stubGlobal('fetch', fetcher)
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

describe('prepared browser reporting requests', () => {
  it('requires the exact selected parent on every prepared reply', async () => {
    const historyEntity = { level: 'campaign', id: 'campaign-1' } as const
    const selectedKey = `${preparedKey}&${new URLSearchParams({ historyEntity: JSON.stringify(historyEntity) })}`
    const ready = { ...preparedReply(), needsRefresh: false }
    fetcher.mockResolvedValue(response(ready))
    await expect(requestReportingPacket('meta', selectedKey, new AbortController().signal)).rejects.toMatchObject({ kind: 'invalid' })
    ready.scope = { ...ready.scope, historyEntity }
    fetcher.mockResolvedValue(response(ready))
    expect(await requestReportingPacket('meta', selectedKey, new AbortController().signal)).toEqual(ready.packet)
    for (const wrong of [{ level: 'adset', id: historyEntity.id }, { ...historyEntity, id: 'campaign-2' }]) {
      fetcher.mockResolvedValue(response({ ...ready, scope: { ...ready.scope, historyEntity: wrong } }))
      await expect(requestReportingPacket('meta', selectedKey, new AbortController().signal)).rejects.toMatchObject({ kind: 'invalid' })
    }
    fetcher.mockResolvedValue(response(ready))
    await expect(request()).rejects.toMatchObject({ kind: 'invalid' })
  })
  it('negotiates prepared reports and immediately returns reusable evidence without starting a job', async () => {
    const ready = { ...preparedReply(), needsRefresh: false }
    fetcher.mockResolvedValue(response(ready))
    expect(await request()).toEqual(ready.packet)
    expect(fetcher).toHaveBeenCalledOnce()
    expect(fetcher.mock.calls[0][1]?.headers).toMatchObject({ Accept: expect.stringContaining(REPORTING_PREPARED_TYPE) })
    expect(vi.getTimerCount()).toBe(0)
  })
  it('shows saved evidence before POST finishes, starts once, and polls the exact job to its publication', async () => {
    const progress = vi.fn()
    let postResolve!: (value: Response) => void
    fetcher.mockResolvedValueOnce(response(preparedReply()))
      .mockImplementationOnce(() => new Promise(resolve => { postResolve = resolve }))
      .mockResolvedValueOnce(response(preparedComplete()))
    const result = request(progress)
    await vi.advanceTimersByTimeAsync(0)
    expect(progress).toHaveBeenCalledWith(preparedReply().packet)
    expect(fetcher.mock.calls[1][1]).toMatchObject({ method: 'POST', body: JSON.stringify({ refresh: false }) })
    postResolve(response(preparedRunning()))
    await settlePoll()
    expect(await result).toEqual(preparedComplete().packet)
    expect(new URL(String(fetcher.mock.calls[2][0]), 'http://local.test').searchParams.get('job')).toBe(preparedJobId)
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1)
  })
  it('joins an existing active job without a second work request and exposes actual pending totals', async () => {
    fetcher.mockResolvedValueOnce(response(preparedRunning(true))).mockResolvedValueOnce(response(preparedComplete()))
    const progress = vi.fn(), result = request(progress)
    await vi.advanceTimersByTimeAsync(0)
    expect(progress.mock.calls[0][0].result.data.detailState).toBe('loading')
    await settlePoll()
    expect(await result).toEqual(preparedComplete().packet)
    expect(fetcher.mock.calls.every(([, init]) => !init?.method || init.method === 'GET')).toBe(true)
  })
  it('explicit refresh bypasses a reusable result but still starts only once', async () => {
    fetcher.mockResolvedValueOnce(response({ ...preparedReply(), needsRefresh: false }))
      .mockResolvedValueOnce(response(preparedRunning())).mockResolvedValueOnce(response(preparedComplete()))
    const result = request(vi.fn(), true)
    await settlePoll()
    expect(await result).toEqual(preparedComplete().packet)
    expect(fetcher.mock.calls[1][1]?.body).toBe(JSON.stringify({ refresh: true }))
  })
  it('handles a concurrent fresh-publication race without manufacturing another job', async () => {
    fetcher.mockResolvedValueOnce(response(preparedReply()))
      .mockResolvedValueOnce(response({ ...preparedReply(), needsRefresh: false }))
    expect(await request()).toEqual(preparedReply().packet)
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
  it.each(['source_unavailable', 'interrupted'] as const)('ends polling on %s and retains earlier evidence as progress', async failureCode => {
    const failed = preparedRunning(); failed.job = { ...failed.job!, status: 'failed', failureCode, completedAt: '2026-09-05T17:02:30Z' }
    fetcher.mockResolvedValueOnce(response(preparedRunning())).mockResolvedValueOnce(response(failed))
    const progress = vi.fn(), result = request(progress).catch(error => error)
    await settlePoll()
    expect(await result).toMatchObject({ kind: 'transient' })
    expect(progress.mock.calls[0][0]).toEqual(preparedReply().packet)
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
  })
  it.each([401, 403])('propagates access denial during polling (%s) so the hook can clear all evidence', async status => {
    fetcher.mockResolvedValueOnce(response(preparedRunning())).mockResolvedValueOnce(new Response('secret', { status }))
    const result = request().catch(error => error)
    await settlePoll()
    expect(await result).toMatchObject({ kind: 'access' })
  })
  it('rejects wrong requested scope and rejects a packet that does not match its claimed account', async () => {
    const wrongPeriod = preparedReply(); wrongPeriod.scope.requestedRange.to = '2026-09-06'
    const wrongPacket = preparedReply(); wrongPacket.packet!.context.account.metaAccountId = 'act_456'
    const wrongDetail = preparedReply(); wrongDetail.scope.detailIds = ['unrequested']
    for (const bad of [wrongPeriod, wrongPacket, wrongDetail]) {
      fetcher.mockResolvedValue(response(bad))
      await expect(request()).rejects.toMatchObject({ kind: 'invalid' })
    }
  })
  it('never switches to another account or job silently during polling', async () => {
    for (const change of ['account', 'job', 'lease']) {
      const bad = preparedComplete()
      if (change === 'account') bad.scope.metaAccountId = 'act_456'
      else if (change === 'job') bad.job!.id = '00000000-0000-4000-8000-000000009999'
      else bad.job!.leaseExpiresAt = '2026-09-05T17:05:00Z'
      fetcher.mockReset().mockResolvedValueOnce(response(preparedRunning())).mockResolvedValueOnce(response(bad))
      const result = request().catch(error => error)
      await settlePoll()
      expect(await result).toMatchObject({ kind: 'invalid' })
    }
  })
  it('rejects terminal responses without their bound completed snapshot and private lease fields', async () => {
    const missing = preparedComplete(); missing.snapshot = null
    const mismatched = preparedComplete(); mismatched.job!.snapshotId = preparedReply().snapshot!.id
    const expiredCompletion = preparedComplete(); expiredCompletion.job!.completedAt = expiredCompletion.job!.leaseExpiresAt
    const leaked = { ...preparedRunning(), job: { ...preparedRunning().job, leaseToken: 'private-token' } }
    for (const bad of [missing, mismatched, expiredCompletion, leaked]) {
      fetcher.mockResolvedValue(response(bad))
      const error = await request().catch(error => error)
      expect(error).toMatchObject({ kind: 'invalid' })
      expect(error.message).not.toContain('private-token')
    }
  })
  it('cancels date navigation during polling without starting more requests', async () => {
    fetcher.mockResolvedValue(response(preparedRunning()))
    const controller = new AbortController(), result = request(vi.fn(), false, controller.signal).catch(error => error)
    await vi.advanceTimersByTimeAsync(0)
    controller.abort()
    expect(await result).toMatchObject({ name: 'AbortError' })
    await settlePoll()
    expect(fetcher).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })
  it('ends a never-completing job at the overall caller deadline', async () => {
    fetcher.mockImplementation(async () => response(preparedRunning()))
    const result = request().catch(error => error)
    await vi.advanceTimersByTimeAsync(REPORTING_REQUEST_TIMEOUT_MS)
    expect(await result).toMatchObject({ kind: 'transient', message: expect.stringContaining('took too long') })
    const count = fetcher.mock.calls.length
    await settlePoll()
    expect(fetcher).toHaveBeenCalledTimes(count)
    expect(vi.getTimerCount()).toBe(0)
  })
  it('cancels a stalled prepared body at the same caller deadline', async () => {
    const cancel = vi.fn()
    fetcher.mockResolvedValue(new Response(new ReadableStream({ cancel }), { headers: { 'Content-Type': REPORTING_PREPARED_TYPE } }))
    const result = request().catch(error => error)
    await vi.advanceTimersByTimeAsync(REPORTING_REQUEST_TIMEOUT_MS)
    expect(await result).toMatchObject({ kind: 'transient' })
    expect(cancel).toHaveBeenCalledOnce()
  })
})
