import { describe, expect, it, vi } from 'vitest'

import { fetchTrustedMetaImage } from '@/lib/report/trusted-meta-image'

const publicLookup = vi.fn(async () => [{ address: '157.240.241.17', family: 4 as const }])

describe('fetchTrustedMetaImage', () => {
  it('rejects non-HTTPS, non-Meta, private-address, and redirect escape targets before reading', async () => {
    const fetcher = vi.fn()
    await expect(fetchTrustedMetaImage('http://scontent.xx.fbcdn.net/a.jpg', { fetcher, lookup: publicLookup }))
      .rejects.toThrow(/HTTPS/i)
    await expect(fetchTrustedMetaImage('https://evil.example/a.jpg', { fetcher, lookup: publicLookup }))
      .rejects.toThrow(/approved Meta CDN/i)
    await expect(fetchTrustedMetaImage('https://scontent.xx.fbcdn.net/a.jpg', {
      fetcher,
      lookup: vi.fn(async () => [{ address: '169.254.169.254', family: 4 as const }]),
    })).rejects.toThrow(/public address/i)

    fetcher.mockResolvedValueOnce(new Response(null, {
      status: 302,
      headers: { location: 'https://evil.example/redirected.jpg' },
    }))
    await expect(fetchTrustedMetaImage('https://scontent.xx.fbcdn.net/a.jpg', {
      fetcher,
      lookup: publicLookup,
    })).rejects.toThrow(/approved Meta CDN/i)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('streams an approved image under the byte cap and checks redirects manually', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(null, {
        status: 302,
        headers: { location: 'https://scontent.cdninstagram.com/final.jpg' },
      }))
      .mockResolvedValueOnce(new Response(Uint8Array.from([1, 2, 3]), {
        status: 200,
        headers: { 'content-type': 'image/jpeg', 'content-length': '3' },
      }))

    const result = await fetchTrustedMetaImage('https://scontent.xx.fbcdn.net/start.jpg', {
      fetcher,
      lookup: publicLookup,
    })

    expect(result).toEqual({ bytes: Buffer.from([1, 2, 3]), mediaType: 'image/jpeg' })
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(fetcher.mock.calls.every(([, init]) => init.redirect === 'manual')).toBe(true)
  })

  it('rejects declared and streamed bodies over the hard cap', async () => {
    const declared = vi.fn(async () => new Response(null, {
      status: 200,
      headers: { 'content-type': 'image/jpeg', 'content-length': '4000000' },
    }))
    await expect(fetchTrustedMetaImage('https://scontent.xx.fbcdn.net/a.jpg', {
      fetcher: declared,
      lookup: publicLookup,
      maxBytes: 3,
    })).rejects.toThrow(/too large/i)

    const streamed = vi.fn(async () => new Response(Uint8Array.from([1, 2, 3, 4]), {
      status: 200,
      headers: { 'content-type': 'image/png' },
    }))
    await expect(fetchTrustedMetaImage('https://scontent.xx.fbcdn.net/a.png', {
      fetcher: streamed,
      lookup: publicLookup,
      maxBytes: 3,
    })).rejects.toThrow(/too large/i)
  })
})
