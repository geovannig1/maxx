import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readMetaReport } from '@/lib/platforms/meta/reporting/meta-reader'
import { CAMPAIGN_DAILY_INPUT_KEYS, META_DAILY_METRIC_KEYS, dayOffset } from '@/lib/reporting/meta-breakdowns'
import { makeReportingSnapshotScope } from '@/lib/reporting/snapshot-scope'
import { validateScopedReportingPacket } from '@/lib/reporting/packet-scope'
import { validateReportingPacket } from '@/lib/reporting/validation'
import { filterEntities } from '@/components/reporting/MetricTable'
import type { MetaReport, ReportSection, ReportingContext } from '@/lib/reporting/contracts'
import type { MetaRow } from '@/lib/reporting/meta-metrics'
// Measured 2026-11-07 (scripts/bench/reporting-packet.ts, docs/operations.md): ~0.3 s to build this
// packet in-process; 2026-11-10 at load average ~18-25: 0.6-1.4 s for the whole test alone (read ~0.4 s,
// validation ~0.3 s, 21 MB stringify ~0.1 s, all asserted work). A 15 s budget still timed out once in the
// full gate while other suites shared the machine, because CPU starvation, not this code, set the time.
// Wall time is therefore only a hang bound here: the operation-count guard in
// tests/reporting-meta-scaling.test.ts is what catches a scaling regression, deterministically.
const STRESS_TEST_TIMEOUT_MS = 60_000
const { get, history } = vi.hoisted(() => ({ get: vi.fn(), history: vi.fn() }))
vi.mock('@/lib/platforms/meta/client', () => ({ metaGet: get }))
vi.mock('@/lib/reporting/creative-assignment-reader', () => ({ readReportCreativeAssignmentEvidence: history }))
const context: ReportingContext = {
  account: { id: '00000000-0000-4000-8000-000000001311', metaAccountId: '123', name: 'Fictional parent history' },
  range: { from: '2026-09-02', to: '2026-09-04' }, comparison: { from: '2026-08-30', to: '2026-09-01' },
  timezone: 'America/New_York', currency: 'USD', asOf: '2026-09-20T16:00:00Z',
}
type Parent = { level: 'campaign' | 'adset'; id: string }
const selection = (level: Parent['level']): Parent => ({ level, id: level === 'campaign' ? '101' : '201' })
const action = (action_type: string, value: number) => ({ action_type, value: String(value) })
function row(level: string, id: string, date: string, stop: string, daily: boolean, current: boolean): MetaRow {
  const second = id.endsWith('2')
  const firstDay = date === (current ? context.range.from : context.comparison.from)
  const spend = level === 'account' ? daily ? 100 : 200 : daily ? firstDay !== second ? 80 : 20 : 100
  const count = level === 'account' ? 0 : daily ? 1 : 2
  return { account_id: '123', campaign_id: second ? '102' : '101', campaign_name: second ? 'Second campaign' : 'First campaign',
    adset_id: second ? '202' : '201', adset_name: second ? 'Second set' : 'First set', ad_id: second ? '302' : '301', ad_name: 'Fictional ad',
    date_start: date, date_stop: stop, spend: String(spend), impressions: '1000',
    reach: String(level === 'account' ? 777 : level === 'campaign' ? 301 : level === 'adset' ? 211 : 101), frequency: '1.25',
    clicks: '30', inline_link_clicks: '12', outbound_clicks: [action('outbound_click', 20)],
    actions: [action('purchase', daily ? 1 : 2), action('post_engagement', current ? 100 : 50), action('landing_page_view', 15),
      action('post_reaction', 7), action('comment', 3), action('post', 2), action('onsite_conversion.post_save', 1)],
    action_values: [action('purchase', (daily ? 100 : 200) * (level === 'account' ? 2 : 1))],
    results: [{ indicator: 'AppointmentConfirmed', values: [
      { value: String(count), attribution_windows: ['default'] }, { value: String(count), attribution_windows: ['7d_click'] },
      { value: '0', attribution_windows: ['1d_view'] },
    ] }], conversion_values: [action('AppointmentConfirmed', count * 100)],
    video_play_actions: [action('video_view', 100)], video_continuous_2_sec_watched_actions: [action('video_view', 80)],
    video_thruplay_watched_actions: [action('video_view', 60)], video_avg_time_watched_actions: [action('video_view', 12.5)],
    video_p25_watched_actions: [action('video_view', 70)], video_p50_watched_actions: [action('video_view', 50)],
    video_p75_watched_actions: [action('video_view', 30)], video_p100_watched_actions: [action('video_view', 10)],
  }
}
function response(path: string, params: Record<string, string>): { data?: MetaRow[]; id?: string; currency?: string; timezone_name?: string } {
  if (path === '/act_123') return { id: 'act_123', currency: 'USD', timezone_name: 'America/New_York' }
  if (!path.endsWith('/insights') || params.breakdowns) return { data: [] }
  const range = JSON.parse(params.time_range)
  const current = range.since === context.range.from
  const dates = params.time_increment ? [range.since, range.until] : [range.since]
  const allIds = params.level === 'account' ? ['account'] : params.level === 'campaign' ? ['101', '102'] : params.level === 'adset' ? ['201', '202'] : ['301', '302']
  const selectedIds: string[] | null = params.filtering ? JSON.parse(params.filtering)[0].value : null
  const ids = allIds.filter(id => !selectedIds || selectedIds.includes(id))
  return { data: dates.flatMap(date => ids.map(id => row(params.level, id, date, params.time_increment ? date : range.until, Boolean(params.time_increment), current))) }
}
function assertPacket(result: ReportSection<MetaReport>, historyEntity?: Parent, detailIds: string[] = [], scope = context) {
  const packet = { context: scope, section: 'meta' as const, result, notes: [] }
  expect(() => validateReportingPacket(packet)).not.toThrow()
  expect(() => validateScopedReportingPacket(packet, makeReportingSnapshotScope('meta', scope, { historyEntity, detailIds }), scope.asOf)).not.toThrow()
}
const entity = (result: ReportSection<MetaReport>, parent: Parent) => result.data!.entities.find(item => item.level === parent.level && item.id === parent.id)!
const dailyQuery = (path: string, params: Record<string, string>, level = 'adset', period = 'current') => path.endsWith('/insights')
  && params.level === level && Boolean(params.time_increment) && JSON.parse(params.time_range).since === (period === 'current' ? context.range.from : context.comparison.from)
