import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readMetaReport } from '@/lib/platforms/meta/reporting/meta-reader'
import { collectReportExportRows } from '@/components/reporting/ReportsReport'
import { adDailyExportRows } from '@/lib/reporting/trend'
import { validateReportingPacket } from '@/lib/reporting/validation'
import { validateScopedReportingPacket } from '@/lib/reporting/packet-scope'
import { makeReportingSnapshotScope } from '@/lib/reporting/snapshot-scope'
import { META_DAILY_METRIC_KEYS } from '@/lib/reporting/meta-breakdowns'
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
  account: { id: '00000000-0000-4000-8000-000000001311', metaAccountId: '123', name: 'Fictional account' },
  range: { from: '2026-09-02', to: '2026-09-04' }, comparison: { from: '2026-08-30', to: '2026-09-01' },
  timezone: 'America/New_York', currency: 'USD', asOf: '2026-09-05T16:00:00Z',
}
function outcome(count: number, value: number) {
  return { results: [{ indicator: 'AppointmentConfirmed', values: [
    { value: String(count), attribution_windows: ['default'] },
    { value: String(count), attribution_windows: ['7d_click'] },
    { value: '0', attribution_windows: ['1d_view'] },
  ] }], conversion_values: [{ action_type: 'AppointmentConfirmed', value: String(value) }] }
}
function row(date: string, count = 2): MetaRow {
  return { date_start: date, date_stop: date, account_id: '123', campaign_id: '101', campaign_name: 'Campaign',
    adset_id: '201', adset_name: 'Set', ad_id: '301', ad_name: 'Ad', spend: '100', impressions: '1000', reach: '800', frequency: '1.25',
    actions: [{ action_type: 'purchase', value: '3' }, { action_type: 'post_engagement', value: '100' }],
    action_values: [{ action_type: 'purchase', value: '300' }], outbound_clicks: [{ action_type: 'outbound_click', value: '20' }],
    ...outcome(count, count * 100) }
}
function response(path: string, params: Record<string, string>) {
  if (path === '/act_123') return { id: 'act_123', currency: 'USD', timezone_name: 'America/New_York' }
  if (!path.endsWith('/insights')) return { data: [] }
  const range = JSON.parse(params.time_range)
  const base = { ...row(range.since, range.since === context.range.from ? 2 : 1), date_stop: params.time_increment ? range.since : range.until }
  if (params.breakdowns) return { data: [] }
  return { data: [{ ...base, ...(params.level === 'account' ? outcome(0, 0) : {}) }] }
}
const packet = (result: ReportSection<MetaReport>, scope = context) => ({ context: scope, section: 'meta' as const, result, notes: [] })
function assertPacket(result: ReportSection<MetaReport>, detailIds: string[] = [], scope = context) {
  expect(() => validateReportingPacket(packet(result, scope))).not.toThrow()
  expect(() => validateScopedReportingPacket(packet(result, scope), makeReportingSnapshotScope('meta', scope, { detailIds }), scope.asOf)).not.toThrow()
}
beforeEach(() => {
  get.mockReset(); get.mockImplementation(response)
  history.mockReset(); history.mockImplementation(async (scope: ReportingContext) => ({ accountId: scope.account.id,
    asOf: scope.asOf, state: 'unavailable', observations: [], notes: ['Fictional history unavailable.'] }))
})

