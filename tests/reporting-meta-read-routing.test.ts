import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readMetaPages, readMetaReport } from '@/lib/platforms/meta/reporting/meta-reader'
import { readMetaInventory } from '@/lib/platforms/meta/reporting/meta-inventory'
import { validateReportingPacket } from '@/lib/reporting/validation'
import type { MetaReport, ReportSection, ReportingContext } from '@/lib/reporting/contracts'
import type { MetaRow } from '@/lib/reporting/meta-metrics'
const { get, history } = vi.hoisted(() => ({ get: vi.fn(), history: vi.fn() }))
vi.mock('@/lib/platforms/meta/client', () => ({ metaGet: get }))
vi.mock('@/lib/reporting/creative-assignment-reader', () => ({ readReportCreativeAssignmentEvidence: history }))
const context: ReportingContext = { account: { id: '00000000-0000-4000-8000-000000001311', metaAccountId: '123', name: 'Fictional account' },
  range: { from: '2026-09-02', to: '2026-09-04' }, comparison: { from: '2026-08-30', to: '2026-09-01' },
  timezone: 'America/New_York', currency: 'USD', asOf: '2026-09-05T16:00:00Z' }
function response(path: string, params: Record<string, string>): MetaRow {
  if (path === '/act_123') return { id: 'act_123', currency: 'USD', timezone_name: 'America/New_York' }
  if (path.endsWith('/campaigns')) return { data: [{ id: '101', name: 'Campaign' }] }
  if (path.endsWith('/adsets')) return { data: [{ id: '201', campaign_id: '101', name: 'Set' }] }
  if (path.endsWith('/ads')) return { data: [{ id: '301', campaign_id: '101', adset_id: '201', name: 'Ad', creative: { id: '501' } }] }
  if (path.endsWith('/customaudiences')) return { data: [] }
  if (path === '/501') return { id: '501', video_id: '601', body: 'Fictional copy' }
  if (path === '/601') return { id: '601', length: 12.5, source: 'https://example.test/fictional-video.mp4' }
  if (path.endsWith('/insights')) {
    if (params.breakdowns) return { data: [] }
    const range = JSON.parse(params.time_range)
    return { data: [{ date_start: range.since, date_stop: params.time_increment ? range.since : range.until,
      account_id: '123', campaign_id: '101', campaign_name: 'Campaign', adset_id: '201', adset_name: 'Set', ad_id: '301', ad_name: 'Ad',
      spend: '100', impressions: '1000', results: [{ indicator: 'AppointmentConfirmed', values: [{ value: '2', attribution_windows: ['default'] }] }],
      conversion_values: [{ action_type: 'AppointmentConfirmed', value: '200' }],
      actions: [{ action_type: 'purchase', value: '3' }], action_values: [{ action_type: 'purchase', value: '300' }],
    }] }
  }
  throw new Error('Unexpected fictional path')
}
function assertReport(result: ReportSection<MetaReport>) {
  expect(() => validateReportingPacket({ context, section: 'meta', result, notes: [] })).not.toThrow()
}
const isCurrentAdset = (path: string, params: Record<string, string>) => path.endsWith('/insights') && params.level === 'adset'
  && !params.time_increment && !params.breakdowns && JSON.parse(params.time_range).since === context.range.from
beforeEach(() => {
  get.mockReset(); get.mockImplementation(response)
  history.mockReset(); history.mockResolvedValue({ accountId: context.account.id, asOf: context.asOf,
    state: 'unavailable', observations: [], notes: ['Fictional assignment history not supplied.'] })
})
afterEach(() => { vi.useRealTimers() })

