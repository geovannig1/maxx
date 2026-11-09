import { describe, expect, it } from 'vitest'
import { buildMetaBreakdowns, buildMetaSeries, META_DAILY_METRIC_KEYS, validateMetaReportRows } from '@/lib/reporting/meta-breakdowns'
import type { ReportMetricMap, ReportingContext } from '@/lib/reporting/contracts'
import type { MetaRow } from '@/lib/reporting/meta-metrics'
import { validateReportingPacket } from '@/lib/reporting/validation'
import { creativeReportingFixture } from './reporting-browser/creative-fixture'
const context: ReportingContext = { account: { id: 'db', metaAccountId: '123', name: null }, range: { from: '2026-09-02', to: '2026-09-04' }, comparison: { from: '2026-08-30', to: '2026-09-01' }, timezone: 'America/New_York', currency: 'USD', asOf: '2026-09-05T16:00:00Z' }
const RESPONSE_VALUES = { spend: 40, impressions: 900, video_2s: 100, cost_per_2s_view: 0.4, thruplays: 50, cost_per_thruplay: 0.8,
  engagements: 90, engagement_rate: 10, cost_per_engagement: 40 / 90, reactions: 7, comments: 3, shares: 9, share_rate: 1,
  cost_per_share: 40 / 9, saves: 2, outbound_clicks: 18, outbound_ctr: 2, landing_page_views: 15, bookings: 2,
  cost_per_booking: 20, appointment_value: 200, appointment_roas: 5 }
const INQUIRY_KEYS = ['action_video_views', 'cost_per_action_video_view', 'messaging_conversations_started',
  'cost_per_messaging_conversation_started', 'messaging_conversations_replied', 'messaging_first_replies',
  'instagram_profile_visits', 'cost_per_instagram_profile_visit', 'instagram_profile_follows',
  'cost_per_instagram_profile_follow']
