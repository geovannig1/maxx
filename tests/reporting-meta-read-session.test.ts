import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMetaReadSession, metaReadFailureNote } from '@/lib/platforms/meta/reporting/meta-read-session'
const { get } = vi.hoisted(() => ({ get: vi.fn() }))
vi.mock('@/lib/platforms/meta/client', () => ({ metaGet: get }))
const quota = (retryAfterMs?: number) => Object.assign(new Error('secret-like provider detail'), { code: 4, subcode: 1504022, retryAfterMs })
beforeEach(() => { vi.useFakeTimers(); get.mockReset() })
afterEach(() => { vi.useRealTimers() })

describe('one Meta report read session', () => {
  it('bounds network concurrency and gives queued core pages precedence without dropping any request', async () => {
    const release: Array<() => void> = []
    let active = 0, maximum = 0
    get.mockImplementation(async (path: string) => {
      active += 1; maximum = Math.max(maximum, active)
      await new Promise<void>(resolve => { release.push(resolve) })
      active -= 1
      return { path }
    })
    const session = createMetaReadSession()
    const pending = Promise.all([
      ...Array.from({ length: 8 }, (_, i) => session.get(`/optional-${i}`)),
      session.coreGet('/current-adset-page-2'), session.coreGet('/prior-adset'),
    ])
    try {
      expect(get).toHaveBeenCalledTimes(4)
      release.shift()!()
      await vi.advanceTimersByTimeAsync(0)
      expect(get.mock.calls[4][0]).toBe('/current-adset-page-2')
      while (release.length) { release.shift()!(); await vi.advanceTimersByTimeAsync(0) }
      expect((await pending).length).toBe(10)
      expect(maximum).toBe(4)
      expect(get.mock.calls.map(([path]) => path)).toContain('/prior-adset')
    } finally { session.close() }
  })

  it('recovers one throttled ad-set read and holds all new reads for the provider delay', async () => {
    get.mockRejectedValueOnce(quota(12_000)).mockResolvedValue({ data: [{ adset_id: 's', spend: '100' }] })
    const session = createMetaReadSession()
    const params = { level: 'adset', time_range: '{"since":"2026-08-08","until":"2026-09-06"}' }
    const result = session.coreGet('/insights', params)
    try {
      await vi.advanceTimersByTimeAsync(0)
      const detail = session.get('/creative')
      await vi.advanceTimersByTimeAsync(11_999)
      expect(get).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(1)
      expect(await result).toEqual({ data: [{ adset_id: 's', spend: '100' }] })
      await detail
      expect(get).toHaveBeenCalledTimes(3)
      expect(get.mock.calls[1].slice(0, 2)).toEqual(['/insights', params])
    } finally { session.close() }
  })

  it('uses a bounded local fallback delay, then stops queued reads if throttling persists', async () => {
    get.mockRejectedValue(quota())
    const session = createMetaReadSession()
    const result = Promise.allSettled(Array.from({ length: 30 }, (_, i) => session.coreGet(`/insights-${i}`)))
    try {
      await vi.advanceTimersByTimeAsync(4_999)
      expect(get).toHaveBeenCalledTimes(4)
      await vi.advanceTimersByTimeAsync(1)
      const settled = await result
      expect(settled.every(item => item.status === 'rejected')).toBe(true)
      expect(get.mock.calls.length).toBeLessThanOrEqual(8)
      await vi.advanceTimersByTimeAsync(90_000)
      expect(get.mock.calls.length).toBeLessThanOrEqual(8)
    } finally { session.close() }
  })

  it('does not retry credential, permission, unsupported-field or malformed-response failures', async () => {
    const errors = [190, 10, 100, 0].map(code => Object.assign(new Error('Synthetic permanent error'), { code }))
    errors.forEach(error => get.mockRejectedValueOnce(error))
    const session = createMetaReadSession()
    try {
      const result = await Promise.allSettled(errors.map((_, i) => session.get(`/read-${i}`)))
      expect(result.map(item => item.status)).toEqual(errors.map(() => 'rejected'))
      expect(get).toHaveBeenCalledTimes(4)
    } finally { session.close() }
  })

  it('rejects a cooldown beyond the report deadline without sending a retry or waiting it out', async () => {
    get.mockRejectedValue(quota(300_000))
    const session = createMetaReadSession()
    try {
      const result = await Promise.allSettled(Array.from({ length: 30 }, (_, i) => session.get(`/read-${i}`)))
      expect(result.every(item => item.status === 'rejected')).toBe(true)
      expect(get).toHaveBeenCalledTimes(4)
    } finally { session.close() }
  })

  it('aborts stalled requests at its deadline and never starts queued work afterwards', async () => {
    get.mockImplementation((_path: string, _params: unknown, options: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true })
    }))
    const session = createMetaReadSession()
    const result = Promise.allSettled(Array.from({ length: 10 }, (_, i) => session.get(`/read-${i}`)))
    try {
      await vi.advanceTimersByTimeAsync(80_000)
      const settled = await result
      expect(settled.every(item => item.status === 'rejected')).toBe(true)
      expect(get).toHaveBeenCalledTimes(4)
      expect(metaReadFailureNote((settled[0] as PromiseRejectedResult).reason)).toContain('deadline')
      await expect(session.get('/late')).rejects.toThrow()
      expect(get).toHaveBeenCalledTimes(4)
    } finally { session.close() }
  })

  it('classifies quota failure safely without exposing provider detail or mislabeling auth failure', () => {
    expect(metaReadFailureNote(quota())).toContain('temporarily limited')
    expect(metaReadFailureNote(quota())).not.toContain('secret-like')
    expect(metaReadFailureNote(Object.assign(new Error('quota in a misleading message'), { code: 190 }))).toBe('')
  })

  it('settles the caller at the deadline even if a stalled transport does not acknowledge abort', async () => {
    get.mockImplementation(() => new Promise(() => undefined))
    const session = createMetaReadSession()
    let finished = false
    const result = session.get('/stalled').catch(error => { finished = true; return metaReadFailureNote(error) })
    await vi.advanceTimersByTimeAsync(80_000)
    expect(finished).toBe(true)
    expect(await result).toContain('deadline')
    session.close()
  })
})
