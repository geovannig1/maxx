import { describe, expect, it, vi } from 'vitest'
import { readPreparedBody } from '@/lib/reporting/prepared-reader'
import { MAX_REPORTING_STREAM_BYTES } from '@/lib/reporting/stream-contract'

const signal = () => new AbortController().signal
function bytes(...chunks: Uint8Array[]) {
  return new Response(new ReadableStream({ start(controller) {
    for (const chunk of chunks) controller.enqueue(chunk)
    controller.close()
  } }))
}
describe('bounded prepared response decoding', () => {
  it('decodes UTF-8 split across transport chunks', async () => {
    const value = { note: 'Café 🎬' }, encoded = new TextEncoder().encode(JSON.stringify(value))
    const split = encoded.indexOf(0xf0) + 2
    expect(await readPreparedBody(bytes(encoded.slice(0, split), encoded.slice(split)), signal())).toEqual(value)
  })
  it('rejects malformed UTF-8, truncated JSON and trailing values without exposing raw input', async () => {
    for (const encoded of [new Uint8Array([0xc3, 0x28]), new TextEncoder().encode('{"private-token":'), new TextEncoder().encode('{}{}')]) {
      const error = await readPreparedBody(bytes(encoded), signal()).catch(error => error)
      expect(error).toMatchObject({ kind: 'invalid' })
      if (!(error instanceof Error)) throw new Error('Expected a sanitized report error.')
      expect(error.message).not.toContain('private-token')
    }
  })
  it('checks actual bytes even if Content-Length lies and cancels oversized input', async () => {
    const cancel = vi.fn()
    const body = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(MAX_REPORTING_STREAM_BYTES + 1)) }, cancel })
    await expect(readPreparedBody(new Response(body, { headers: { 'Content-Length': '1' } }), signal())).rejects.toMatchObject({ kind: 'invalid' })
    expect(cancel).toHaveBeenCalledOnce()
  })
  it('does not consume a body after its caller has already cancelled', async () => {
    const controller = new AbortController(), cancel = vi.fn()
    controller.abort()
    await expect(readPreparedBody(new Response(new ReadableStream({ cancel })), controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(cancel).toHaveBeenCalledOnce()
  })
})