const action = (action_type: string, value: number) => ({ action_type, value: String(value) })
function responseRow(spend = 40, impressions = 900, engagements = 90): MetaRow {
  return { spend: String(spend), impressions: String(impressions),
    actions: [action('post_engagement', engagements), action('post_reaction', 7), action('comment', 3),
      action('post', 9), action('onsite_conversion.post_save', 2), action('landing_page_view', 15)],
    outbound_clicks: [action('outbound_click', 18)], video_continuous_2_sec_watched_actions: [action('video_view', 100)],
    video_thruplay_watched_actions: [action('video_view', 50)],
    results: [{ indicator: 'conversions:offsite_conversion.fb_pixel_custom.AppointmentConfirmed',
      values: [{ value: '2', attribution_windows: ['default'] }] }],
    conversion_values: [action('offsite_conversion.fb_pixel_custom.AppointmentConfirmed', 200)] }
}
function expectLineage(metrics: ReportMetricMap, id: string, from: string, priorFrom: string) {
  const claims = new Map(Object.values(metrics).flatMap(metric => [metric.current, metric.previous].flatMap(claim => claim ? [[claim.claimId, claim] as const] : [])))
  for (const claim of claims.values()) {
    expect(claim.entity).toEqual({ level: 'ad', id })
    expect(claim.claimId).toContain(`report:meta:ad:${id}:`)
    expect([from, priorFrom]).toContain(claim.window.start)
    for (const inputId of claim.inputClaimIds) {
      const input = claims.get(inputId)
      expect(input, `${claim.metricKey} keeps its exact transitive input`).toBeDefined()
      expect(input!.entity).toEqual(claim.entity)
      expect(input!.window).toEqual(claim.window)
      expect(input!.asOf).toBe(claim.asOf)
    }
  }
}
describe('Meta dimensions and daily claims', () => {
  it('keeps daily delivery, response and named outcomes plus breakdown transitive claim inputs', () => {
    const series = buildMetaSeries(context, [{ date_start: '2026-09-03', spend: '2' }], [])
    expect(Object.keys(series[0].metrics).sort()).toEqual([...META_DAILY_METRIC_KEYS].sort())
    const [row] = buildMetaBreakdowns(context, 'age', [{ age: '25-34', spend: '2' }], [])
    expect(Object.keys(row.metrics).sort()).toEqual([...new Set(['spend', 'impressions', 'reach', 'frequency', 'cpm', 'bookings', 'cost_per_booking', 'purchase_count', 'purchase_value', 'purchase_roas', 'cost_per_purchase', 'outbound_clicks', 'landing_page_views', ...INQUIRY_KEYS, ...Object.keys(RESPONSE_VALUES)])].sort())
    const ids = new Set(Object.values(row.metrics).flatMap(metric => [metric.current.claimId, metric.previous?.claimId]))
    expect(Object.values(row.metrics).flatMap(metric => [metric.current, metric.previous]).filter(Boolean).every(claim => claim!.inputClaimIds.every(id => ids.has(id)))).toBe(true)
  })
  it('preserves native placement reach and never sums overlapping placements', () => {
    const rows = buildMetaBreakdowns(context, 'placement', [
      { publisher_platform: 'instagram', platform_position: 'reels', reach: '10' },
      { publisher_platform: 'instagram', platform_position: 'feed', reach: '12' },
    ], [{ publisher_platform: 'instagram', platform_position: 'reels', reach: '7' }])
    expect(rows.map(row => row.metrics.reach.current.value)).toEqual([12, 10])
    expect(rows[1].metrics.reach.previous?.value).toBe(7)
    expect(rows[0].metrics.reach.previous?.value).toBeNull()
    expect(rows[0].metrics.reach.current.claimId).not.toBe(rows[1].metrics.reach.current.claimId)
  })
  it('aligns daily comparison dates by offset and leaves missing days absent', () => {
    const series = buildMetaSeries(context, [{ date_start: '2026-09-03', spend: '2' }], [{ date_start: '2026-08-31', spend: '3' }])
    expect(series).toHaveLength(1)
    expect(series[0].metrics.spend.current.window).toMatchObject({ start: '2026-09-03', end: '2026-09-03' })
    expect(series[0].metrics.spend.previous?.window).toMatchObject({ start: '2026-08-31', end: '2026-08-31' })
    expect(series[0].metrics.spend.previous?.value).toBe(3)
  })
  it('rejects duplicated dimension populations and accepts distinct placements', () => {
    const row = { date_start: '2026-09-02', date_stop: '2026-09-04', publisher_platform: 'instagram', platform_position: 'reels' }
    expect(() => validateMetaReportRows([row, row], context.range, 'account', false, 'placement')).toThrow()
    expect(validateMetaReportRows([row, { ...row, platform_position: 'feed' }], context.range, 'account', false, 'placement')).toHaveLength(2)
  })
  it('rejects missing entity IDs and impossible dates', () => {
    expect(() => validateMetaReportRows([{ date_start: '2026-09-02', date_stop: '2026-09-04' }], context.range, 'ad', false)).toThrow()
    expect(() => validateMetaReportRows([{ date_start: '2026-02-30', date_stop: '2026-02-30' }], context.range, 'account', true)).toThrow()
  })
  it('retains the ordinary selected-ad placement facts while its unobserved daily engagement stays unavailable', () => {
    const data = creativeReportingFixture('2026-09-02', '2026-09-04', null, 'ok', ['301'])
    expect(() => validateReportingPacket({ context: data.context, section: 'meta', result: data.meta, notes: [] })).not.toThrow()
    const detail = data.meta.data!.entities.find(entity => entity.id === '301')!
    const feed = detail.breakdowns!.find(row => row.label === 'instagram / feed')!
    const reels = detail.breakdowns!.find(row => row.label === 'instagram / reels')!
    expect(feed.metrics.engagements?.current.value).toBe(90)
    expect(feed.metrics.cost_per_engagement?.current.value).toBeCloseTo(40 / 90, 12)
    expect(reels.metrics.engagements?.current.value).toBe(60)
    expect(reels.metrics.cost_per_engagement?.current.value).toBeCloseTo(20 / 60, 12)
    expect(feed.metrics.engagements?.previous?.value).toBe(45)
    expect(feed.metrics.cost_per_engagement?.previous?.value).toBeCloseTo(20 / 45, 12)
    expectLineage(feed.metrics, '301:placement:instagram / feed', data.context.range.from, data.context.comparison.from)
    expect(detail.series!.length).toBeGreaterThan(0)
    for (const point of detail.series!) {
      expect(point.metrics.engagements?.current.value).toBeNull()
      expect(point.metrics.engagements?.previous?.value).toBeNull()
      expect(point.metrics.cost_per_engagement?.current.value).toBeNull()
      expect(point.metrics.spend.current.value).not.toBeNull()
    }
  })
  it('retains every supplied response value and exact dimension-matched current/prior inputs', () => {
    const placement = (position: string, row: MetaRow) => ({ ...row, ad_id: '301', publisher_platform: 'instagram', platform_position: position })
    const rows = buildMetaBreakdowns(context, 'placement', [placement('reels', responseRow(20, 600, 60)), placement('feed', responseRow())],
      [placement('feed', responseRow(10, 900, 30)), placement('reels', responseRow(5, 600, 10))], { level: 'ad', id: '301' })
    const feed = rows.find(row => row.label === 'instagram / feed')!, reels = rows.find(row => row.label === 'instagram / reels')!
    for (const [key, value] of Object.entries(RESPONSE_VALUES)) expect(feed.metrics[key]?.current.value, key).toBeCloseTo(value, 12)
    expect(feed.metrics.cost_per_engagement.previous?.value).toBeCloseTo(10 / 30, 12)
    expect(reels.metrics.cost_per_engagement.previous?.value).toBe(0.5)
    expect(feed.metrics.cost_per_engagement.current.inputClaimIds).toEqual([feed.metrics.spend.current.claimId, feed.metrics.engagements.current.claimId])
    expect(feed.metrics.cost_per_engagement.previous?.inputClaimIds).toEqual([feed.metrics.spend.previous!.claimId, feed.metrics.engagements.previous!.claimId])
    for (const row of rows) expectLineage(row.metrics, `301:placement:${row.label}`, context.range.from, context.comparison.from)
  })
  it('retains prior-only placement response and explicit zero without joining a different dimension', () => {
    const placement = (position: string, row: MetaRow) => ({ ...row, publisher_platform: 'instagram', platform_position: position })
    const rows = buildMetaBreakdowns(context, 'placement', [placement('feed', responseRow(0, 100, 0))],
      [placement('reels', responseRow(20, 600, 60))], { level: 'ad', id: '301' })
    const feed = rows.find(row => row.label === 'instagram / feed')!, reels = rows.find(row => row.label === 'instagram / reels')!
    expect(feed.metrics.engagements?.current.value).toBe(0)
    expect(feed.metrics.engagement_rate?.current.value).toBe(0)
    expect(feed.metrics.cost_per_engagement?.current.value).toBeNull()
    expect(feed.metrics.engagements?.previous?.value).toBeNull()
    expect(reels.metrics.engagements?.current.value).toBeNull()
    expect(reels.metrics.cost_per_engagement?.previous?.value).toBeCloseTo(20 / 60, 12)
  })
  it('retains supported selected-ad daily response using the exact prior offset, including transitive lineage', () => {
    const row = (date: string, value: MetaRow) => ({ ...value, ad_id: '301', date_start: date, date_stop: date })
    const current = validateMetaReportRows([row('2026-09-03', responseRow())], context.range, 'ad', true)
    const previous = validateMetaReportRows([row('2026-08-30', responseRow(100, 900, 1)), row('2026-08-31', responseRow(20, 600, 60))], context.comparison, 'ad', true)
    const [point] = buildMetaSeries(context, current, previous, { level: 'ad', id: '301' })
    for (const [key, value] of Object.entries(RESPONSE_VALUES)) expect(point.metrics[key]?.current.value, key).toBeCloseTo(value, 12)
    expect(point.metrics.cost_per_engagement.previous?.value).toBeCloseTo(20 / 60, 12)
    expect(point.metrics.engagement_rate.previous?.value).toBe(10)
    expect(point.metrics.cost_per_engagement.current.window).toMatchObject({ start: '2026-09-03', end: '2026-09-03' })
    expect(point.metrics.cost_per_engagement.previous?.window).toMatchObject({ start: '2026-08-31', end: '2026-08-31' })
    expectLineage(point.metrics, '301', '2026-09-03', '2026-08-31')
  })
  it.each(['wrong_day', 'missing_action', 'malformed_action', 'duplicate_action', 'no_prior_query'] as const)('keeps current ad daily evidence with %s prior response', problem => {
    const current = { ...responseRow(0), date_start: '2026-09-03' }
    const previous = { ...responseRow(20, 600, 60), date_start: problem === 'wrong_day' ? '2026-08-30' : '2026-08-31',
      ...(problem === 'missing_action' ? { actions: [] } : {}),
      ...(problem === 'malformed_action' ? { actions: [{ action_type: 'post_engagement', value: 'bad' }] } : {}),
      ...(problem === 'duplicate_action' ? { actions: [action('post_engagement', 30), action('post_engagement', 30)] } : {}),
    }
    const [point] = buildMetaSeries(context, [current], problem === 'no_prior_query' ? null : [previous], { level: 'ad', id: '301' })
    expect(point.metrics.engagements?.current.value).toBe(90)
    expect(point.metrics.cost_per_engagement?.current.value).toBe(0)
    expect(point.metrics.engagements?.previous?.value ?? null).toBeNull()
    expect(point.metrics.cost_per_engagement?.previous?.value ?? null).toBeNull()
    if (problem === 'no_prior_query') expect(point.metrics.cost_per_engagement.previous).toBeNull()
    else if (problem !== 'wrong_day') expect(point.metrics.spend.previous?.value).toBe(20)
  })
})
