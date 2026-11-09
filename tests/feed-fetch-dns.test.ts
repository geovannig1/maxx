import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchPublicHttps, type FeedTransport } from '@/lib/signals/feed-fetch'

// The network transport is injected: these cases exercise hostname, DNS and redirect policy, and the
// stubbed global fetch stands in for the pinned-address transport (feed-fetch-rebinding.test.ts).
const viaStubbedFetch: FeedTransport = (url, init) => fetch(url, init)

// Hostname checks alone let a public DNS name that resolves to a private or metadata address through.
// Every hop's host must resolve exclusively to public addresses before it is fetched.
type Lookup = (hostname: string) => Promise<Array<{ address: string; family: number }>>

function resolver(table: Record<string, string[]>): Lookup {
  return vi.fn(async (hostname: string) => (table[hostname] ?? []).map((address) => ({
    address, family: address.includes(':') ? 6 : 4,
  })))
}

function redirectTo(location: string): Response {
  return new Response(null, { status: 302, headers: { location } })
}

describe('fetchPublicHttps DNS validation', () => {
  afterEach(() => vi.unstubAllGlobals())

  it.each(['10.0.0.1', '169.254.169.254', '127.0.0.1', 'fd00::1', '::ffff:10.0.0.1'])(
    'rejects a name that resolves to %s before fetching it',
    async (address) => {
      const fetchMock = vi.fn(async () => new Response('<rss/>'))
      vi.stubGlobal('fetch', fetchMock)
      const lookup = resolver({ 'feeds.example.test': [address] })
      await expect(fetchPublicHttps('https://feeds.example.test/rss.xml', {}, { lookup, transport: viaStubbedFetch })).rejects.toThrow(/public address/)
      expect(fetchMock).not.toHaveBeenCalled()
    },
  )

  it('rejects a name when any one of its addresses is private', async () => {
    const fetchMock = vi.fn(async () => new Response('<rss/>'))
    vi.stubGlobal('fetch', fetchMock)
    const lookup = resolver({ 'feeds.example.test': ['93.184.216.34', '10.0.0.1'] })
    await expect(fetchPublicHttps('https://feeds.example.test/rss.xml', {}, { lookup, transport: viaStubbedFetch })).rejects.toThrow(/public address/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects a name that does not resolve', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<rss/>')))
    await expect(fetchPublicHttps('https://feeds.example.test/rss.xml', {}, { lookup: resolver({}), transport: viaStubbedFetch })).rejects.toThrow(/public address/)
  })

  it('re-resolves on a redirect hop and stops at a private target', async () => {
    const fetchMock = vi.fn(async () => redirectTo('https://metadata.example.test/latest'))
    vi.stubGlobal('fetch', fetchMock)
    const lookup = resolver({
      'feeds.example.test': ['93.184.216.34'],
      'metadata.example.test': ['169.254.169.254'],
    })
    await expect(fetchPublicHttps('https://feeds.example.test/rss.xml', {}, { lookup, transport: viaStubbedFetch })).rejects.toThrow(/public address/)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(lookup).toHaveBeenCalledWith('metadata.example.test')
  })

  it('control: a name resolving only to public addresses is fetched, including after a redirect', async () => {
    const calls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      calls.push(url)
      return calls.length === 1 ? redirectTo('https://cdn.example.test/feed.xml') : new Response('<rss/>')
    }))
    const lookup = resolver({
      'feeds.example.test': ['93.184.216.34'],
      'cdn.example.test': ['2606:2800:220:1:248:1893:25c8:1946'],
    })
    const response = await fetchPublicHttps('https://feeds.example.test/rss.xml', {}, { lookup, transport: viaStubbedFetch })
    expect(response.status).toBe(200)
    expect(calls).toEqual(['https://feeds.example.test/rss.xml', 'https://cdn.example.test/feed.xml'])
  })
})
