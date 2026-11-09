import { describe, it, expect } from 'vitest'
import { followPages, cursorFingerprint, MAX_PAGES } from '@/lib/platforms/meta/contract'

// Neither the recommendations nor the dataset-stats fetcher paged AT ALL, so a multi-page
// account silently reported only its first page as if that were the whole truth. Paging must be
// bounded, cycle-safe and audited — and a signed paging URL must never be logged or stored, because
// it embeds an access token in its query string.

const pageWith = (n: number, next?: string) => ({ data: [{ id: n }], paging: next ? { next } : {} })
const nextOf = (p: { paging?: { next?: string } }) => p.paging?.next
const url = (cursor: string) => `https://graph.example.invalid/v25.0/act_1/recommendations?after=${cursor}&access_token=EAASECRETTOKEN0123456789`

describe('followPages — bounded, cycle-safe, audited', () => {
  it('follows every page to exhaustion', async () => {
    const pages: Record<string, ReturnType<typeof pageWith>> = {
      [url('c1')]: pageWith(2, url('c2')),
      [url('c2')]: pageWith(3),
    }
    const r = await followPages('/e', pageWith(1, url('c1')), nextOf, async (u) => pages[u])
    expect(r.pages).toHaveLength(3)
    expect(r.audit.stoppedBecause).toBe('exhausted')
    expect(r.audit.violations).toEqual([])
  })

  it('a single page with no cursor follows nothing', async () => {
    const r = await followPages('/e', pageWith(1), nextOf, async () => { throw new Error('should not fetch') })
    expect(r.pages).toHaveLength(1)
    expect(r.audit.pagesFollowed).toBe(1)
  })

  it('detects a REPEATED cursor and aborts instead of looping forever', async () => {
    // Meta returns a cursor pointing back at a page already seen.
    const r = await followPages('/e', pageWith(1, url('loop')), nextOf, async () => pageWith(2, url('loop')))
    expect(r.audit.stoppedBecause).toBe('cycle_detected')
    expect(r.audit.violations[0].errorClass).toBe('paging_cycle')
    expect(r.pages.length).toBeLessThan(5)
  })

  it('enforces a HARD cap and records the result as INCOMPLETE', async () => {
    let i = 0
    const r = await followPages('/e', pageWith(0, url('c0')), nextOf, async () => { i += 1; return pageWith(i, url(`c${i}`)) }, 5)
    expect(r.audit.stoppedBecause).toBe('cap_exceeded')
    expect(r.audit.violations[0].errorClass).toBe('paging_cap_exceeded')
    expect(r.audit.violations[0].detail).toMatch(/INCOMPLETE/)
    expect(r.pages).toHaveLength(5)
  })

  it('stops complete once the caller proves the requested scope is covered', async () => {
    const pages: Record<string, ReturnType<typeof pageWith>> = {
      [url('c1')]: pageWith(2, url('c2')),
      [url('c2')]: pageWith(3, url('c3')),
    }
    const r = await followPages(
      '/e', pageWith(1, url('c1')), nextOf, async (u) => pages[u], MAX_PAGES,
      (page) => page.data.some((row) => row.id === 2),
    )
    expect(r.pages.map((page) => page.data[0]?.id)).toEqual([1, 2])
    expect(r.audit).toMatchObject({ stoppedBecause: 'scope_satisfied', complete: true })
    expect(r.audit.violations).toEqual([])
  })

  it('the default cap is bounded', () => {
    expect(MAX_PAGES).toBeGreaterThan(0)
    expect(MAX_PAGES).toBeLessThanOrEqual(100)
  })

  it('a MALFORMED LATER page stops the walk and is recorded, not silently truncated', async () => {
    const r = await followPages('/e', pageWith(1, url('c1')), nextOf, async () => { throw new Error('HTTP 500') })
    expect(r.audit.stoppedBecause).toBe('page_error')
    expect(r.audit.violations[0].errorClass).toBe('transport_error')
    // The pages already collected are KEPT — a partial failure is partial, not total.
    expect(r.pages).toHaveLength(1)
  })

  it('a PARTIAL failure mid-walk keeps the earlier pages and flags the break', async () => {
    let calls = 0
    const r = await followPages('/e', pageWith(1, url('c1')), nextOf, async () => {
      calls += 1
      if (calls === 1) return pageWith(2, url('c2'))
      throw new Error('HTTP 503')
    })
    expect(r.pages).toHaveLength(2)
    expect(r.audit.stoppedBecause).toBe('page_error')
  })

  it('NEVER retains a signed paging URL — only a token-free cursor fingerprint', async () => {
    const r = await followPages('/e', pageWith(1, url('c1')), nextOf, async () => pageWith(2))
    const audit = JSON.stringify(r.audit)
    expect(audit).not.toMatch(/access_token/)
    expect(audit).not.toMatch(/EAASECRETTOKEN/)
    expect(audit).not.toMatch(/graph\.example\.invalid/)
    // The fingerprint is now a HASH of the complete cursor, not its raw prefix.
    expect(r.audit.cursorFingerprints[0]).toMatch(/^cursor:[0-9a-f]{16}$/)
    expect(r.audit.cursorFingerprints[0]).not.toMatch(/c1/)
  })

  it('cursorFingerprint hashes the cursor and retains no raw platform state', () => {
    expect(cursorFingerprint(url('abc'))).toMatch(/^cursor:[0-9a-f]{16}$/)
    expect(cursorFingerprint(url('abc'))).not.toMatch(/abc/)
    expect(cursorFingerprint('https://x.invalid/v25.0/act_1/stats?access_token=EAASECRET')).toBe('path:/v25.0/act_1/stats')
    expect(cursorFingerprint('not-a-url')).toBe('cursor:unparseable')
  })

  it('violations carry the endpoint and API version for audit', async () => {
    const r = await followPages('/my-edge', pageWith(1, url('loop')), nextOf, async () => pageWith(2, url('loop')))
    expect(r.audit.violations[0].endpoint).toBe('/my-edge')
    expect(r.audit.violations[0].apiVersion).toMatch(/^v\d+\.\d+$/)
  })
})