describe('native daily campaign authority and independent delivery', () => {
  it.each([0, null])('uses campaign day 2 when native account day is %s, with exact current/prior input lineage', async native => {
    get.mockImplementation((path, params) => {
      const result = response(path, params)
      if (path.endsWith('/insights') && params.level === 'account' && params.time_increment) {
        return { data: result.data!.map(item => ({ ...item, results: native === null ? undefined : outcome(native, 0).results })) }
      }
      return result
    })
    const result = await readMetaReport(context)
    const report = result.data!
    expect(report.metrics.bookings.current.value).toBe(2)
    expect(report.series[0].metrics.bookings.current.value).toBe(2)
    expect(report.series[0].metrics.bookings.previous?.value).toBe(1)
    expect(report.series[0].metrics.appointment_value.current.value).toBe(200)
    expect(report.series[0].metrics.cost_per_booking.current.value).toBe(50)
    expect(report.series[0].metrics.appointment_roas.current.value).toBe(2)
    const campaign = report.entities.find(entity => entity.level === 'campaign')!
    expect(Object.keys(campaign.series![0].metrics).sort()).toEqual(['appointment_value', 'bookings', 'bookings_click', 'bookings_view'])
    const booking = report.series[0].metrics.bookings
    expect(booking.current.inputClaimIds).toEqual([campaign.series![0].metrics.bookings.current.claimId])
    expect(booking.previous?.inputClaimIds).toEqual([campaign.comparisonSeries![0].metrics.bookings.current.claimId])
    expect(booking.current.source.head).toBe(`meta-campaign-daily-authority:123:${context.asOf}`)
    expect(booking.current.claimId).toMatch(/:campaign-daily-canonical$/)
    expect(booking.previous?.window).toMatchObject({ start: '2026-08-30', end: '2026-08-30', basis: 'impression_date_et' })
    expect(campaign.series![0].metrics.bookings.current.source.head).toBe(`meta-live:123:${context.asOf}`)
    expect(campaign.comparisonSeries![0].metrics.bookings.previous).toBeNull()
    assertPacket(result)
  })
  it.each(['failed', 'empty', 'wrong_day', 'duplicate', 'foreign_account', 'missing_field'])('withholds only unsupported canonical fields on a %s current campaign-day read', async mode => {
    get.mockImplementation((path, params) => {
      const result = response(path, params)
      if (path.endsWith('/insights') && params.level === 'campaign' && params.time_increment && JSON.parse(params.time_range).since === context.range.from) {
        if (mode === 'failed') throw new Error('Fictional unavailable query')
        if (mode === 'empty') return { data: [] }
        const item = result.data![0]
        if (mode === 'wrong_day') return { data: [{ ...item, date_stop: '2026-09-03' }] }
        if (mode === 'duplicate') return { data: [item, item] }
        if (mode === 'foreign_account') return { data: [{ ...item, account_id: '999' }] }
        return { data: [{ ...item, results: undefined }] }
      }
      return result
    })
    const result = await readMetaReport(context)
    const metrics = result.data!.series[0].metrics
    expect(result.data!.metrics.bookings.current.value).toBe(2)
    expect(metrics.bookings.current.value).toBeNull()
    expect(metrics.bookings.current.coverage.state).toBe('unknown')
    expect(metrics.bookings.previous?.value).toBe(1)
    expect(metrics.spend.current.value).toBe(100)
    expect(metrics.purchase_count.current.value).toBe(3)
    expect(metrics.purchase_value.current.value).toBe(300)
    expect(metrics.purchase_roas.current.value).toBe(3)
    if (mode === 'missing_field') expect(metrics.appointment_value.current.value).toBe(200)
    assertPacket(result)
  })
  it('keeps campaign-only and prior-only dates without inventing absent-day delivery', async () => {
    get.mockImplementation((path, params) => {
      if (path.endsWith('/insights') && params.level === 'campaign' && params.time_increment) {
        const current = JSON.parse(params.time_range).since === context.range.from
        return { data: current ? [row('2026-09-03', 2)] : [row('2026-08-31', 1), { ...row('2026-09-01', 0), campaign_id: '102', campaign_name: 'Prior-only campaign' }] }
      }
      return response(path, params)
    })
    const result = await readMetaReport(context)
    expect(result.data!.series.map(point => point.date)).toEqual(['2026-09-02', '2026-09-03'])
    expect(result.data!.comparisonSeries.map(point => point.date)).toEqual(['2026-08-30', '2026-08-31', '2026-09-01'])
    const missing = result.data!.series[0].metrics
    expect(missing.bookings.current.value).toBeNull()
    expect(missing.spend.current.value).toBe(100)
    const campaignOnly = result.data!.series[1].metrics
    expect(campaignOnly.bookings.current.value).toBe(2)
    expect(campaignOnly.bookings.previous?.value).toBe(1)
    expect(campaignOnly.appointment_value.current.value).toBe(200)
    expect(campaignOnly.spend.current.value).toBeNull()
    expect(campaignOnly.cost_per_booking.current.value).toBeNull()
    expect(campaignOnly.appointment_roas.current.value).toBeNull()
    expect(result.data!.entities.find(entity => entity.id === '102')?.comparisonSeries?.[0].metrics.bookings.current.value).toBe(0)
    expect(result.data!.comparisonSeries[2].metrics.bookings.current.value).toBe(0)
    assertPacket(result)
  })
  it('retains native Purchase and response inputs for account and selected-ad daily queries', async () => {
    const result = await readMetaReport(context, { detailIds: ['301'] })
    const ad = result.data!.entities.find(entity => entity.level === 'ad')!
    for (const metrics of [result.data!.series[0].metrics, ad.series![0].metrics]) {
      expect(metrics.purchase_count.current.value).toBe(3)
      expect(metrics.purchase_value.current.value).toBe(300)
      expect(metrics.purchase_roas.current.value).toBe(3)
      expect(metrics.purchase_roas.current.inputClaimIds).toEqual([metrics.purchase_value.current.claimId, metrics.spend.current.claimId])
      expect(metrics.purchase_roas.previous?.inputClaimIds).toEqual([metrics.purchase_value.previous?.claimId, metrics.spend.previous?.claimId])
      expect(metrics.engagement_rate.current.value).toBe(10)
      expect(metrics.engagement_rate.current.inputClaimIds).toEqual([metrics.engagements.current.claimId, metrics.impressions.current.claimId])
      expect(metrics.impressions.current.value).toBe(1000)
      expect(metrics.reach.current.value).toBe(800)
      expect(metrics.frequency.current.value).toBe(1.25)
      expect(metrics.purchase_count.current.source.head).toBe(`meta-live:123:${context.asOf}`)
    }
    assertPacket(result, ['301'])
  })
  it.each([
    ['link_clicks', { inline_link_clicks: '12' }, 12],
    ['average_watch_seconds', { video_avg_time_watched_actions: [{ action_type: 'video_view', value: '12.5' }] }, 12.5],
  ] as const)('does not drop native daily %s', async (key, fields, value) => {
    get.mockImplementation((path, params) => {
      const result = response(path, params)
      return path.endsWith('/insights') && params.time_increment ? { data: result.data!.map(item => ({ ...item, ...fields })) } : result
    })
    const result = await readMetaReport(context, { detailIds: ['301'] })
    expect(result.data!.series[0].metrics[key]?.current.value).toBe(value)
    expect(result.data!.entities.find(entity => entity.level === 'ad')!.series![0].metrics[key]?.current.value).toBe(value)
    assertPacket(result, ['301'])
  })
  it('retains every parsed daily click and watch field, native fractions and exported current/prior input claims', async () => {
    get.mockImplementation((path, params) => {
      const result = response(path, params)
      if (!path.endsWith('/insights') || !params.time_increment) return result
      const current = JSON.parse(params.time_range).since === context.range.from
      return { data: result.data!.map((item: MetaRow) => ({ ...item, clicks: current ? '24' : '12', inline_link_clicks: current ? '12' : '6',
        actions: [...item.actions as object[], { action_type: 'landing_page_view', value: '8' }],
        video_play_actions: [{ action_type: 'video_view', value: '100' }],
        video_continuous_2_sec_watched_actions: [{ action_type: 'video_view', value: '80' }],
        video_thruplay_watched_actions: [{ action_type: 'video_view', value: '45' }],
        video_p25_watched_actions: [{ action_type: 'video_view', value: '60' }],
        video_p50_watched_actions: [{ action_type: 'video_view', value: '40' }],
        video_p75_watched_actions: [{ action_type: 'video_view', value: '20' }],
        video_p100_watched_actions: [{ action_type: 'video_view', value: '10' }],
        video_avg_time_watched_actions: [{ action_type: 'video_view', value: current ? '12.5' : '6.25' }],
      })) }
    })
    const result = await readMetaReport(context, { detailIds: ['301'] })
    const ad = result.data!.entities.find(entity => entity.level === 'ad')!
    const expected: Record<string, number> = { clicks: 24, ctr: 2.4, cpc: 100 / 24, link_clicks: 12, link_ctr: 1.2,
      link_cpc: 100 / 12, outbound_cpc: 5, cost_per_lpv: 12.5, video_plays: 100, average_watch_seconds: 12.5,
      watch_p25: 60, watch_p50: 40, watch_p75: 20, watch_p100: 10, retention_p25: 60, retention_p50: 40, retention_p75: 20, retention_p100: 10 }
    const missing = { state: 'unavailable' as const, data: null, asOf: null, notes: ['Fictional source not supplied.'] }
    const exported = collectReportExportRows({ context, meta: result, business: missing, website: missing, measurement: missing }, 'results')
    for (const metrics of [result.data!.series[0].metrics, ad.series![0].metrics]) {
      for (const [key, value] of Object.entries(expected)) {
        expect(metrics[key], `${key} was supplied by the native daily query`).toBeDefined()
        expect(metrics[key].current.value).toBeCloseTo(value, 10)
        const csv = exported.find(item => item.claim_id === metrics[key].current.claimId)!
        expect(csv, `${key} remains in Results daily export`).toBeDefined()
        expect(csv.value).toBeCloseTo(value, 10)
        expect(csv.input_claim_ids).toBe(JSON.stringify(metrics[key].current.inputClaimIds))
        expect(csv.previous_input_claim_ids).toBe(JSON.stringify(metrics[key].previous?.inputClaimIds))
        expect(csv.previous_claim_id).toBe(metrics[key].previous?.claimId)
      }
      expect(metrics.link_clicks.previous?.value).toBe(6)
      expect(metrics.average_watch_seconds.previous?.value).toBe(6.25)
      expect(metrics.average_watch_seconds.current.unit).toBe('seconds')
      expect(metrics.link_ctr.current.inputClaimIds).toEqual([metrics.link_clicks.current.claimId, metrics.impressions.current.claimId])
      expect(metrics.retention_p50.current.inputClaimIds).toEqual([metrics.watch_p50.current.claimId, metrics.video_plays.current.claimId])
      expect(Object.keys(metrics)).toHaveLength(META_DAILY_METRIC_KEYS.length)
    }
    const adExport = adDailyExportRows(ad, context)
    expect(adExport.find(item => item.claim_id === ad.series![0].metrics.average_watch_seconds.current.claimId)).toMatchObject({ value: 12.5, previous_value: 6.25, unit: 'seconds' })
    expect(adExport.find(item => item.claim_id === ad.comparisonSeries![0].metrics.link_clicks.current.claimId)).toMatchObject({ value: 6, previous_value: null })
    expect(Object.keys(result.data!.entities.find(entity => entity.level === 'campaign')!.series![0].metrics)).toHaveLength(4)
    assertPacket(result, ['301'])
  })
  it('keeps day query observations distinct from one-day period observations', async () => {
    const scope = { ...context, range: { from: '2026-09-02', to: '2026-09-02' }, comparison: { from: '2026-09-01', to: '2026-09-01' } }
    get.mockImplementation((path, params) => {
      const result = response(path, params)
      if (path.endsWith('/insights') && params.level === 'campaign' && params.time_increment) return { data: result.data!.map(item => ({ ...item, ...outcome(1, 100) })) }
      return result
    })
    const result = await readMetaReport(scope)
    expect(result.data!.metrics.bookings.current.value).toBe(2)
    expect(result.data!.series[0].metrics.bookings.current.value).toBe(1)
    expect(result.data!.series[0].metrics.bookings.current.claimId).not.toBe(result.data!.metrics.bookings.current.claimId)
    assertPacket(result, [], scope)
  })
  it('uses fixed-path native pagination for complete campaign-day reads', async () => {
    get.mockImplementation((path, params) => {
      if (path.endsWith('/insights') && params.level === 'campaign' && params.time_increment && JSON.parse(params.time_range).since === context.range.from) {
        if (!params.after) return { data: [row('2026-09-02', 1)], paging: { next: 'https://untrusted.invalid/redirect', cursors: { after: 'next' } } }
        return { data: [{ ...row('2026-09-02', 1), campaign_id: '102' }] }
      }
      return response(path, params)
    })
    const result = await readMetaReport(context)
    expect(result.data!.series[0].metrics.bookings.current.value).toBe(2)
    expect(result.data!.series[0].metrics.bookings.current.inputClaimIds).toHaveLength(2)
    expect(get.mock.calls.every(([path]) => !path.startsWith('https:'))).toBe(true)
    const pages = get.mock.calls.filter(([path, params]) => path.endsWith('/insights') && params.level === 'campaign' && params.time_increment && JSON.parse(params.time_range).since === context.range.from)
    expect(pages).toHaveLength(2)
    expect(pages[1][1]).toMatchObject({ after: 'next', time_increment: '1', level: 'campaign', action_report_time: 'impression', limit: '500' })
    assertPacket(result)
  })
  it('preserves a valid current day when prior campaign days fail', async () => {
    get.mockImplementation((path, params) => {
      if (path.endsWith('/insights') && params.level === 'campaign' && params.time_increment
        && JSON.parse(params.time_range).since === context.comparison.from) throw new Error('Fictional prior failure')
      return response(path, params)
    })
    const result = await readMetaReport(context)
    const metrics = result.data!.series[0].metrics
    expect(metrics.bookings.current.value).toBe(2)
    expect(metrics.bookings.previous?.value).toBeNull()
    expect(metrics.bookings.previous?.inputClaimIds).toEqual([])
    expect(metrics.purchase_count.previous?.value).toBe(3)
    expect(result.data!.comparisonSeries[0].metrics.bookings.current.value).toBeNull()
    assertPacket(result)
  })
  it('never publishes a first page as complete when campaign pagination repeats its cursor', async () => {
    get.mockImplementation((path, params) => {
      if (path.endsWith('/insights') && params.level === 'campaign' && params.time_increment
        && JSON.parse(params.time_range).since === context.range.from) {
        return { data: [row('2026-09-02', 9)], paging: { next: 'https://untrusted.invalid', cursors: { after: 'same' } } }
      }
      return response(path, params)
    })
    const result = await readMetaReport(context)
    expect(result.data!.series[0].metrics.bookings.current.value).toBeNull()
    expect(result.data!.series[0].metrics.purchase_count.current.value).toBe(3)
    expect(result.notes.join(' ')).toContain('current campaign daily unavailable')
    assertPacket(result)
  })
  it('retains measured zero and field-local qualifications without inferring omitted outcomes', async () => {
    get.mockImplementation((path, params) => {
      const result = response(path, params)
      if (path.endsWith('/insights') && params.level === 'campaign' && params.time_increment) {
        return { data: result.data!.map(item => ({ ...item, ...outcome(0, 0) })) }
      }
      return result
    })
    const result = await readMetaReport(context)
    const metrics = result.data!.series[0].metrics
    expect(metrics.bookings.current.value).toBe(0)
    expect(metrics.bookings.current.availability.state).toBe('available')
    expect(metrics.appointment_value.current.value).toBe(0)
    expect(metrics.appointment_roas.current.value).toBe(0)
    expect(metrics.cost_per_booking.current.value).toBeNull()
    expect(metrics.bookings.current.maturity).toEqual(result.data!.entities.find(entity => entity.level === 'campaign')!.series![0].metrics.bookings.current.maturity)
    assertPacket(result)
  })
  it('does not silently sum only valid campaign fields when another returned campaign is incomplete', async () => {
    get.mockImplementation((path, params) => {
      const result = response(path, params)
      if (path.endsWith('/insights') && params.level === 'campaign' && params.time_increment) {
        return { data: [...result.data!, { ...result.data![0], campaign_id: '102', results: undefined }] }
      }
      return result
    })
    const result = await readMetaReport(context)
    const metrics = result.data!.series[0].metrics
    expect(metrics.bookings.current.value).toBeNull()
    expect(metrics.bookings.current.inputClaimIds).toHaveLength(2)
    expect(metrics.appointment_value.current.value).toBe(400)
    expect(metrics.appointment_roas.current.value).toBe(4)
    expect(metrics.purchase_value.current.value).toBe(300)
    assertPacket(result)
  })
  it('retains every campaign-day input in a 12-campaign, 28-day packet below the existing save cap', async () => {
    const scope = { ...context, range: { from: '2026-08-05', to: '2026-09-01' }, comparison: { from: '2026-07-08', to: '2026-08-04' } }
    get.mockImplementation((path, params) => {
      if (!path.endsWith('/insights') || params.breakdowns) return response(path, params)
      const range = JSON.parse(params.time_range)
      const dates = Array.from({ length: params.time_increment ? 28 : 1 }, (_, index) => new Date(Date.parse(range.since) + index * 86_400_000).toISOString().slice(0, 10))
      if (params.level === 'campaign') return { data: dates.flatMap(date => Array.from({ length: 12 }, (_, index) => ({
        ...row(date, params.time_increment ? 1 : 28), campaign_id: String(101 + index), date_stop: params.time_increment ? date : range.until,
      }))) }
      if (params.level === 'account') return { data: dates.map(date => ({ ...row(date, 0), spend: params.time_increment ? '1200' : '33600', date_stop: params.time_increment ? date : range.until })) }
      return response(path, params)
    })
    const result = await readMetaReport(scope)
    expect(result.data!.series).toHaveLength(28)
    expect(result.data!.comparisonSeries).toHaveLength(28)
    const campaigns = result.data!.entities.filter(entity => entity.level === 'campaign')
    expect(campaigns).toHaveLength(12)
    expect(campaigns.every(entity => entity.series?.length === 28 && entity.comparisonSeries?.length === 28)).toBe(true)
    expect(result.data!.series.every(point => point.metrics.bookings.current.value === 12 && point.metrics.bookings.current.inputClaimIds.length === 12)).toBe(true)
    const bytes = Buffer.byteLength(JSON.stringify(packet(result, scope)))
    expect(bytes).toBeLessThan(64 * 1024 * 1024)
    assertPacket(result, [], scope)
  }, STRESS_TEST_TIMEOUT_MS)
  it.each([
    ['current', false], ['current', true], ['previous', false], ['previous', true],
  ] as const)('keeps a selected-ad %s daily-only population with account daily %s', async (period, accountDaily) => {
    const from = period === 'current' ? context.range.from : context.comparison.from
    const date = period === 'current' ? '2026-09-03' : '2026-08-31'
    get.mockImplementation((path, params) => {
      if (path === '/act_123') return { id: 'act_123', currency: 'USD', timezone_name: 'America/New_York' }
      if (path.endsWith('/insights') && params.time_increment && JSON.parse(params.time_range).since === from) {
        if (params.level === 'ad') return { data: [{ ...row(date, 7), ad_name: 'Daily-only selected ad' }] }
        if (accountDaily && params.level === 'account') return { data: [row(date, 0)] }
      }
      return { data: [] }
    })
    const result = await readMetaReport(context, { detailIds: ['301'] })
    expect(result.data).not.toBeNull()
    expect(result.state).toBe('partial')
    expect(result.data!.entities).toHaveLength(1)
    const ad = result.data!.entities[0]
    expect(ad).toMatchObject({ id: '301', level: 'ad', name: 'Daily-only selected ad', campaignId: '101', adsetId: '201', metrics: {}, creative: null })
    const points = period === 'current' ? ad.series! : ad.comparisonSeries!
    expect(points).toHaveLength(1)
    expect(points[0].date).toBe(date)
    expect(points[0].metrics.bookings.current.value).toBe(7)
    expect(points[0].metrics.spend.current.value).toBe(100)
    expect(points[0].metrics.purchase_count.current.value).toBe(3)
    expect((period === 'current' ? ad.comparisonSeries : ad.series)).toEqual([])
    const queries = get.mock.calls.filter(([path, params]) => path.endsWith('/insights') && params.level === 'ad' && params.time_increment)
    expect(queries).toHaveLength(2)
    expect(queries.every(([, params]) => JSON.parse(params.filtering)[0].value.join(',') === '301')).toBe(true)
    expect(result.data!.entities.some(entity => entity.id === '302')).toBe(false)
    assertPacket(result, ['301'])
  })
  it('rejects an unrequested daily-only ad without creating a synthetic selected entity', async () => {
    get.mockImplementation((path, params) => {
      if (path === '/act_123') return { id: 'act_123', currency: 'USD', timezone_name: 'America/New_York' }
      if (path.endsWith('/insights') && params.level === 'ad' && params.time_increment) {
        return { data: [{ ...row(JSON.parse(params.time_range).since), ad_id: '302' }] }
      }
      if (path.endsWith('/insights') && params.level === 'account' && params.time_increment) return response(path, params)
      return { data: [] }
    })
    const result = await readMetaReport(context, { detailIds: ['301'] })
    expect(result.data!.entities).toEqual([])
    expect(result.data!.series[0].metrics.spend.current.value).toBe(100)
    expect(result.notes.join(' ')).toContain('ad daily unavailable')
    assertPacket(result, ['301'])
  })
  it('permits only campaign authority input series and preserves ad-detail isolation', async () => {
    const result = await readMetaReport(context)
    assertPacket(result)
    for (const mutate of [
      (report: MetaReport) => { report.entities.find(entity => entity.level === 'campaign')!.breakdowns = [] },
      (report: MetaReport) => { report.entities.find(entity => entity.level === 'ad')!.series = [] },
      (report: MetaReport) => { report.entities.find(entity => entity.level === 'adset')!.series = [] },
    ]) {
      const changed = structuredClone(result)
      mutate(changed.data!)
      expect(() => validateScopedReportingPacket(packet(changed), makeReportingSnapshotScope('meta', context), context.asOf)).toThrow()
    }
  })
})
