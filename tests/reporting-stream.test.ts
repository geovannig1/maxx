import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { requestReportingPacket } from '@/lib/reporting/request-packet'
import { fixturePacket } from '../scripts/demo/sample/reports'
import { MAX_REPORTING_STREAM_BYTES } from '@/lib/reporting/stream-contract'

const key = 'from=2026-09-02&to=2026-09-04'
const fetcher = vi.fn<typeof fetch>()
const controllers: AbortController[] = []
const closeStreams: Array<() => void> = []
const complete = () => fixturePacket('meta', '2026-09-02', '2026-09-04')
function initial() {
  const packet = complete()
  return { ...packet, result: { ...packet.result, state: 'partial', data: { ...packet.result.data, detailState: 'loading' } } }
}
function stream() {
  let source!: ReadableStreamDefaultController<Uint8Array>
  let ended = false
  const encoder = new TextEncoder()
  const cancel = vi.fn(() => { ended = true })
  const body = new ReadableStream<Uint8Array>({ start(controller) { source = controller }, cancel })
  const close = () => { if (!ended) { ended = true; source.close() } }
  closeStreams.push(close)
  fetcher.mockResolvedValue(new Response(body, { headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8' } }))
  return { cancel, close, bytes: (value: Uint8Array) => source.enqueue(value), write: (value: string) => source.enqueue(encoder.encode(value)),
    frame: (kind: string, packet: unknown) => source.enqueue(encoder.encode(`${JSON.stringify({ kind, packet })}\n`)) }
}
function request(onProgress = vi.fn(), section: 'meta' | 'business' = 'meta') {
  const controller = new AbortController()
  controllers.push(controller)
  const done = requestReportingPacket(section, key, controller.signal, false, onProgress).catch(error => error)
  return { controller, onProgress, done }
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-05T17:00:00Z')); vi.stubGlobal('fetch', fetcher); fetcher.mockReset() })
afterEach(() => {
  controllers.splice(0).forEach(controller => controller.abort())
  closeStreams.splice(0).forEach(close => close())
  vi.useRealTimers(); vi.unstubAllGlobals()
})

describe('progressive reporting delivery', () => {
  it('exposes validated initial totals before the response completes and returns the final packet', async () => {
    const source = stream(), consumer = request()
    let finished = false
    void consumer.done.then(() => { finished = true })
    source.frame('partial', initial())
    await vi.waitFor(() => expect(consumer.onProgress).toHaveBeenCalledOnce())
    expect(consumer.onProgress.mock.calls[0][0].result.data.metrics.spend.current.value).toBe(120)
    expect(finished).toBe(false)
    source.frame('complete', complete()); source.close()
    expect(await consumer.done).toMatchObject({ section: 'meta', result: { state: 'available' } })
    expect(fetcher).toHaveBeenCalledOnce()
    expect(fetcher.mock.calls[0][1]?.headers).toMatchObject({ Accept: expect.stringContaining('application/x-ndjson') })
  })
  it('decodes split UTF-8 and frame boundaries without emitting incomplete JSON', async () => {
    const source = stream(), consumer = request()
    const packet = { ...complete(), notes: ['Café 🎬'] }
    const encoded = new TextEncoder().encode(`${JSON.stringify({ kind: 'complete', packet })}\n`)
    const split = encoded.indexOf(0xf0) + 2
    expect(split).toBeGreaterThan(2)
    source.bytes(encoded.subarray(0, split))
    await vi.advanceTimersByTimeAsync(1)
    expect(consumer.onProgress).not.toHaveBeenCalled()
    source.bytes(encoded.subarray(split)); source.close()
    expect(await consumer.done).toMatchObject({ notes: ['Café 🎬'] })
  })
  it('classifies a stream interrupted after valid progress as transient so visible totals can survive', async () => {
    const source = stream(), consumer = request()
    source.frame('partial', initial())
    await vi.waitFor(() => expect(consumer.onProgress).toHaveBeenCalledOnce())
    source.close()
    expect(await consumer.done).toMatchObject({ kind: 'transient' })
  })
  it('rejects changed account or period in a later frame rather than merging it with initial evidence', async () => {
    for (const change of ['account', 'period']) {
      const source = stream(), consumer = request()
      source.frame('partial', initial())
      await vi.waitFor(() => expect(consumer.onProgress).toHaveBeenCalledOnce())
      const packet = complete()
      source.frame('complete', { ...packet, context: change === 'account'
        ? { ...packet.context, account: { ...packet.context.account, id: 'wrong' } }
        : { ...packet.context, range: { from: '2026-08-02', to: '2026-08-04' }, comparison: { from: '2026-07-30', to: '2026-08-01' } } })
      source.close()
      expect(await consumer.done).toMatchObject({ kind: 'invalid' })
    }
  })
  it('rejects malformed frames and completed packets still advertising unfinished details without leaking raw input', async () => {
    for (const value of ['token=private-secret\n', `${JSON.stringify({ kind: 'complete', packet: initial() })}\n`]) {
      const source = stream(), consumer = request()
      source.write(value); source.close()
      const error = await consumer.done
      expect(error).toMatchObject({ kind: 'invalid' })
      expect(error.message).not.toContain('private-secret')
    }
  })
  it('rejects extra frames after completion and cancels the body on parent abort', async () => {
    const extra = stream(), consumer = request()
    extra.frame('complete', complete()); extra.frame('partial', initial()); extra.close()
    expect(await consumer.done).toMatchObject({ kind: 'invalid' })
    const held = stream(), cancelled = request()
    held.frame('partial', initial())
    await vi.waitFor(() => expect(cancelled.onProgress).toHaveBeenCalledOnce())
    cancelled.controller.abort()
    expect(await cancelled.done).toMatchObject({ name: 'AbortError' })
    expect(held.cancel).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })
  it('bounds decompressed stream bytes before decoding and cancels excess input', async () => {
    const source = stream(), consumer = request()
    source.bytes(new Uint8Array(MAX_REPORTING_STREAM_BYTES + 1))
    expect(await consumer.done).toMatchObject({ kind: 'invalid', message: expect.stringContaining('shorter reporting period') })
    expect(source.cancel).toHaveBeenCalledOnce()
  })
  it('keeps the original deadline running after progress and aborts a stalled body', async () => {
    const source = stream(), consumer = request()
    source.frame('partial', initial())
    await vi.waitFor(() => expect(consumer.onProgress).toHaveBeenCalledOnce())
    await vi.advanceTimersByTimeAsync(120_000)
    expect(await consumer.done).toMatchObject({ kind: 'transient', message: expect.stringContaining('took too long') })
    expect(source.cancel).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })
})


function businessInitial() {
  const packet = fixturePacket('business', '2026-09-02', '2026-09-04')
  if (packet.section !== 'business' || !packet.result.data) throw new Error('Expected business fixture')
  const loading = { state: 'loading', data: null, asOf: null, notes: [] }
  return { ...packet, result: { ...packet.result, state: 'partial', data: { ...packet.result.data, intelligence: { customers: loading, leadTime: loading, upcoming: loading } } } }
}
describe('business intelligence NDJSON frames', () => {
  it('requests business streaming and exposes core before intelligence completion', async () => {
    const source = stream(), consumer = request(vi.fn(), 'business')
    source.frame('partial', businessInitial())
    await vi.waitFor(() => expect(consumer.onProgress).toHaveBeenCalledOnce())
    expect(consumer.onProgress.mock.calls[0][0].section).toBe('business')
    expect(fetcher.mock.calls[0][1]?.headers).toMatchObject({ Accept: expect.stringContaining('application/x-ndjson') })
    source.frame('complete', fixturePacket('business', '2026-09-02', '2026-09-04')); source.close()
    expect(await consumer.done).toMatchObject({ section: 'business' })
  })
  it('rejects pending terminal business intelligence and a different requested section', async () => {
    for (const packet of [businessInitial(), complete()]) {
      const source = stream(), consumer = request(vi.fn(), 'business')
      source.frame('complete', packet); source.close()
      expect(await consumer.done).toMatchObject({ kind: 'invalid' })
      expect(consumer.onProgress).not.toHaveBeenCalled()
    }
  })
  it('keeps business frame ordering and cancellation guards after early core', async () => {
    const extra = stream(), consumer = request(vi.fn(), 'business')
    extra.frame('partial', businessInitial())
    await vi.waitFor(() => expect(consumer.onProgress).toHaveBeenCalledOnce())
    extra.frame('partial', businessInitial()); extra.close()
    expect(await consumer.done).toMatchObject({ kind: 'invalid' })
    const source = stream(), canceled = request(vi.fn(), 'business')
    source.frame('partial', businessInitial())
    await vi.waitFor(() => expect(canceled.onProgress).toHaveBeenCalledOnce())
    canceled.controller.abort()
    expect(await canceled.done).toMatchObject({ name: 'AbortError' })
    expect(source.cancel).toHaveBeenCalledOnce()
  })
})