// ── Completeness is first-class, and CONSUMERS must honour it ───────────────────
import { describe as d2, it as i2, expect as e2, vi, beforeEach, afterEach } from 'vitest'

d2('paging completeness contract', () => {
  i2('an exhausted walk is COMPLETE', async () => {
    const r = await followPages('/e', pageWith(1), nextOf, async () => pageWith(2))
    e2(r.audit.complete).toBe(true)
  })

  i2('a CAP-exceeded walk is INCOMPLETE', async () => {
    let i = 0
    const r = await followPages('/e', pageWith(0, url('c0')), nextOf, async () => { i += 1; return pageWith(i, url(`c${i}`)) }, 3)
    e2(r.audit.complete).toBe(false)
  })

  i2('a CYCLE-detected walk is INCOMPLETE', async () => {
    const r = await followPages('/e', pageWith(1, url('loop')), nextOf, async () => pageWith(2, url('loop')))
    e2(r.audit.complete).toBe(false)
  })

  i2('a PAGE-ERROR walk is INCOMPLETE', async () => {
    const r = await followPages('/e', pageWith(1, url('c1')), nextOf, async () => { throw new Error('500') })
    e2(r.audit.complete).toBe(false)
  })
})

d2('cursor fingerprints HASH the complete cursor', () => {
  i2('two cursors sharing a 24-char prefix do NOT collide', () => {
    // The old fingerprint kept the first 24 raw characters, so these two collided into a false cycle.
    const a = cursorFingerprint(url('X'.repeat(24) + 'AAAA'))
    const b = cursorFingerprint(url('X'.repeat(24) + 'BBBB'))
    e2(a).not.toBe(b)
  })

  i2('the fingerprint retains NO raw cursor text', () => {
    const fp = cursorFingerprint(url('SECRETCURSORVALUE123456789'))
    e2(fp).not.toMatch(/SECRETCURSOR/)
    e2(fp).toMatch(/^cursor:[0-9a-f]{16}$/)
  })

  i2('the same cursor always fingerprints identically (cycle detection still works)', () => {
    e2(cursorFingerprint(url('abc'))).toBe(cursorFingerprint(url('abc')))
  })
})