beforeEach(() => {
  get.mockReset(); get.mockImplementation(response)
  history.mockReset(); history.mockResolvedValue({ accountId: context.account.id, asOf: context.asOf,
    state: 'unavailable', observations: [], notes: ['Fictional assignment history unavailable.'] })
})

describe('selected parent native history', () => {
  it.each(['campaign', 'adset'] as const)('retains all %s native fields, exact lineage and independent account authority without expanding other parents', async level => {
    const parent = selection(level)
    const result = await readMetaReport(context, { historyEntity: parent })
    const selected = entity(result, parent)
    expect(Object.keys(selected.series![0].metrics).sort()).toEqual([...META_DAILY_METRIC_KEYS].sort())
    expect(selected.series!.map(point => point.date)).toEqual(['2026-09-02', '2026-09-04'])
    expect(selected.comparisonSeries!.map(point => point.date)).toEqual(['2026-08-30', '2026-09-01'])
    const metrics = selected.series![0].metrics
    expect(metrics).toMatchObject({ spend: { current: { value: 80 } }, purchase_value: { current: { value: 100 } },
      purchase_roas: { current: { value: 1.25 } }, link_clicks: { current: { value: 12 } }, average_watch_seconds: { current: { value: 12.5 } },
      engagement_rate: { current: { value: 10 }, previous: { value: 5 } }, reach: { current: { value: level === 'campaign' ? 301 : 211 } } })
    expect(metrics.purchase_roas.current.inputClaimIds).toEqual([metrics.purchase_value.current.claimId, metrics.spend.current.claimId])
    expect(metrics.purchase_roas.previous!.inputClaimIds).toEqual([metrics.purchase_value.previous!.claimId, metrics.spend.previous!.claimId])
    expect(metrics.purchase_roas.current.entity).toEqual(parent)
    expect(metrics.purchase_value.current.source.head).toBe(`meta-live:123:${context.asOf}`)
    expect(metrics.purchase_value.current.claimId).toMatch(/:daily$/)
    expect(metrics.purchase_value.previous!.window).toMatchObject({ start: '2026-08-30', end: '2026-08-30' })
    expect(selected.metrics.spend.current.value).toBe(100)
    expect(selected.series![0].metrics.spend.current.value).not.toBe(selected.metrics.spend.current.value)
    expect(result.data!.series[0].metrics.reach.current.value).toBe(777)
    expect(result.data!.series[0].metrics.bookings.current.value).toBe(2)
    const campaigns = result.data!.entities.filter(item => item.level === 'campaign')
    expect([...result.data!.series[0].metrics.bookings.current.inputClaimIds].sort()).toEqual(campaigns.map(item => item.series![0].metrics.bookings.current.claimId).sort())
    expect(selected.comparisonSeries!.every(point => Object.keys(point.metrics).length === META_DAILY_METRIC_KEYS.length)).toBe(true)
    for (const item of result.data!.entities) {
      if (item.level === 'campaign' && (parent.level !== 'campaign' || item.id !== parent.id)) expect(Object.keys(item.series![0].metrics).sort()).toEqual([...CAMPAIGN_DAILY_INPUT_KEYS].sort())
      if (item.level === 'adset' && (parent.level !== 'adset' || item.id !== parent.id)) expect(item.series).toBeUndefined()
      expect(item.breakdowns).toBeUndefined()
    }
    const queries = get.mock.calls.filter(([path]) => path.endsWith('/insights'))
    expect(queries).toHaveLength(level === 'campaign' ? 20 : 22)
    const adsetQueries = queries.filter(([, params]) => params.level === 'adset' && params.time_increment)
    expect(adsetQueries).toHaveLength(level === 'campaign' ? 0 : 2)
    for (const [, params] of adsetQueries) expect(JSON.parse(params.filtering)).toEqual([{ field: 'adset.id', operator: 'IN', value: ['201'] }])
    assertPacket(result, parent)
  })
  it.each(['campaign', 'adset'] as const)('loads one selected %s breakdown on demand and binds the native filter to that parent', async level => {
    const parent = { ...selection(level), breakdown: 'placement' as const }
    get.mockImplementation((path, params) => {
      if (!path.endsWith('/insights') || !params.breakdowns || !params.filtering) return response(path, params)
      const range = JSON.parse(params.time_range)
      const current = range.since === context.range.from
      return { data: [{ ...row(level, parent.id, range.since, range.until, false, current),
        publisher_platform: 'instagram', platform_position: 'reels' }] }
    })
    const result = await readMetaReport(context, { historyEntity: parent })
    const selected = entity(result, parent)
    expect(selected.breakdowns).toHaveLength(1)
    expect(selected.breakdowns![0]).toMatchObject({ dimension: 'placement', label: 'instagram / reels',
      metrics: { spend: { current: { value: 100 }, previous: { value: 100 } } } })
    const queries = get.mock.calls.filter(([path, params]) => path.endsWith('/insights') && params.breakdowns && params.filtering)
    expect(queries).toHaveLength(2)
    for (const [, params] of queries) {
      expect(params).toMatchObject({ level, breakdowns: 'publisher_platform,platform_position' })
      expect(JSON.parse(params.filtering)).toEqual([{ field: `${level}.id`, operator: 'IN', value: [parent.id] }])
    }
    assertPacket(result, parent)
    const changed = structuredClone(result)
    changed.data!.entities.find(item => item.level === level && item.id === parent.id)!.breakdowns![0].dimension = 'age'
    expect(() => validateScopedReportingPacket({ context, section: 'meta', result: changed, notes: [] },
      makeReportingSnapshotScope('meta', context, { historyEntity: parent }), context.asOf)).toThrow()
  })
  it('rejects an ad-set breakdown from the wrong campaign while retaining the valid comparison', async () => {
    const parent = { ...selection('adset'), breakdown: 'region' as const }
    get.mockImplementation((path, params) => {
      if (!path.endsWith('/insights') || !params.breakdowns || !params.filtering) return response(path, params)
      const range = JSON.parse(params.time_range)
      const current = range.since === context.range.from
      return { data: [{ ...row('adset', parent.id, range.since, range.until, false, current),
        campaign_id: current ? '999' : '101', region: 'Massachusetts' }] }
    })
    const result = await readMetaReport(context, { historyEntity: parent })
    const selected = entity(result, parent)
    expect(selected.breakdowns).toHaveLength(1)
    expect(selected.breakdowns![0].metrics.spend.current.value).toBeNull()
    expect(selected.breakdowns![0].metrics.spend.previous!.value).toBe(100)
    expect(result.notes.join(' ')).toMatch(/current adset region.*campaign identity.*unavailable/i)
    expect(selected.metrics.spend.current.value).toBe(100)
    assertPacket(result, parent)
  })
  it('reveals opposite daily trajectories under equal campaign period totals', async () => {
    const first = entity(await readMetaReport(context, { historyEntity: { level: 'campaign', id: '101' } }), { level: 'campaign', id: '101' })
    const second = entity(await readMetaReport(context, { historyEntity: { level: 'campaign', id: '102' } }), { level: 'campaign', id: '102' })
    expect(first.metrics.spend.current.value).toBe(second.metrics.spend.current.value)
    expect(first.series!.map(point => point.metrics.spend.current.value)).toEqual([80, 20])
    expect(second.series!.map(point => point.metrics.spend.current.value)).toEqual([20, 80])
  })
  it.each([
    ['campaign', 'current'], ['campaign', 'previous'], ['adset', 'current'], ['adset', 'previous'],
  ] as const)('retains %s %s daily-only identity without fabricating period totals or missing dates', async (level, period) => {
    const parent = selection(level)
    get.mockImplementation((path, params) => {
      if (path === '/act_123') return response(path, params)
      if (dailyQuery(path, params, level, period)) return { data: [row(level, parent.id, period === 'current' ? '2026-09-03' : '2026-08-31', period === 'current' ? '2026-09-03' : '2026-08-31', true, period === 'current')] }
      return { data: [] }
    })
    const result = await readMetaReport(context, { historyEntity: parent })
    const selected = entity(result, parent)
    expect(result.data!.entities).toHaveLength(1)
    expect(selected.metrics).toEqual({})
    expect(selected.campaignId).toBe('101')
    const points = period === 'current' ? selected.series! : selected.comparisonSeries!
    expect(points).toHaveLength(1)
    expect(points[0].metrics.purchase_value.current.value).toBe(100)
    expect(period === 'current' ? selected.comparisonSeries : selected.series).toEqual([])
    expect(result.data!.metrics.spend.current.value).toBeNull()
    assertPacket(result, parent)
  })
  it.each([
    ['campaign', 'current'], ['campaign', 'previous'], ['adset', 'current'], ['adset', 'previous'],
  ] as const)('keeps healthy evidence when %s %s daily fails', async (level, period) => {
    get.mockImplementation((path, params) => {
      if (dailyQuery(path, params, level, period)) throw new Error('Fictional private provider error')
      return response(path, params)
    })
    const parent = selection(level)
    const result = await readMetaReport(context, { historyEntity: parent })
    const selected = entity(result, parent)
    expect(period === 'current' ? selected.series : selected.comparisonSeries).toEqual([])
    expect(period === 'current' ? selected.comparisonSeries : selected.series).toHaveLength(2)
    if (period === 'previous') expect(selected.series![0].metrics.spend.previous!.value).toBeNull()
    expect(selected.metrics.spend.current.value).toBe(100)
    expect(result.data!.metrics.spend.current.value).toBe(200)
    expect(result.notes.join(' ')).toContain(`${period} ${level} daily unavailable`)
    expect(result.notes.join(' ')).not.toContain('Fictional private provider error')
    assertPacket(result, parent)
  })
  it('rejects mixed ad/parent detail before native calls', async () => {
    await expect(readMetaReport(context, { historyEntity: selection('adset'), detailIds: ['301'] })).rejects.toThrow()
    expect(get).not.toHaveBeenCalled()
  })
  it('keeps selected ad-set reads in the bounded session after the eight priority period scopes', async () => {
    let active = 0, maximum = 0
    get.mockImplementation(async (path, params) => {
      active += 1; maximum = Math.max(maximum, active)
      await Promise.resolve(); active -= 1
      return response(path, params)
    })
    const parent = selection('adset')
    const result = await readMetaReport(context, { historyEntity: parent })
    expect(maximum).toBeGreaterThan(1)
    expect(maximum).toBeLessThanOrEqual(4)
    const queries = get.mock.calls.filter(([path]) => path.endsWith('/insights'))
    expect(queries).toHaveLength(22)
    expect(queries.slice(0, 8).every(([, params]) => !params.time_increment && !params.breakdowns)).toBe(true)
    assertPacket(result, parent)
  })
  it.each(['incomplete_sibling', 'contradiction'] as const)('preserves the completed Purchase rule on selected ad-set history: %s', async mode => {
    get.mockImplementation((path, params) => {
      const result = response(path, params)
      if (path.endsWith('/insights') && !params.time_increment && !params.breakdowns
        && JSON.parse(params.time_range).since === context.range.from && ['adset', 'ad'].includes(params.level)) {
        if (mode === 'incomplete_sibling') return { data: [...result.data!, { ...result.data![0], adset_id: '203', ad_id: '303',
          actions: undefined, action_values: undefined, results: undefined, conversion_values: undefined }] }
        if (params.level === 'adset') return { data: result.data!.map(item => item.adset_id === '201'
          ? { ...item, actions: [action('purchase', 3)], action_values: [action('purchase', 300)] } : item) }
      }
      return result
    })
    const parent = selection('adset')
    const result = await readMetaReport(context, { historyEntity: parent })
    const selected = entity(result, parent)
    expect(selected.series![0].metrics.purchase_value.current.value).toBe(100)
    expect(selected.series![0].metrics.purchase_roas.current.value).toBe(mode === 'contradiction' ? null : 1.25)
    expect(selected.series![0].metrics.purchase_roas.previous!.value).toBe(1.25)
    expect(selected.comparisonSeries![0].metrics.purchase_roas.current.value).toBe(1.25)
    assertPacket(result, parent)
  })
})

