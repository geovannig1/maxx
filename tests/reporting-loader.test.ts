import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ meta: vi.fn(), business: vi.fn(), website: vi.fn(), measurement: vi.fn() }))
vi.mock('@/lib/platforms/meta/reporting/meta-reader', () => ({ readMetaReport: mocks.meta }))
vi.mock('@/lib/reporting/business-reader', () => ({ readBusinessReport: mocks.business }))
vi.mock('@/lib/reporting/website-reader', () => ({ readWebsiteReport: mocks.website }))
vi.mock('@/lib/reporting/measurement-reader', () => ({ readMeasurementReport: mocks.measurement }))
import { clearReportingCache, loadReportingSection, validateReportingPacket } from '@/lib/reporting/loader'
import { snapshotContext, snapshotPacket } from './fixtures/reporting-snapshot'
import { upcomingBusinessContext } from '@/lib/reporting/business-intelligence-context'
import { buildBusinessReport } from '@/lib/reporting/business-metrics'
import { makeReportMetric } from '@/lib/reporting/claims'
import type { MetaReport, ReportSection, ReportingContext } from '@/lib/reporting/contracts'
const context: ReportingContext = {
  account: { id: 'db', metaAccountId: 'act_1', name: 'Studio' }, range: { from: '2026-09-02', to: '2026-09-04' },
  comparison: { from: '2026-08-30', to: '2026-09-01' }, timezone: 'America/New_York', currency: 'USD', asOf: '2026-09-05T17:00:00Z',
}
const result = { state: 'available', asOf: context.asOf, notes: [], data: {
  metrics: {}, entities: [], series: [], comparisonSeries: [], breakdowns: [], observations: [],
  attributionWindow: '7d click / 1d view', reportingTime: 'impression', sourceDescription: 'Meta',
} }
function metaResult(detailState: MetaReport['detailState'], spend = 100, reportContext = context): ReportSection<MetaReport> {
  return { ...result, asOf: reportContext.asOf, state: detailState === 'loading' ? 'partial' : 'available',
    notes: detailState === 'loading' ? ['Optional Meta details, configuration and trends are loading.'] : [],
    data: { ...result.data, detailState, metrics: {
      spend: makeReportMetric({ context: reportContext, key: 'spend', label: 'Spend', definition: 'Spend', source: 'meta', unit: 'money', current: spend }),
    } },
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
describe('source-isolated reporting loader', () => {
  beforeEach(() => { vi.clearAllMocks(); clearReportingCache(); mocks.meta.mockReset(); mocks.meta.mockResolvedValue(result) })
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers() })
  it('separates selected parent levels and IDs in both in-flight reads and completed cache', async () => {
    const held = deferred<ReportSection<MetaReport>>()
    mocks.meta.mockReturnValue(held.promise)
    const load = (historyEntity?: { level: 'campaign' | 'adset'; id: string }) =>
      loadReportingSection('meta', snapshotContext, false, [], undefined, undefined, { historyEntity })
    const campaign = { level: 'campaign', id: 'same-id' } as const
    const reads = [load(campaign), load(campaign), load({ level: 'adset', id: 'same-id' }),
      load({ level: 'campaign', id: 'other-id' }), load()]
    await Promise.resolve(); await Promise.resolve()
    expect(mocks.meta).toHaveBeenCalledTimes(4)
    expect(mocks.meta.mock.calls[0][1].historyEntity).toEqual(campaign)
    held.resolve(snapshotPacket().result)
    await Promise.all(reads)
    await load(campaign)
    await load({ level: 'adset', id: 'same-id' })
    expect(mocks.meta).toHaveBeenCalledTimes(4)
    await expect(loadReportingSection('business', context, false, [], undefined, undefined, { historyEntity: campaign })).rejects.toThrow()
    await expect(loadReportingSection('meta', context, false, ['ad'], undefined, undefined, { historyEntity: campaign })).rejects.toThrow()
  })
  it('rejects wrong-parent progress and completion before exposing or caching it', async () => {
    const historyEntity = { level: 'adset', id: 'selected-set' } as const
    const wrong = snapshotPacket().result
    wrong.data!.entities = [{ id: 'other-set', level: 'adset', name: 'Other', campaignId: 'c1', campaignName: null,
      adsetId: null, adsetName: null, status: 'UNKNOWN', configurationAsOf: null, audience: 'unknown', audienceLabel: 'Unknown',
      creative: null, metrics: {}, series: [], comparisonSeries: [] }]
    mocks.meta.mockImplementation(async (_context, options) => {
      options.onProgress({ ...wrong, state: 'partial', data: { ...wrong.data, detailState: 'loading' } })
      return wrong
    })
    const progress = vi.fn()
    const load = () => loadReportingSection('meta', snapshotContext, false, [], progress, undefined, { historyEntity })
    expect((await load()).result.state).toBe('unavailable')
    expect(progress).not.toHaveBeenCalled()
    await load()
    expect(mocks.meta).toHaveBeenCalledTimes(2)
  })
  it('isolates a prepared generation from an older live read and completed cache', async () => {
    const old = deferred<ReportSection<MetaReport>>()
    const fresh = deferred<ReportSection<MetaReport>>()
    const next = { ...context, asOf: '2026-09-05T17:00:40Z' }
    mocks.meta.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise)
    const legacy = loadReportingSection('meta', context)
    const prepared = loadReportingSection('meta', next, true, [], undefined, undefined, { isolateGeneration: true })
    const joined = loadReportingSection('meta', next, true, [], undefined, undefined, { isolateGeneration: true })
    await Promise.resolve(); await Promise.resolve()
    expect(mocks.meta).toHaveBeenCalledTimes(2)
    old.resolve(metaResult('complete', 100, context)); fresh.resolve(metaResult('complete', 200, next))
    expect((await legacy).context.asOf).toBe(context.asOf)
    expect((await prepared).context.asOf).toBe(next.asOf)
    expect(await joined).toEqual(await prepared)
    expect((await loadReportingSection('meta', context)).context.asOf).toBe(context.asOf)
    expect(mocks.meta).toHaveBeenCalledTimes(2)
  })
  it('shares in-flight/cache reads only for the exact account and period', async () => {
    await Promise.all([loadReportingSection('meta', context), loadReportingSection('meta', context)])
    expect(mocks.meta).toHaveBeenCalledTimes(1)
    await loadReportingSection('meta', { ...context, account: { ...context.account, id: 'other', metaAccountId: 'act_2' } })
    expect(mocks.meta).toHaveBeenCalledTimes(2)
    expect(mocks.business).not.toHaveBeenCalled()
  })
  it('does not cache unavailable sources and contains their failure', async () => {
    mocks.meta.mockRejectedValue(new Error('secret'))
    const first = await loadReportingSection('meta', context)
    expect(first.result.state).toBe('unavailable')
    expect(JSON.stringify(first)).not.toContain('secret')
    await loadReportingSection('meta', context)
    expect(mocks.meta).toHaveBeenCalledTimes(2)
  })
  it('rejects a claim belonging to another evidence source or date window', () => {
    const metric = makeReportMetric({ context, key: 'paid_bookings', label: 'Bookings', definition: 'Paid bookings', source: 'outcomes', unit: 'count', current: 2 })
    expect(() => validateReportingPacket({ section: 'meta', context, notes: [], result: { ...result, data: { ...result.data, metrics: { paid_bookings: metric } } } })).toThrow()
    const old = makeReportMetric({ context: { ...context, range: { from: '2025-09-02', to: '2025-09-04' } }, key: 'spend', label: 'Spend', definition: 'Spend', source: 'meta', unit: 'money', current: 2 })
    expect(() => validateReportingPacket({ section: 'meta', context, notes: [], result: { ...result, data: { ...result.data, metrics: { spend: old } } } })).toThrow()
  })
  it('shares one validated early packet with concurrent and late subscribers, containing observer failures and aborts', async () => {
    vi.useFakeTimers()
    const completion = deferred<ReportSection<MetaReport>>()
    let publish!: (value: ReportSection<MetaReport>) => void
    mocks.meta.mockImplementation((_context, options) => { publish = options.onProgress; return completion.promise })
    const canceled = vi.fn(), observer = vi.fn(), late = vi.fn()
    const abort = new AbortController()
    const first = loadReportingSection('meta', context, false, ['b', 'a', 'a'], canceled, abort.signal)
    const second = loadReportingSection('meta', context, false, ['a', 'b'], observer)
    const broken = loadReportingSection('meta', context, false, ['a', 'b'], () => { throw new Error('observer') })
    const brokenAsync = loadReportingSection('meta', context, false, ['a', 'b'], async () => { throw new Error('async observer') })
    await vi.advanceTimersByTimeAsync(0)
    abort.abort()
    publish?.(metaResult('loading'))
    await vi.advanceTimersByTimeAsync(0)
    expect(observer).toHaveBeenCalledTimes(1)
    expect(canceled).not.toHaveBeenCalled()
    expect(observer.mock.calls[0][0].result.data.metrics.spend.current.value).toBe(100)
    expect(() => validateReportingPacket(observer.mock.calls[0][0])).not.toThrow()
    const third = loadReportingSection('meta', context, false, ['b', 'a'], late)
    expect(late).toHaveBeenCalledTimes(1)
    expect(late.mock.calls[0][0]).toEqual(observer.mock.calls[0][0])
    expect(mocks.meta).toHaveBeenCalledTimes(1)
    completion.resolve(metaResult('complete'))
    const final = await Promise.all([first, second, third, broken, brokenAsync])
    expect(final.every(packet => packet.section === 'meta' && packet.result.data?.detailState === 'complete')).toBe(true)
    publish?.(metaResult('loading', 999))
    expect(observer).toHaveBeenCalledTimes(1)
    expect(late).toHaveBeenCalledTimes(1)
    expect(canceled).not.toHaveBeenCalled()
  })
  it('validates progress before observers and never retains an invalid early packet as timeout fallback', async () => {
    vi.useFakeTimers()
    const completion = deferred<ReportSection<MetaReport>>()
    const wrongSource = makeReportMetric({ context, key: 'spend', label: 'Spend', definition: 'Spend', source: 'outcomes', unit: 'money', current: 999 })
    mocks.meta.mockImplementation((_context, options) => {
      options.onProgress?.({ ...metaResult('loading'), data: { ...result.data, detailState: 'loading', metrics: { spend: wrongSource } } })
      return completion.promise
    })
    const observer = vi.fn()
    const pending = loadReportingSection('meta', context, false, [], observer)
    await vi.advanceTimersByTimeAsync(0)
    expect(observer).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(90_000)
    const unavailable = await pending
    expect(unavailable.result.state).toBe('unavailable')
    expect(unavailable.result.data).toBeNull()
    completion.resolve(metaResult('complete'))
    await vi.advanceTimersByTimeAsync(0)
    expect(observer).not.toHaveBeenCalled()
  })
  it('retains early totals and their as-of on timeout, allows retry, and ignores abandoned late progress/results', async () => {
    vi.useFakeTimers()
    const abandoned = deferred<ReportSection<MetaReport>>()
    const recovery = deferred<ReportSection<MetaReport>>()
    let latePublish!: (value: ReportSection<MetaReport>) => void
    mocks.meta.mockImplementationOnce((_context, options) => {
      latePublish = options.onProgress
      options.onProgress?.(metaResult('loading', 100, { ...context, asOf: '2026-09-05T16:00:00Z' }))
      return abandoned.promise
    }).mockImplementationOnce(() => recovery.promise)
    const observer = vi.fn()
    const pending = loadReportingSection('meta', context, false, [], observer)
    await vi.advanceTimersByTimeAsync(0)
    expect(observer).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(90_000)
    const fallback = await pending
    expect(fallback.result.state).toBe('partial')
    expect(fallback.result.asOf).toBe('2026-09-05T16:00:00Z')
    expect(fallback.section === 'meta' && fallback.result.data?.detailState).toBe('unavailable')
    expect(fallback.section === 'meta' && fallback.result.data?.metrics.spend.current.value).toBe(100)
    expect(fallback.result.notes.join(' ')).toMatch(/optional.*timed out/i)
    expect(fallback.result.notes.join(' ')).not.toContain('are loading')
    expect(() => validateReportingPacket(fallback)).not.toThrow()
    const retryObserver = vi.fn()
    const retry = loadReportingSection('meta', context, false, [], retryObserver)
    await vi.advanceTimersByTimeAsync(0)
    latePublish?.(metaResult('loading', 999))
    abandoned.resolve(metaResult('complete', 999))
    await vi.advanceTimersByTimeAsync(0)
    expect(observer).toHaveBeenCalledTimes(1)
    expect(retryObserver).not.toHaveBeenCalled()
    const joinedRetry = loadReportingSection('meta', context)
    expect(mocks.meta).toHaveBeenCalledTimes(2)
    recovery.resolve(metaResult('complete', 200))
    const [recovered, joined] = await Promise.all([retry, joinedRetry])
    expect(recovered).toEqual(joined)
    expect(recovered.section === 'meta' && recovered.result.data?.metrics.spend.current.value).toBe(200)
    expect(await loadReportingSection('meta', context)).toEqual(recovered)
    expect(mocks.meta).toHaveBeenCalledTimes(2)
  })
  it('keeps detail keys, periods and refreshes separate while caching only completed successes', async () => {
    mocks.meta.mockImplementation(reportContext => Promise.resolve(metaResult('complete', 100, reportContext)))
    await Promise.all([loadReportingSection('meta', context, false, ['a', 'b']), loadReportingSection('meta', context, false, ['b', 'a'])])
    await loadReportingSection('meta', context, false, ['a'])
    await loadReportingSection('meta', { ...context, range: { from: '2026-09-01', to: '2026-09-03' }, comparison: { from: '2026-08-29', to: '2026-08-31' } })
    expect(mocks.meta).toHaveBeenCalledTimes(3)
    await loadReportingSection('meta', context, true, ['a'])
    expect(mocks.meta).toHaveBeenCalledTimes(4)
    mocks.meta.mockResolvedValue(metaResult('loading'))
    await loadReportingSection('meta', context)
    await loadReportingSection('meta', context)
    expect(mocks.meta).toHaveBeenCalledTimes(6)
  })
})


