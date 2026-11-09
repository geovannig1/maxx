import { describe, it, expect, vi, afterEach } from 'vitest'
import { assertPublicHttpsUrl, fetchPublicHttps, MAX_FEED_REDIRECTS, type FeedTransport } from '@/lib/signals/feed-fetch'

// The network transport is injected: these cases exercise hostname, DNS and redirect policy, and the
// stubbed global fetch stands in for the pinned-address transport (feed-fetch-rebinding.test.ts).
const viaStubbedFetch: FeedTransport = (url, init) => fetch(url, init)

// fetchPublicHttps now resolves every hop before fetching it (DNS cases: feed-fetch-dns.test.ts).
// These hostname/redirect cases resolve every name to a public address so they stay offline.
vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]),
}))

// A compromised feed host must not be able to steer the fetcher off public https: no http hop, no
// IP literal or local name, no unbounded redirect chain.
function redirectTo(location: string, status = 302): Response {
  return new Response(null, { status, headers: { location } })
}

describe('assertPublicHttpsUrl', () => {
  it('accepts a public https URL', () => {
    expect(assertPublicHttpsUrl('https://feeds.example.test/rss.xml').hostname).toBe('feeds.example.test')
  })
  it.each([
    'http://feeds.example.test/rss.xml',
    'https://127.0.0.1/rss.xml',
    'https://169.254.169.254/latest/meta-data',
    'https://[::1]/rss.xml',
    'https://localhost/rss.xml',
    'https://feeds.internal/rss.xml',
    'https://intranet/rss.xml',
    'https://user:pass@feeds.example.test/rss.xml',
    'ftp://feeds.example.test/rss.xml',
    'not a url',
  ])('rejects %s', (url) => {
    expect(() => assertPublicHttpsUrl(url)).toThrow()
  })
})

describe('fetchPublicHttps', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('follows an https redirect and returns the final response', async () => {
    const calls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      calls.push(url)
      return calls.length === 1 ? redirectTo('https://cdn.example.test/feed.xml') : new Response('<rss/>', { status: 200 })
    }))
    const res = await fetchPublicHttps('https://feeds.example.test/rss.xml', {}, { transport: viaStubbedFetch })
    expect(res.status).toBe(200)
    expect(calls).toEqual(['https://feeds.example.test/rss.xml', 'https://cdn.example.test/feed.xml'])
  })

  it('never follows a redirect to http or to a private address', async () => {
    for (const target of ['http://feeds.example.test/rss.xml', 'https://10.0.0.5/rss.xml', 'https://localhost/x']) {
      const fetchMock = vi.fn(async () => redirectTo(target))
      vi.stubGlobal('fetch', fetchMock)
      await expect(fetchPublicHttps('https://feeds.example.test/rss.xml', {}, { transport: viaStubbedFetch })).rejects.toThrow()
      expect(fetchMock).toHaveBeenCalledTimes(1)
    }
  })

  it('resolves a relative Location against the current hop', async () => {
    const calls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      calls.push(url)
      return calls.length === 1 ? redirectTo('/feed/rss.xml', 301) : new Response('<rss/>')
    }))
    await fetchPublicHttps('https://feeds.example.test/old', {}, { transport: viaStubbedFetch })
    expect(calls[1]).toBe('https://feeds.example.test/feed/rss.xml')
  })

  it('caps the redirect chain', async () => {
    const fetchMock = vi.fn(async () => redirectTo('https://feeds.example.test/again'))
    vi.stubGlobal('fetch', fetchMock)
    await expect(fetchPublicHttps('https://feeds.example.test/rss.xml', {}, { transport: viaStubbedFetch })).rejects.toThrow(/redirects/)
    expect(fetchMock).toHaveBeenCalledTimes(MAX_FEED_REDIRECTS + 1)
  })

  it('always asks fetch for manual redirect handling', async () => {
    const fetchMock = vi.fn(async () => new Response('<rss/>'))
    vi.stubGlobal('fetch', fetchMock)
    await fetchPublicHttps('https://feeds.example.test/rss.xml', { redirect: 'follow' }, { transport: viaStubbedFetch })
    expect((fetchMock.mock.calls[0] as unknown[])[1]).toMatchObject({ redirect: 'manual' })
  })
})