describe('selected ad-set source identity and independent reads', () => {
  it.each([false, true])('keeps the recovered native parent on selected-to-base navigation, conflicting config=%s', async conflictingConfig => {
    get.mockImplementation((path, params) => {
      if (path.endsWith('/adsets') && conflictingConfig) return { data: [{ id: '201', campaign_id: '999', name: 'Conflicting setup', status: 'ACTIVE' }] }
      const result = response(path, params)
      if (path.endsWith('/insights') && params.level === 'adset' && !params.time_increment && !params.breakdowns
        && JSON.parse(params.time_range).since === context.range.from) {
        return { data: result.data!.map(item => item.adset_id === '201' ? { ...item, campaign_id: undefined } : item) }
      }
      return result
    })
    const parent = selection('adset')
    const selected = await readMetaReport(context, { historyEntity: parent })
    const preservedSelected = JSON.stringify(selected)
    expect(entity(selected, parent).campaignId).toBe('101')
    get.mockClear()
    const base = await readMetaReport(context)
    assertPacket(base)
    expect(entity(base, parent).campaignId).toBe('101')
    expect(entity(base, parent).campaignId).toBe(entity(selected, parent).campaignId)
    for (const result of [selected, base]) expect(filterEntities(result.data!.entities, new URLSearchParams({ campaign: '101' }), 'adset').map(item => item.id)).toContain('201')
    expect(entity(base, parent).series).toBeUndefined()
    const queries = get.mock.calls.filter(([path]) => path.endsWith('/insights'))
    expect(queries).toHaveLength(20)
    expect(queries.some(([, params]) => params.level === 'adset' && params.time_increment)).toBe(false)
    expect(JSON.stringify(selected)).toBe(preservedSelected)
    if (conflictingConfig) {
      expect(entity(base, parent).configurationAsOf).toBeNull()
      expect(entity(base, parent).status).toBe('UNKNOWN')
    }
  })
  it.each(['prior_native', 'conflicting_config', 'daily_only_native'] as const)('recovers an omitted current campaign ID from coherent supplied evidence: %s', async mode => {
    get.mockImplementation((path, params) => {
      if (path.endsWith('/adsets') && mode === 'conflicting_config') return { data: [{ id: '201', campaign_id: '999', name: 'Conflicting setup', status: 'ACTIVE' }] }
      const result = response(path, params)
      if (path.endsWith('/insights') && params.level === 'adset' && !params.time_increment && !params.breakdowns
        && (mode === 'daily_only_native' || JSON.parse(params.time_range).since === context.range.from)) {
        return { data: result.data!.map(item => item.adset_id === '201' ? { ...item, campaign_id: undefined } : item) }
      }
      return result
    })
    const parent = selection('adset')
    const result = await readMetaReport(context, { historyEntity: parent })
    const selected = entity(result, parent)
    assertPacket(result, parent)
    expect(selected.metrics.spend.current.value).toBe(100)
    expect(selected.series).toHaveLength(2)
    expect(selected.comparisonSeries).toHaveLength(2)
    expect(selected.campaignId).toBe('101')
    expect(result.data!.entities.filter(item => item.level === 'adset' && item.campaignId === '101').map(item => item.id)).toContain('201')
    if (mode === 'conflicting_config') {
      expect(selected.configurationAsOf).toBeNull()
      expect(selected.status).toBe('UNKNOWN')
      expect(selected.audience).toBe('unknown')
    }
  })
  it('does not invent a parent when missing period identities leave conflicting daily parents', async () => {
    get.mockImplementation((path, params) => {
      const result = response(path, params)
      if (path.endsWith('/insights') && params.level === 'adset' && !params.breakdowns) {
        return { data: result.data!.map(item => item.adset_id !== '201' ? item : { ...item,
          campaign_id: !params.time_increment ? undefined : JSON.parse(params.time_range).since === context.range.from ? '101' : '999' }) }
      }
      return result
    })
    const parent = selection('adset')
    const result = await readMetaReport(context, { historyEntity: parent })
    const selected = entity(result, parent)
    expect(selected.campaignId).toBeNull()
    expect(selected.series).toEqual([])
    expect(selected.comparisonSeries).toEqual([])
    expect(selected.metrics.spend.current.value).toBe(100)
    assertPacket(result, parent)
    const base = await readMetaReport(context)
    expect(entity(base, parent).campaignId).toBeNull()
    expect(filterEntities(base.data!.entities, new URLSearchParams({ campaign: '101' }), 'adset').map(item => item.id)).not.toContain('201')
    expect(entity(base, parent).metrics.spend.current.value).toBe(100)
    assertPacket(base)
  })
  it.each(['wrong_id', 'missing_id', 'wrong_account', 'wrong_date', 'duplicate', 'missing_campaign', 'wrong_campaign', 'changing_campaign'] as const)('rejects %s without attaching invalid history or losing healthy period/prior observations', async mode => {
    get.mockImplementation((path, params) => {
      const result = response(path, params)
      if (!dailyQuery(path, params)) return result
      const rows = result.data!
      if (mode === 'wrong_id') return { data: rows.map(item => ({ ...item, adset_id: '202' })) }
      if (mode === 'missing_id') return { data: rows.map(item => ({ ...item, adset_id: undefined })) }
      if (mode === 'wrong_account') return { data: rows.map(item => ({ ...item, account_id: '999' })) }
      if (mode === 'wrong_date') return { data: rows.map(item => ({ ...item, date_stop: '2026-09-05' })) }
      if (mode === 'duplicate') return { data: [...rows, rows[0]] }
      if (mode === 'missing_campaign') return { data: rows.map(item => ({ ...item, campaign_id: undefined })) }
      if (mode === 'wrong_campaign') return { data: rows.map(item => ({ ...item, campaign_id: '999' })) }
      return { data: rows.map((item, index) => ({ ...item, campaign_id: index ? '999' : '101' })) }
    })
    const parent = selection('adset')
    const result = await readMetaReport(context, { historyEntity: parent })
    const selected = entity(result, parent)
    expect(selected.series).toEqual([])
    expect(selected.comparisonSeries).toHaveLength(2)
    expect(selected.metrics.spend.current.value).toBe(100)
    expect(selected.campaignId).toBe('101')
    expect(entity(result, { level: 'adset', id: '202' }).series).toBeUndefined()
    expect(result.notes.join(' ')).toMatch(/current adset daily.*(unavailable|identity)/)
    assertPacket(result, parent)
  })
  it('retains native cursor pagination on the exact selected ad-set scope', async () => {
    get.mockImplementation((path, params) => {
      const result = response(path, params)
      if (!dailyQuery(path, params)) return result
      return params.after ? { data: [result.data![1]] } : { data: [result.data![0]], paging: { next: 'https://untrusted.invalid/other-account', cursors: { after: 'second' } } }
    })
    const parent = selection('adset')
    const result = await readMetaReport(context, { historyEntity: parent })
    expect(entity(result, parent).series).toHaveLength(2)
    const queries = get.mock.calls.filter(([path, params]) => dailyQuery(path, params))
    expect(queries).toHaveLength(2)
    expect(queries[1][0]).toBe('/act_123/insights')
    expect(queries[1][1]).toEqual({ ...queries[0][1], after: 'second' })
    assertPacket(result, parent)
  })
  it('retains delivery and Purchase when one selected ad-set watch field is rejected', async () => {
    get.mockImplementation((path, params) => {
      if (dailyQuery(path, params) && params.fields.split(',').includes('video_avg_time_watched_actions')) throw Object.assign(new Error('Invalid field video_avg_time_watched_actions'), { code: 100 })
      const result = response(path, params)
      return dailyQuery(path, params) ? { data: result.data!.map(item => ({ ...item, video_avg_time_watched_actions: undefined })) } : result
    })
    const parent = selection('adset')
    const result = await readMetaReport(context, { historyEntity: parent })
    const metrics = entity(result, parent).series![0].metrics
    expect(metrics.average_watch_seconds.current.value).toBeNull()
    expect(metrics.average_watch_seconds.previous!.value).toBe(12.5)
    expect(metrics.spend.current.value).toBe(80)
    expect(metrics.purchase_roas.current.value).toBe(1.25)
    assertPacket(result, parent)
  })
  it('keeps a measured zero distinct from invalid own spend and missing Purchase value', async () => {
    get.mockImplementation((path, params) => {
      const result = response(path, params)
      if (!dailyQuery(path, params)) return result
      return { data: result.data!.map((item, index) => index ? { ...item, action_values: [action('purchase', 0)] }
        : { ...item, spend: '-1', video_avg_time_watched_actions: [action('video_view', -1)], action_values: undefined }) }
    })
    const parent = selection('adset')
    const result = await readMetaReport(context, { historyEntity: parent })
    const [invalid, zero] = entity(result, parent).series!
    expect(invalid.metrics.spend.current.value).toBeNull()
    expect(invalid.metrics.purchase_value.current.value).toBeNull()
    expect(invalid.metrics.purchase_roas.current.value).toBeNull()
    expect(invalid.metrics.average_watch_seconds.current.value).toBeNull()
    expect(invalid.metrics.impressions.current.value).toBe(1000)
    expect(zero.metrics.purchase_roas.current.value).toBe(0)
    expect(zero.metrics.purchase_roas.current.availability.state).toBe('available')
    assertPacket(result, parent)
  })
})

