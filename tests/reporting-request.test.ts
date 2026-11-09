import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { requestReportingPacket, ReportingRequestError } from '@/lib/reporting/request-packet'
import { REPORTING_REQUEST_TIMEOUT_MS, withReportingDeadline } from '@/lib/reporting/deadline'
import { snapshotPacket } from './fixtures/reporting-snapshot'
import { fixturePacket } from '../scripts/demo/sample/reports'

const key = 'from=2026-09-02&to=2026-09-04'
const packet = () => fixturePacket('meta', '2026-09-02', '2026-09-04')
const fetcher = vi.fn<typeof fetch>()
const request = (signal = new AbortController().signal) => requestReportingPacket('meta', key, signal)

describe('bounded browser report requests', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-05T17:00:00Z')); vi.stubGlobal('fetch', fetcher); fetcher.mockReset() })
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })
  it.each(['application/json', 'application/x-ndjson'])('validates selected parent evidence for %s', async contentType => {
    const historyEntity = { level: 'adset', id: 'set-7' }
    const selectedKey = `${key}&${new URLSearchParams({ historyEntity: JSON.stringify(historyEntity) })}`
    const value = snapshotPacket()
    value.result.data!.entities = [{ id: 'set-7', level: 'adset', name: 'Selected set', campaignId: 'c1', campaignName: null,
      adsetId: null, adsetName: null, status: 'UNKNOWN', configurationAsOf: null, audience: 'unknown', audienceLabel: 'Unknown',
      creative: null, metrics: {}, series: [], comparisonSeries: [] }]
    const respond = () => contentType === 'application/json' ? Response.json(value) : new Response(
      `${JSON.stringify({ kind: 'complete', packet: value })}\n`, { headers: { 'Content-Type': contentType } })
    fetcher.mockImplementation(async () => respond())
    expect(await requestReportingPacket('meta', selectedKey, new AbortController().signal)).toEqual(value)
    value.result.data!.entities[0].id = 'another-set'
    await expect(requestReportingPacket('meta', selectedKey, new AbortController().signal)).rejects.toMatchObject({ kind: 'invalid' })
  })
  it.each(['null', '{bad json', '{"level":"ad","id":"a1"}', '{"level":"campaign","id":"c1","extra":true}'])('rejects malformed client history %s before fetch', async historyEntity => {
    fetcher.mockImplementation(async () => Response.json(packet()))
    await expect(requestReportingPacket('meta', `${key}&${new URLSearchParams({ historyEntity })}`, new AbortController().signal))
      .rejects.toMatchObject({ kind: 'invalid' })
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('returns a valid matching report and removes its deadline', async () => {
    fetcher.mockResolvedValue(Response.json(packet()))
    expect(await request()).toMatchObject({ section: 'meta', result: { state: 'available' } })
    expect(vi.getTimerCount()).toBe(0)
  })
  it.each([401, 403])('distinguishes rejected access (%s) from a transient outage', async status => {
    fetcher.mockResolvedValue(new Response('private-provider-detail', { status }))
    await expect(request()).rejects.toMatchObject({ kind: 'access' })
    expect(vi.getTimerCount()).toBe(0)
  })
  it.each([
    ['ACTIVE_ACCOUNT_NOT_FOUND', 404, 'invalid', 'No active reporting account is configured'],
    ['ACTIVE_ACCOUNT_AMBIGUOUS', 409, 'invalid', 'More than one active account was found'],
    ['ACTIVE_ACCOUNT_UNAVAILABLE', 503, 'transient', 'Reporting account lookup is temporarily unavailable'],
  ] as const)('surfaces account-resolution code %s', async (code, status, kind, message) => {
    fetcher.mockResolvedValue(new Response('private-provider-detail', { status, headers: { 'x-reporting-error-code': code } }))
    const error = await request().catch(error => error)
    expect(error).toMatchObject({ kind, message: expect.stringContaining(message) })
    expect(error.message).not.toContain('private-provider-detail')
  })
  it.each([429, 500, 503, 504])('retains the transient classification for service status %s', async status => {
    fetcher.mockResolvedValue(new Response('private-provider-detail', { status }))
    const error = await request().catch(error => error)
    expect(error).toMatchObject({ kind: 'transient' })
    expect(error.message).not.toContain('private-provider-detail')
  })
  it('bounds a fetch that ignores cancellation and signals an abort to cooperative transports', async () => {
    let signal: AbortSignal | undefined
    fetcher.mockImplementation((_url, init) => { signal = init?.signal ?? undefined; return new Promise(() => {}) })
    const result = request().catch(error => error)
    await vi.advanceTimersByTimeAsync(REPORTING_REQUEST_TIMEOUT_MS - 1)
    expect(signal?.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(await result).toMatchObject({ kind: 'transient', message: expect.stringContaining('took too long') })
    expect(signal?.aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })
  it('keeps the deadline active while a successful response body is still streaming', async () => {
    let close!: () => void
    fetcher.mockResolvedValue(new Response(new ReadableStream({ start(controller) { close = () => controller.close() } })))
    const result = request().catch(error => error)
    await vi.advanceTimersByTimeAsync(REPORTING_REQUEST_TIMEOUT_MS)
    expect(await result).toMatchObject({ kind: 'transient', message: expect.stringContaining('took too long') })
    close()
    expect(vi.getTimerCount()).toBe(0)
  })
  it('cancels obsolete work promptly even if its dependency never settles', async () => {
    fetcher.mockReturnValue(new Promise(() => {}))
    const controller = new AbortController()
    const result = request(controller.signal).catch(error => error)
    controller.abort()
    expect(await result).toMatchObject({ name: 'AbortError' })
    expect(vi.getTimerCount()).toBe(0)
  })
  it('never starts an operation already cancelled by its caller', async () => {
    let started = false
    const controller = new AbortController()
    controller.abort()
    await expect(withReportingDeadline(async () => { started = true; return 1 }, 100, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(started).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })
  it('rejects wrong source, current period and comparison period instead of replacing visible evidence', async () => {
    const valid = packet()
    const wrongSource = fixturePacket('business', '2026-09-02', '2026-09-04')
    const wrongCurrent = { ...valid, context: { ...valid.context, range: { from: '2026-08-01', to: '2026-08-03' } } }
    const wrongComparison = { ...valid, context: { ...valid.context, comparison: { from: '2026-07-01', to: '2026-07-03' } } }
    for (const value of [wrongSource, wrongCurrent, wrongComparison]) {
      fetcher.mockResolvedValue(Response.json(value))
      await expect(request()).rejects.toMatchObject({ kind: 'invalid' })
    }
  })
  it('does not expose transport or parser errors', async () => {
    fetcher.mockRejectedValue(new Error('token=private-secret'))
    const transport = await request().catch(error => error)
    expect(transport).toBeInstanceOf(ReportingRequestError)
    expect(transport.message).not.toContain('private-secret')
    fetcher.mockResolvedValue(new Response('private-secret'))
    const parser = await request().catch(error => error)
    expect(parser.kind).toBe('invalid')
    expect(parser.message).not.toContain('private-secret')
  })
  it('rejects a completed response claiming it is still loading instead of leaving an endless spinner', async () => {
    fetcher.mockResolvedValue(Response.json({ ...packet(), result: { state: 'loading', data: null, asOf: null, notes: [] } }))
    await expect(request()).rejects.toMatchObject({ kind: 'invalid' })
  })
})
describe('business terminal JSON boundary', () => {
  it('rejects pending intelligence in a non-stream terminal response', async () => {
    vi.stubGlobal('fetch', fetcher)
    try {
      const business = fixturePacket('business', '2026-09-02', '2026-09-04')
      if (business.section !== 'business' || !business.result.data) throw new Error('Expected business fixture')
      const loading = { state: 'loading', data: null, asOf: null, notes: [] }
      fetcher.mockResolvedValue(Response.json({ ...business, result: { ...business.result, state: 'partial', data: { ...business.result.data, intelligence: { customers: loading, leadTime: loading, upcoming: loading } } } }))
      await expect(requestReportingPacket('business', key, new AbortController().signal)).rejects.toMatchObject({ kind: 'invalid' })
    } finally { vi.unstubAllGlobals() }
  })
})