// ── CONSUMER-level proof, not just the utility ────────────────────────────────────────────────
d2('CONSUMERS refuse to present an incomplete read as complete', () => {
  beforeEach(() => vi.resetModules())
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.doUnmock('@/lib/platforms/meta/client') })

  const cyclingPage = { data: [], paging: { next: 'https://graph.example.invalid/v25.0/x?after=LOOP' } }

  i2('recommendations NEVER say "no pending recommendations" on an incomplete walk', async () => {
    vi.stubEnv('META_AD_ACCOUNT_ID', 'act_1')
    vi.doMock('@/lib/platforms/meta/client', () => ({
      metaGet: vi.fn(async () => cyclingPage),
      fetchMetaGraph: vi.fn(async (url: string) => globalThis.fetch(url)),
      MetaApiError: class extends Error { code = 0 },
    }))
    // Every follow returns the SAME cursor -> cycle -> incomplete.
    globalThis.fetch = (async () => ({ ok: true, status: 200, json: async () => cyclingPage })) as never
    const { fetchMetaRecommendations } = await import('@/lib/platforms/meta/fetch-meta-recommendations')
    const r = await fetchMetaRecommendations()
    e2(r.available).toBe(false)
    if (!r.available) {
      e2(r.reason).toMatch(/paging was INCOMPLETE/)
      e2(r.reason).toMatch(/does NOT mean "no pending recommendations"/)
      e2(r.paging?.complete).toBe(false)
    }
  })

  i2('a COMPLETE empty page still reports the real "no recommendations" state', async () => {
    vi.stubEnv('META_AD_ACCOUNT_ID', 'act_1')
    vi.doMock('@/lib/platforms/meta/client', () => ({
      metaGet: vi.fn(async () => ({ data: [] })),
      fetchMetaGraph: vi.fn(async (url: string) => globalThis.fetch(url)),
      MetaApiError: class extends Error { code = 0 },
    }))
    const { fetchMetaRecommendations } = await import('@/lib/platforms/meta/fetch-meta-recommendations')
    const r = await fetchMetaRecommendations()
    e2(r.available).toBe(true)
    if (r.available) {
      e2(r.recommendations).toEqual([])
      e2(r.paging.complete).toBe(true)
    }
  })

  i2('dataset diagnostics are UNAVAILABLE on an incomplete walk, never partial coverage', async () => {
    vi.stubEnv('META_PIXEL_ID', 'PIX')
    const statsPage = {
      data: [{ aggregation: 'match_keys', start_time: 'x', data: [{ value: 'em', count: 100 }] }],
      paging: { previous: 'https://graph.example.invalid/v25.0/s?before=LOOP' },
    }
    vi.doMock('@/lib/platforms/meta/client', () => ({
      metaGet: vi.fn(async () => statsPage),
      fetchMetaGraph: vi.fn(async (url: string) => globalThis.fetch(url)),
      MetaApiError: class extends Error { code = 0 },
    }))
    globalThis.fetch = (async () => ({ ok: true, status: 200, json: async () => statsPage })) as never
    const { fetchDatasetQuality } = await import('@/lib/platforms/meta/fetch-dataset-quality')
    const r = await fetchDatasetQuality({ datasetId: 'PIX' })
    e2(r.available).toBe(false)
    if (!r.available) {
      e2(r.reason).toMatch(/paging was INCOMPLETE/)
      e2(r.reason).toMatch(/UNAVAILABLE rather than partial/)
    }
  })

  i2('dataset diagnostics stop once the requested time window is covered', async () => {
    vi.stubEnv('META_PIXEL_ID', 'PIX')
    const nowSec = Date.parse('2026-08-01T00:00:00Z') / 1000
    const firstPage = {
      data: [{ aggregation: 'match_keys', start_time: '2026-07-31T23:00:00Z',
        data: [{ value: 'em', count: 1 }] }],
      paging: { previous: url('within-window') },
    }
    const boundaryPage = {
      data: [
        { aggregation: 'match_keys', start_time: '2026-07-25T00:00:00Z',
          data: [{ value: 'em', count: 2 }] },
        { aggregation: 'match_keys', start_time: '2026-07-24T23:00:00Z',
          data: [{ value: 'em', count: 10_000 }] },
      ],
      paging: { previous: url('outside-window') },
    }
    const fetchPage = vi.fn(async (requestUrl: string) => {
      if (!requestUrl) throw new Error('missing paging cursor')
      return { ok: true, status: 200, json: async () => boundaryPage }
    })
    vi.doMock('@/lib/platforms/meta/client', () => ({
      metaGet: vi.fn(async () => firstPage),
      fetchMetaGraph: vi.fn(async (u: string) => fetchPage(u)),
      MetaApiError: class extends Error { code = 0 },
    }))
    const { fetchDatasetQuality } = await import('@/lib/platforms/meta/fetch-dataset-quality')
    const r = await fetchDatasetQuality({ datasetId: 'PIX', windowDays: 7, nowSec })
    e2(r.available).toBe(true)
    if (r.available) {
      e2(r.diagnostics.matchKeys.find((bucket) => bucket.value === 'em')?.count).toBe(3)
      e2(Object.values(r.provenance.paging).every((audit) =>
        audit?.stoppedBecause === 'scope_satisfied' && audit.complete)).toBe(true)
    }
    e2(fetchPage).toHaveBeenCalledTimes(4)
  })

  i2('dataset event volume stops and excludes buckets outside the requested window', async () => {
    vi.stubEnv('META_PIXEL_ID', 'PIX')
    const nowSec = Date.parse('2026-08-01T00:00:00Z') / 1000
    const firstPage = {
      data: [{ start_time: '2026-07-31T23:00:00Z',
        data: [{ value: 'AppointmentConfirmed', count: 1 }] }],
      paging: { previous: url('volume-within') },
    }
    const boundaryPage = {
      data: [
        { start_time: '2026-07-25T00:00:00Z',
          data: [{ value: 'AppointmentConfirmed', count: 2 }] },
        { start_time: '2026-07-24T23:00:00Z',
          data: [{ value: 'AppointmentConfirmed', count: 10_000 }] },
      ],
      paging: { previous: url('volume-outside') },
    }
    const fetchPage = vi.fn(async (requestUrl: string) => {
      if (!requestUrl) throw new Error('missing paging cursor')
      return { ok: true, status: 200, json: async () => boundaryPage }
    })
    vi.doMock('@/lib/platforms/meta/client', () => ({
      metaGet: vi.fn(async () => firstPage),
      fetchMetaGraph: vi.fn(async (u: string) => fetchPage(u)),
      MetaApiError: class extends Error { code = 0 },
    }))
    const { fetchDatasetEventVolume } = await import('@/lib/platforms/meta/fetch-dataset-stats')
    const r = await fetchDatasetEventVolume({ datasetId: 'PIX', windowDays: 7, nowSec })
    e2(r.available).toBe(true)
    e2(r.events.find((event) => event.event === 'AppointmentConfirmed')?.count).toBe(3)
    e2(fetchPage).toHaveBeenCalledTimes(1)
  })

  i2('an empty intermediate stats page does not falsely prove the requested window is covered', async () => {
    vi.stubEnv('META_PIXEL_ID', 'PIX')
    const nowSec = Date.parse('2026-08-01T00:00:00Z') / 1000
    const firstPage = {
      data: [{ start_time: '2026-07-31T23:00:00Z',
        data: [{ value: 'AppointmentConfirmed', count: 1 }] }],
      paging: { previous: url('empty-intermediate') },
    }
    const emptyPage = { data: [], paging: { previous: url('window-boundary') } }
    const boundaryPage = {
      data: [{ start_time: '2026-07-25T00:00:00Z',
        data: [{ value: 'AppointmentConfirmed', count: 2 }] }],
    }
    const fetchPage = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => emptyPage })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => boundaryPage })
    vi.doMock('@/lib/platforms/meta/client', () => ({
      metaGet: vi.fn(async () => firstPage),
      fetchMetaGraph: vi.fn(async (u: string) => {
        if (!u) throw new Error('missing paging cursor')
        return fetchPage()
      }),
      MetaApiError: class extends Error { code = 0 },
    }))
    const { fetchDatasetEventVolume } = await import('@/lib/platforms/meta/fetch-dataset-stats')
    const r = await fetchDatasetEventVolume({ datasetId: 'PIX', windowDays: 7, nowSec })
    e2(r.available).toBe(true)
    e2(r.events.find((event) => event.event === 'AppointmentConfirmed')?.count).toBe(3)
    e2(fetchPage).toHaveBeenCalledTimes(2)
  })
})