describe('parent history scope and legacy compatibility', () => {
  it.each(['campaign', 'adset'] as const)('accepts only the exact selected %s daily scope and native catalog', async level => {
    const parent = selection(level)
    const result = await readMetaReport(context, { historyEntity: parent })
    assertPacket(result, parent)
    const scope = makeReportingSnapshotScope('meta', context, { historyEntity: parent })
    const mutations: Array<(report: MetaReport) => void> = [
      report => { report.entities.find(item => item.level === level && item.id === parent.id)!.breakdowns = [] },
      report => { report.entities.find(item => item.level === level && item.id === parent.id)!.series = undefined },
      report => { report.entities.find(item => item.level === 'ad')!.series = [] },
      report => { const selected = report.entities.find(item => item.level === level && item.id === parent.id)!; selected.series![0].metrics.impostor = selected.series![0].metrics.spend },
      report => { const selected = report.entities.find(item => item.level === level && item.id === parent.id)!; selected.series![0].metrics.spend.current.entity = { level: 'account', id: context.account.id } },
    ]
    for (const mutate of mutations) {
      const changed = structuredClone(result); mutate(changed.data!)
      expect(() => validateScopedReportingPacket({ context, section: 'meta', result: changed, notes: [] }, scope, context.asOf)).toThrow()
    }
    expect(() => validateScopedReportingPacket({ context, section: 'meta', result, notes: [] }, makeReportingSnapshotScope('meta', context, {
      historyEntity: { ...parent, id: level === 'campaign' ? '102' : '202' },
    }), context.asOf)).toThrow()
  })
  it('keeps original four-input campaign and absent ad-set history packets valid without retroactive expansion', async () => {
    const result = await readMetaReport(context)
    const before = JSON.stringify(result)
    for (const campaign of result.data!.entities.filter(item => item.level === 'campaign')) {
      expect(Object.keys(campaign.series![0].metrics).sort()).toEqual([...CAMPAIGN_DAILY_INPUT_KEYS].sort())
    }
    expect(result.data!.entities.filter(item => item.level === 'adset').every(item => item.series === undefined)).toBe(true)
    assertPacket(result)
    expect(JSON.stringify(result)).toBe(before)
    expect(get.mock.calls.filter(([path]) => path.endsWith('/insights'))).toHaveLength(20)
  })
  it('does not rebind a legacy four-input campaign packet as a fulfilled full-history selection', async () => {
    const result = await readMetaReport(context)
    assertPacket(result)
    expect(() => validateScopedReportingPacket({ context, section: 'meta', result, notes: [] },
      makeReportingSnapshotScope('meta', context, { historyEntity: selection('campaign') }), context.asOf)).toThrow()
  })
  it('does not fabricate a missing selected parent', async () => {
    const parent: Parent = { level: 'adset', id: '999' }
    const result = await readMetaReport(context, { historyEntity: parent })
    expect(result.data!.entities.some(item => item.id === '999')).toBe(false)
    assertPacket(result, parent)
  })
  it('keeps a selected 12-campaign/28-day packet under the unchanged cap with every authority input', async () => {
    const scope = { ...context, range: { from: '2026-08-05', to: '2026-09-01' }, comparison: { from: '2026-07-08', to: '2026-08-04' } }
    get.mockImplementation((path, params) => {
      if (!path.endsWith('/insights') || params.breakdowns) return response(path, params)
      const range = JSON.parse(params.time_range)
      const dates = Array.from({ length: params.time_increment ? 28 : 1 }, (_, index) => dayOffset(range.since, index))
      if (params.level === 'campaign') return { data: dates.flatMap(date => Array.from({ length: 12 }, (_, index) => ({
        ...row('campaign', '101', date, params.time_increment ? date : range.until, Boolean(params.time_increment), true), campaign_id: String(101 + index),
      }))) }
      if (params.level === 'account') return { data: dates.map(date => row('account', 'account', date, params.time_increment ? date : range.until, Boolean(params.time_increment), true)) }
      return { data: [] }
    })
    const parent = selection('campaign')
    const result = await readMetaReport(scope, { historyEntity: parent })
    const campaigns = result.data!.entities.filter(item => item.level === 'campaign')
    expect(campaigns).toHaveLength(12)
    expect(campaigns.every(item => item.series?.length === 28 && item.comparisonSeries?.length === 28)).toBe(true)
    expect(Object.keys(entity(result, parent).series![0].metrics)).toHaveLength(META_DAILY_METRIC_KEYS.length)
    expect(result.data!.series.every(point => point.metrics.bookings.current.inputClaimIds.length === 12)).toBe(true)
    expect(Buffer.byteLength(JSON.stringify({ context: scope, section: 'meta', result, notes: [] }))).toBeLessThan(64 * 1024 * 1024)
    assertPacket(result, parent, [], scope)
  }, STRESS_TEST_TIMEOUT_MS)
})