describe('report-scoped Meta routing', () => {
  it('keeps every pagination request on the injected getter and fixed path', async () => {
    const injected = vi.fn().mockResolvedValueOnce({ data: [{ id: 'one' }], paging: { next: 'https://untrusted.invalid', cursors: { after: 'second' } } })
      .mockResolvedValueOnce({ data: [{ id: 'two' }] })
    const rows = await readMetaPages('/act_123/campaigns', { fields: 'id', limit: '200' }, injected)
    expect(rows).toEqual([{ id: 'one' }, { id: 'two' }])
    expect(injected.mock.calls).toEqual([
      ['/act_123/campaigns', { fields: 'id', limit: '200' }],
      ['/act_123/campaigns', { fields: 'id', limit: '200', after: 'second' }],
    ])
    expect(get).not.toHaveBeenCalled()
  })
  it('uses the injected inventory getter for both creative and video reads', async () => {
    const pages = vi.fn(async (path: string) => path.endsWith('/ads') ? [{ id: '301', creative: { id: '501' } }] : [])
    const injected = vi.fn().mockImplementation(async (path: string, params: Record<string, string>) => response(path, params))
    const inventory = await readMetaInventory(context, pages, injected)
    expect(inventory.creatives['501']).toMatchObject({ videoUrl: 'https://example.test/fictional-video.mp4', durationSeconds: 12.5 })
    expect(injected.mock.calls.map(([path]) => path)).toEqual(['/501', '/601'])
    expect(get).not.toHaveBeenCalled()
    expect(pages.mock.calls.map(([path]) => path).sort()).toEqual(['/act_123/ads', '/act_123/adsets', '/act_123/campaigns', '/act_123/customaudiences'].sort())
  })
  it('loads an exact story-video preview for conflicting native IDs and caches a shared video read', async () => {
    const pages = vi.fn(async (path: string) => path.endsWith('/ads') ? [
      { id: '301', creative: { id: '501' } }, { id: '302', creative: { id: '502' } },
    ] : [])
    const injectedCalls: string[] = []
    const injected: NonNullable<Parameters<typeof readMetaInventory>[2]> = async <T,>(path: string): Promise<T> => {
      injectedCalls.push(path)
      if (path === '/501' || path === '/502') return { id: path.slice(1), video_id: path === '/501' ? '701' : '702',
        object_story_spec: { video_data: { video_id: '601' } } } as T
      if (path === '/601') return { id: '601', length: 12.5, source: 'https://example.test/story-video.mp4' } as T
      throw Object.assign(new Error('not readable'), { code: 10 })
    }
    const inventory = await readMetaInventory(context, pages, injected)
    expect(inventory.creatives['501']).toMatchObject({ videoUrl: 'https://example.test/story-video.mp4', durationSeconds: 12.5,
      videoPreviewEvidence: { videoId: '601', basis: 'object_story_spec_video_id' }, identity: { structure: 'unknown' } })
    expect(inventory.creatives['502']).toMatchObject({ videoUrl: 'https://example.test/story-video.mp4', durationSeconds: 12.5,
      videoPreviewEvidence: { videoId: '601', basis: 'object_story_spec_video_id' }, identity: { structure: 'unknown' } })
    expect(injectedCalls.filter(path => path === '/601')).toHaveLength(1)
    expect(inventory.notes.join(' ')).toMatch(/configured story-video preview.*alternate video identit/i)
  })
  it.each(['inventory', 'creative', 'video'])('retains a safe quota explanation for %s failure without exposing provider text', async failed => {
    const quota = () => Object.assign(new Error('synthetic-private-token-do-not-display'), { code: 4 })
    const pages = vi.fn(async (path: string) => {
      if (path.endsWith('/ads') && failed === 'inventory') throw quota()
      if (path.endsWith('/ads')) return [{ id: '301', creative: { id: '501' } }]
      return []
    })
    const injected = vi.fn().mockImplementation((path: string, params: Record<string, string>) => {
      if ((path === '/501' && failed === 'creative') || (path === '/601' && failed === 'video')) throw quota()
      return response(path, params)
    })
    const inventory = await readMetaInventory(context, pages, injected)
    expect(inventory.notes.join(' ')).toContain('Meta temporarily limited reporting reads.')
    expect(inventory.notes.join(' ')).not.toContain('synthetic-private-token-do-not-display')
    expect(get).not.toHaveBeenCalled()
    if (failed === 'video') expect(inventory.creatives['501']).toMatchObject({ body: 'Fictional copy', durationSeconds: null })
    else expect(inventory.creatives).toEqual({})
  })
  it('does not label a generic unavailable configuration as quota exhaustion', async () => {
    const pages = vi.fn().mockRejectedValue(new Error('Fictional unsupported configuration'))
    const inventory = await readMetaInventory(context, pages, get)
    expect(inventory.notes.join(' ')).toContain('configuration unavailable')
    expect(inventory.notes.join(' ')).not.toContain('temporarily limited')
    expect(inventory.notes.join(' ')).not.toContain('Fictional unsupported configuration')
  })
  it.each([false, true])('bounds actual reader concurrency and gives all period totals priority, detail=%s', async detail => {
    let running = 0, maximum = 0
    const started: Array<[string, Record<string, string>]> = []
    get.mockImplementation(async (path, params) => {
      running += 1; maximum = Math.max(maximum, running); started.push([path, params])
      await Promise.resolve()
      running -= 1
      return response(path, params)
    })
    const result = await readMetaReport(context, { detailIds: detail ? ['301'] : [] })
    expect(maximum).toBeLessThanOrEqual(4)
    expect(maximum).toBeGreaterThan(1)
    const insights = started.filter(([path]) => path.endsWith('/insights'))
    expect(insights).toHaveLength(detail ? 24 : 20)
    expect(insights.slice(0, 8).every(([, params]) => !params.time_increment && !params.breakdowns)).toBe(true)
    expect(new Set(insights.slice(0, 8).map(([, params]) => `${params.level}:${JSON.parse(params.time_range).since}`)).size).toBe(8)
    expect(result.data!.metrics.bookings.current.value).toBe(2)
    expect(result.data!.series[0].metrics.purchase_count.current.value).toBe(3)
    expect(result.data!.entities.find(entity => entity.level === 'ad')!.creative?.durationSeconds).toBe(12.5)
    assertReport(result)
  })
  it('retains valid current ad-set results after a single quota response and safe retry', async () => {
    vi.useFakeTimers()
    let attempts = 0
    get.mockImplementation((path, params) => {
      if (isCurrentAdset(path, params) && ++attempts === 1) throw Object.assign(new Error('Fictional private response body'), { code: 4, subcode: 1504022 })
      return response(path, params)
    })
    const pending = readMetaReport(context)
    await vi.advanceTimersByTimeAsync(6_000)
    const result = await pending
    expect(attempts).toBe(2)
    expect(result.data!.entities.find(entity => entity.level === 'adset')!.metrics.spend.current.value).toBe(100)
    expect(result.notes.join(' ')).not.toContain('Fictional private response body')
    expect(vi.getTimerCount()).toBe(0)
    assertReport(result)
  })
  it('distinguishes repeated quota failure while retaining successful period results and closing the session', async () => {
    vi.useFakeTimers()
    let attempts = 0
    get.mockImplementation((path, params) => {
      if (isCurrentAdset(path, params)) { attempts += 1; throw Object.assign(new Error('synthetic-private-token-do-not-display'), { code: 4, subcode: 1504022 }) }
      return response(path, params)
    })
    const pending = readMetaReport(context)
    await vi.advanceTimersByTimeAsync(6_000)
    const result = await pending
    expect(attempts).toBe(2)
    expect(result.data!.metrics.spend.current.value).toBe(100)
    expect(result.data!.entities.find(entity => entity.level === 'adset')?.metrics.spend?.current.value ?? null).toBeNull()
    expect(result.notes.join(' ')).toContain('Meta temporarily limited reporting reads.')
    expect(result.notes.join(' ')).not.toContain('synthetic-private-token-do-not-display')
    expect(vi.getTimerCount()).toBe(0)
    assertReport(result)
  })
  it.each([true, false])('finishes partial after the deadline with successful totals retained, transport honors abort=%s', async cooperates => {
    vi.useFakeTimers()
    let aborted = 0
    get.mockImplementation((path, params, options) => path === '/act_123' || (path.endsWith('/insights') && !params.time_increment && !params.breakdowns)
      ? response(path, params) : new Promise((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => { aborted += 1; if (cooperates) reject(options.signal.reason) }, { once: true })
      }))
    let final: ReportSection<MetaReport> | undefined
    const onProgress = vi.fn()
    void readMetaReport(context, { onProgress }).then(result => { final = result })
    await vi.advanceTimersByTimeAsync(0)
    expect(onProgress).toHaveBeenCalledTimes(1)
    expect(onProgress.mock.calls[0][0].data.metrics.bookings.current.value).toBe(2)
    expect(final).toBeUndefined()
    await vi.advanceTimersByTimeAsync(80_001)
    expect(final).toBeDefined()
    expect(aborted).toBeGreaterThan(0)
    expect(final!.data!.metrics.spend.current.value).toBe(100)
    expect(final!.notes.join(' ')).toContain('Meta reporting reached its read deadline.')
    expect(vi.getTimerCount()).toBe(0)
    assertReport(final!)
  })
  it.each(['mismatch', 'quota'])('closes the session after metadata %s without exposing the provider body', async mode => {
    vi.useFakeTimers()
    get.mockImplementation(() => {
      if (mode === 'quota') throw Object.assign(new Error('synthetic-private-token-do-not-display'), { code: 4 })
      return { id: 'act_999', currency: 'USD', timezone_name: 'America/New_York' }
    })
    const pending = readMetaReport(context)
    await vi.advanceTimersByTimeAsync(6_000)
    const result = await pending
    expect(result.state).toBe('unavailable')
    expect(result.data).toBeNull()
    expect(result.notes.join(' ')).not.toContain('synthetic-private-token-do-not-display')
    if (mode === 'quota') expect(result.notes.join(' ')).toContain('Meta temporarily limited reporting reads.')
    expect(vi.getTimerCount()).toBe(0)
    expect(get.mock.calls.every(([path]) => path === '/act_123')).toBe(true)
  })
})