describe('business intelligence progress in the shared loader', () => {
  const business = (state: 'loading' | 'unavailable' | 'partial') => {
    const section = { state, data: null, asOf: null, notes: [] }
    const leadTime = state === 'partial' ? { state: 'partial', data: { metrics: {}, buckets: [] }, asOf: context.asOf, notes: ['Partial native coverage.'] } : section
    return { state: 'partial', asOf: context.asOf, notes: [], data: { ...buildBusinessReport(context, [], []), intelligence: {
      customers: state === 'partial' ? { state: 'available', data: { metrics: {}, groups: [], historyFrom: null, historyTo: context.range.to, identityBasis: 'normalized_email', historyCoverage: 'retained_ledger' }, asOf: context.asOf, notes: [] } : section,
      leadTime, upcoming: state === 'partial' ? { state: 'available', data: { range: upcomingBusinessContext(context, context.asOf).range, metrics: {}, days: [], types: [] }, asOf: context.asOf, notes: [] } : section,
    } } }
  }
  beforeEach(() => { vi.clearAllMocks(); clearReportingCache(); mocks.business.mockReset() })
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers() })
  it('opts in, shares validated progress, retains core on timeout, ignores late updates and retries failed extras', async () => {
    vi.useFakeTimers()
    const held = deferred<unknown>(), progress = vi.fn(), canceled = vi.fn(), abort = new AbortController()
    let publish!: (value: unknown) => void
    mocks.business.mockImplementationOnce((_context, options) => { publish = options?.onProgress; publish?.(business('loading')); return held.promise })
    const first = loadReportingSection('business', context, false, [], progress)
    await vi.advanceTimersByTimeAsync(0)
    expect(mocks.business.mock.calls[0][1]).toMatchObject({ includeIntelligence: true })
    expect(progress).toHaveBeenCalledOnce()
    const joined = loadReportingSection('business', context, false, [], canceled, abort.signal)
    expect(canceled).toHaveBeenCalledOnce()
    abort.abort()
    await vi.advanceTimersByTimeAsync(90_000)
    const final = await first
    expect(final).toMatchObject({ section: 'business', result: { state: 'partial', data: { intelligence: { customers: { state: 'unavailable' } } } } })
    expect(final.result.asOf).toBe(context.asOf)
    expect(await joined).toEqual(final)
    publish?.(business('loading')); held.resolve(business('partial'))
    await vi.advanceTimersByTimeAsync(0)
    expect(progress).toHaveBeenCalledOnce()
    expect(canceled).toHaveBeenCalledOnce()
    mocks.business.mockResolvedValue(business('unavailable'))
    await loadReportingSection('business', context)
    await loadReportingSection('business', context)
    expect(mocks.business).toHaveBeenCalledTimes(3)
  })
  it('contains invalid extras and never caches pending intelligence, but caches valid ordinary partial coverage', async () => {
    mocks.business.mockImplementationOnce((_context, options) => { options?.onProgress?.(business('loading')); return { ...business('unavailable'), data: { ...business('unavailable').data, intelligence: { private: 'secret' } } } })
    const failed = await loadReportingSection('business', context)
    expect(failed).toMatchObject({ result: { state: 'partial', data: { intelligence: { customers: { state: 'unavailable' } } } } })
    expect(JSON.stringify(failed)).not.toContain('secret')
    mocks.business.mockResolvedValue(business('loading'))
    await loadReportingSection('business', context)
    await loadReportingSection('business', context)
    expect(mocks.business).toHaveBeenCalledTimes(3)
    mocks.business.mockResolvedValue(business('partial'))
    const complete = await loadReportingSection('business', context)
    expect(complete.result.state).toBe('partial')
    expect(await loadReportingSection('business', context)).toEqual(complete)
    expect(mocks.business).toHaveBeenCalledTimes(4)
  })
})
