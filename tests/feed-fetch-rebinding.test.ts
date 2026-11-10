import { createServer, type Server } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchPublicHttps, pinnedHttpsTransport, type FeedTransport } from '@/lib/signals/feed-fetch'

// DNS rebinding: a hostile DNS server answers the safety check with a public address and the
// connection with a private one. The connection must go to the address that was checked, so each
// hop resolves once and the transport is handed that address; nothing resolves the name again.
const PUBLIC = '93.184.216.34'
const PRIVATE = '127.0.0.1'

function rebindingLookup() {
  let calls = 0
  return vi.fn(async () => {
    calls += 1
    return [{ address: calls === 1 ? PUBLIC : PRIVATE, family: 4 }]
  })
}

describe('fetchPublicHttps pins each hop to the checked address', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('connects to the first (checked) answer and never asks DNS again for that hop', async () => {
    const fetchSpy = vi.fn(async () => new Response('<rss/>'))
    vi.stubGlobal('fetch', fetchSpy)
    const lookup = rebindingLookup()
    const transport = vi.fn<FeedTransport>(async () => new Response('<rss/>'))

    const response = await fetchPublicHttps('https://feeds.example.test/rss.xml', {}, { lookup, transport })

    expect(response.status).toBe(200)
    expect(lookup).toHaveBeenCalledTimes(1)
    expect(transport).toHaveBeenCalledTimes(1)
    expect(transport.mock.calls[0][0]).toBe('https://feeds.example.test/rss.xml')
    expect(transport.mock.calls[0][2]).toEqual({ address: PUBLIC, family: 4 })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('each redirect hop is resolved once and pinned to its own checked address', async () => {
    const lookup = vi.fn(async (hostname: string) => (
      hostname === 'feeds.example.test'
        ? [{ address: PUBLIC, family: 4 }]
        : [{ address: '2606:4700:4700::1111', family: 6 }]
    ))
    const transport = vi.fn<FeedTransport>()
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: 'https://cdn.example.test/feed.xml' } }))
      .mockResolvedValueOnce(new Response('<rss/>'))

    await fetchPublicHttps('https://feeds.example.test/rss.xml', {}, { lookup, transport })

    expect(lookup.mock.calls.map(([host]) => host)).toEqual(['feeds.example.test', 'cdn.example.test'])
    expect(transport.mock.calls.map(([url, , pinned]) => [url, pinned.address])).toEqual([
      ['https://feeds.example.test/rss.xml', PUBLIC],
      ['https://cdn.example.test/feed.xml', '2606:4700:4700::1111'],
    ])
  })

  it('control: a private first answer is still rejected before any connection', async () => {
    const transport = vi.fn<FeedTransport>(async () => new Response('<rss/>'))
    const lookup = vi.fn(async () => [{ address: PRIVATE, family: 4 }])
    await expect(fetchPublicHttps('https://feeds.example.test/rss.xml', {}, { lookup, transport }))
      .rejects.toThrow(/public address/)
    expect(transport).not.toHaveBeenCalled()
  })
})

describe('pinnedHttpsTransport (the default transport) at the socket level', () => {
  let server: Server | null = null
  afterEach(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()))
    server = null
  })

  // A plain TCP listener stands in for the pinned address: it records the TLS ClientHello and drops
  // the socket. `feeds.example.test` cannot resolve (reserved TLD, no network), so a connection that
  // arrives here can only have used the pinned address, and the ClientHello shows the SNI hostname.
  it('opens the socket to the pinned address and keeps the hostname for TLS SNI', async () => {
    const hello = new Promise<Buffer>((resolve) => {
      server = createServer((socket) => {
        socket.once('data', (chunk) => {
          // No encoding is set, so chunks are Buffers; @types/node 26 types them as string | Buffer.
          resolve(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
          socket.destroy()
        })
      })
    })
    const port = await new Promise<number>((resolve) => {
      server!.listen(0, '127.0.0.1', () => resolve((server!.address() as { port: number }).port))
    })

    const attempt = pinnedHttpsTransport(
      `https://feeds.example.test:${port}/rss.xml`,
      {},
      { address: '127.0.0.1', family: 4 },
    )

    const clientHello = await hello
    expect(clientHello[0]).toBe(0x16) // TLS handshake record
    expect(clientHello.includes(Buffer.from('feeds.example.test'))).toBe(true)
    await expect(attempt).rejects.toThrow()
  })
})
