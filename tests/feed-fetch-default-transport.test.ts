import { EventEmitter } from 'node:events'
import type { LookupFunction } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Wiring of the DEFAULT path: with no injected transport, fetchPublicHttps must hand the request to
// node:https with a `lookup` that answers only with the address that was checked, whatever the
// hostname's DNS would say at connection time, and with SNI on the hostname. The global fetch (which
// re-resolves) must not be used.
const https = vi.hoisted(() => ({ calls: [] as Record<string, unknown>[] }))

vi.mock('node:https', () => {
  const request = (options: Record<string, unknown>) => {
    https.calls.push(options)
    const req = new EventEmitter() as EventEmitter & { end: () => void; destroy: () => void }
    req.end = () => queueMicrotask(() => req.emit('error', new Error('test transport: no network')))
    req.destroy = () => undefined
    return req
  }
  return { request, default: { request } }
})

function connectTimeAnswer(lookup: LookupFunction, all: boolean) {
  return new Promise<unknown>((resolve, reject) => {
    lookup('feeds.example.test', { all, family: 0 }, (error: Error | null, address: unknown, family?: number) => {
      if (error) reject(error)
      else resolve(all ? address : { address, family })
    })
  })
}

describe('fetchPublicHttps default transport', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    https.calls.length = 0
  })

  it('uses node:https with a lookup pinned to the checked address, not a second resolution', async () => {
    const fetchSpy = vi.fn(async () => new Response('<rss/>'))
    vi.stubGlobal('fetch', fetchSpy)
    let resolutions = 0
    const lookup = vi.fn(async () => {
      resolutions += 1
      return [{ address: resolutions === 1 ? '93.184.216.34' : '169.254.169.254', family: 4 }]
    })
    const { fetchPublicHttps } = await import('@/lib/signals/feed-fetch')

    await expect(fetchPublicHttps('https://feeds.example.test/rss.xml', {}, { lookup })).rejects.toThrow(/no network/)

    expect(fetchSpy).not.toHaveBeenCalled()
    expect(https.calls).toHaveLength(1)
    const options = https.calls[0]
    expect(options).toMatchObject({ hostname: 'feeds.example.test', servername: 'feeds.example.test', path: '/rss.xml' })
    const pinned = options.lookup as LookupFunction
    expect(await connectTimeAnswer(pinned, true)).toEqual([{ address: '93.184.216.34', family: 4 }])
    expect(await connectTimeAnswer(pinned, false)).toEqual({ address: '93.184.216.34', family: 4 })
    expect(lookup).toHaveBeenCalledTimes(1)
  })
})
