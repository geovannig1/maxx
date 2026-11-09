import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
const mocks = vi.hoisted(() => ({ auth: vi.fn(), account: vi.fn(), meta: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: mocks.auth } }) }))
vi.mock('@/lib/accounts/active-account', () => ({ resolveOnlyActiveAccount: mocks.account }))
vi.mock('@/lib/platforms/meta/client', () => ({ metaGet: mocks.meta }))
import { GET } from '@/app/api/reporting/route'
import { requestReportingPacket } from '@/lib/reporting/request-packet'
import { clearReportingCache } from '@/lib/reporting/loader'

let releaseOptional = () => {}
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-05T17:00:00Z'))
  vi.clearAllMocks(); clearReportingCache()
  vi.stubEnv('OWNER_EMAIL', 'owner@example.test')
  mocks.auth.mockResolvedValue({ data: { user: { id: 'owner', email: 'owner@example.test', email_confirmed_at: '2026-01-01T00:00:00Z' } }, error: null })
  mocks.account.mockResolvedValue({ ok: true, account: { id: 'account-db', accountId: 'act_123', accountName: 'Studio' } })
  const optional = new Promise<void>(resolve => { releaseOptional = resolve })
  mocks.meta.mockImplementation(async (path: string, params: Record<string, string>) => {
    if (path === '/act_123') return { id: 'act_123', currency: 'USD', timezone_name: 'America/New_York' }
    if (!path.endsWith('/insights') || params.breakdowns || params.time_increment) { await optional; return { data: [] } }
    const range = JSON.parse(params.time_range)
    return { data: [{ date_start: range.since, date_stop: range.until, account_id: '123',
      spend: '100', impressions: '200', reach: '150', frequency: '1.333', clicks: '10', inline_link_clicks: '8',
      campaign_id: 'c', campaign_name: 'Campaign', adset_id: 's', adset_name: 'Ad set', ad_id: 'a', ad_name: 'Ad',
    }] }
  })
  vi.stubGlobal('fetch', vi.fn((url: string, init: RequestInit) => GET(new NextRequest(`http://localhost${url}`, {
    ...init, signal: init.signal ?? undefined,
  }))))
})
afterEach(() => { releaseOptional(); clearReportingCache(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs() })
const key = 'from=2026-09-02&to=2026-09-04'

describe('actual adapter, validator, loader, route and client stream together', () => {
  it('delivers validated core data before optional reads finish, then completes and reuses the exact cache', async () => {
    const controller = new AbortController(), onProgress = vi.fn()
    const pending = requestReportingPacket('meta', key, controller.signal, false, onProgress).catch(error => error)
    try {
      await vi.waitFor(() => expect(onProgress).toHaveBeenCalledOnce())
      const first = onProgress.mock.calls[0][0]
      expect(first.result.data.metrics.spend.current.value).toBe(100)
      expect(first.result.data.detailState).toBe('loading')
      expect(first.result.data.entities).toHaveLength(3)
      expect(first.result.data.entities.every((entity: { audience: string }) => entity.audience === 'unknown')).toBe(true)
      releaseOptional()
      const final = await pending
      expect(final).toMatchObject({ section: 'meta', result: { state: 'partial', data: { detailState: 'complete' } } })
      expect(final.result.data.metrics.spend).toEqual(first.result.data.metrics.spend)
      const calls = mocks.meta.mock.calls.length
      const cachedProgress = vi.fn()
      const cached = await requestReportingPacket('meta', key, controller.signal, false, cachedProgress)
      expect(cached.result).toEqual(final.result)
      expect(cachedProgress).not.toHaveBeenCalled()
      expect(mocks.meta).toHaveBeenCalledTimes(calls)
      const aggregateQueries = mocks.meta.mock.calls.filter(([path, params]) => path.endsWith('/insights') && !params.breakdowns && !params.time_increment)
      expect(aggregateQueries).toHaveLength(8)
    } finally { releaseOptional(); controller.abort(); await pending }
  })
  it('never emits progress when Meta account identity fails verification', async () => {
    mocks.meta.mockResolvedValue({ id: 'act_wrong', currency: 'USD', timezone_name: 'America/New_York' })
    const progress = vi.fn()
    const result = await requestReportingPacket('meta', key, new AbortController().signal, false, progress)
    expect(result.result.state).toBe('unavailable')
    expect(progress).not.toHaveBeenCalled()
    expect(mocks.meta).toHaveBeenCalledOnce()
  })
  it('rejects an absent session before account or Meta reads despite requesting a stream', async () => {
    mocks.auth.mockResolvedValue({ data: { user: null }, error: null })
    await expect(requestReportingPacket('meta', key, new AbortController().signal)).rejects.toMatchObject({ kind: 'access' })
    expect(mocks.account).not.toHaveBeenCalled()
    expect(mocks.meta).not.toHaveBeenCalled()
  })
  it('rejects an authenticated non-owner before account or Meta reads', async () => {
    releaseOptional()
    mocks.auth.mockResolvedValue({ data: { user: { id: 'other', email: 'other@example.test' } }, error: null })
    await expect(requestReportingPacket('meta', key, new AbortController().signal)).rejects.toMatchObject({ kind: 'access' })
    expect(mocks.account).not.toHaveBeenCalled()
    expect(mocks.meta).not.toHaveBeenCalled()
  })
})
