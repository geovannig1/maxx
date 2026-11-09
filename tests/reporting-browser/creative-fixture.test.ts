import { describe, expect, it } from 'vitest'
import { validateReportingPacket } from '../../src/lib/reporting/validation'
import { buildCreativeGroups } from '../../src/lib/reporting/creative-groups'
import { creativeGroupExportRows } from '../../src/lib/reporting/creative-group-export'
import { creativeMediaMode, creativeMediaOrigin, creativeReportingFixture } from './creative-fixture'
import { reportingFixture } from '../../scripts/demo/sample/reports'

describe('ordinary synthetic creative preview', () => {
  it.each(['meta', 'business', 'website', 'measurement'] as const)('retains a valid native %s packet under the fictional account', section => {
    const data = creativeReportingFixture()
    expect(() => validateReportingPacket({ section, context: data.context, result: data[section], notes: [] })).not.toThrow()
    const wrong = { ...data.context, account: { ...data.context.account, id: 'foreign' } }
    expect(() => validateReportingPacket({ section, context: wrong, result: data[section], notes: [] })).toThrow()
  })
  it('preserves base source builders, defaults and coherent additive hierarchy in both periods', () => {
    const data = creativeReportingFixture(), meta = data.meta.data!, ads = meta.entities.filter(entity => entity.level === 'ad')
    expect(ads).toHaveLength(8)
    expect(reportingFixture().context.account.id).toBe('fixture-db')
    const base = reportingFixture(data.context.range.from, data.context.range.to, data.context.account)
    expect(data.business).toEqual(base.business); expect(data.website).toEqual(base.website); expect(data.measurement).toEqual(base.measurement)
    expect(meta.metrics.spend.current.value).toBe(120); expect(meta.metrics.bookings.current.value).toBe(3)
    expect(data.business.data!.metrics.amount_paid.current.value).toBe(500)
    for (const period of ['current', 'previous'] as const) {
      for (const key of ['spend', 'impressions', 'clicks', 'link_clicks', 'outbound_clicks', 'landing_page_views',
        'engagements', 'reactions', 'comments', 'shares', 'saves', 'messaging_conversations_started', 'messaging_conversations_replied',
        'messaging_first_replies', 'instagram_profile_visits', 'instagram_profile_follows', 'action_video_views', 'bookings', 'purchase_count', 'appointment_value', 'purchase_value']) {
        expect(ads.reduce((sum, ad) => sum + Number(ad.metrics[key][period]!.value), 0), `${period}:${key}`).toBe(meta.metrics[key][period]!.value)
        for (const parent of meta.entities.filter(entity => entity.level !== 'ad')) expect(parent.metrics[key][period]!.value).toBe(meta.metrics[key][period]!.value)
      }
      expect(ads.find(ad => ad.id === '307')!.metrics.bookings[period]).toMatchObject({ value: 0, availability: { state: 'available' } })
      expect(ads.find(ad => ad.id === '308')!.metrics.bookings[period]).toMatchObject({ value: null, availability: { state: 'unavailable' } })
      expect(ads.find(ad => ad.id === '304')!.metrics.video_plays[period]!.value).toBeNull()
      const short = ads.find(ad => ad.id === '301')!.metrics
      expect(short.retention_p50[period]!.value).toBe(Number(short.watch_p50[period]!.value) / Number(short.video_plays[period]!.value) * 100)
      expect(short.retention_p50[period]!.value).toBe(70)
      expect(short.messaging_conversations_started[period]!.value).toBe(period === 'current' ? 3 : 1)
      expect(short.instagram_profile_visits[period]!.value).toBe(period === 'current' ? 12 : 6)
      expect(short.action_video_views[period]!.value).toBe(period === 'current' ? 300 : 150)
    }
  })
  it('groups exact historical objects, keeps missing/changed history visible and rejects a false ID', () => {
    const data = creativeReportingFixture(), grouped = buildCreativeGroups(data)
    expect(grouped.state).toBe('ready')
    expect(grouped.groups.find(group => group.metaCreativeId === '401')!.members.map(member => member.adId)).toEqual(['301', '302'])
    expect(grouped.groups.map(group => group.metaCreativeId)).toEqual(expect.arrayContaining(['402', '403']))
    expect(grouped.unassigned.map(member => member.adId)).toEqual(['305', '306'])
    expect(buildCreativeGroups(data, ['999999'])).toMatchObject({ state: 'invalid', population: { selectedAdCount: null } })
    expect(buildCreativeGroups(data, []).population.selectedAdCount).toBe(0)
    const rows = creativeGroupExportRows(buildCreativeGroups(data, ['301', '302']), data.context, ['ctr', 'spend'])
    expect(rows[0]).toMatchObject({ selected_ad_count: 2, returned_ad_count: 8, requested_ad_ids: '["301","302"]' })
    expect(rows.find(row => row.record_type === 'calculation' && row.metric_key === 'ctr' && row.period === 'current')!.value).toBeCloseTo(90 / 11000 * 100)
  })
  it('keeps native landing-page views distinct from outbound and all-click counts', () => {
    const meta = creativeReportingFixture().meta.data!
    const first = meta.entities.find(entity => entity.id === '301')!.metrics
    expect(first.clicks.current.value).toBe(50)
    expect(first.outbound_clicks.current.value).toBe(10)
    expect(first.landing_page_views.current.value).toBe(8)
    expect(first.landing_page_views.previous?.value).toBe(4)
    expect(meta.metrics.outbound_clicks.current.value).toBe(83)
    expect(meta.metrics.landing_page_views.current.value).toBe(61)
    expect(meta.metrics.landing_page_views.previous?.value).toBe(30)
  })
  it('preserves missing landing-page views even with observed outbound clicks and keeps explicit zero available', () => {
    const ads = creativeReportingFixture().meta.data!.entities
    const outboundOnly = ads.find(entity => entity.id === '305')!.metrics
    expect(outboundOnly.outbound_clicks.current.value).toBe(5)
    for (const period of ['current', 'previous'] as const) {
      for (const id of ['305', '308']) expect(ads.find(entity => entity.id === id)!.metrics.landing_page_views[period])
        .toMatchObject({ value: null, availability: { state: 'unavailable' }, coverage: { state: 'unknown' } })
      expect(ads.find(entity => entity.id === '307')!.metrics.landing_page_views[period])
        .toMatchObject({ value: 0, availability: { state: 'available' }, coverage: { state: 'complete' } })
    }
  })
  it('changes dates without reusing claims and withholds unbracketed future history', () => {
    const data = creativeReportingFixture('2026-09-01', '2026-09-03')
    expect(data.context.comparison).toEqual({ from: '2026-08-29', to: '2026-08-31' })
    expect(data.meta.data!.metrics.spend.current.value).toBe(240)
    expect(() => validateReportingPacket({ section: 'meta', context: data.context, result: data.meta, notes: [] })).not.toThrow()
    expect(creativeReportingFixture('2026-09-05', '2026-09-06').meta.data!.creativeAssignmentEvidence!.state).toBe('unavailable')
  })
  it('supplies selected ad 301 native daily/placement observations with matching totals and an unavailable counterpart', () => {
    const data = creativeReportingFixture(undefined, undefined, null, 'ok', ['301', '304'])
    expect(() => validateReportingPacket({ section: 'meta', context: data.context, result: data.meta, notes: [] })).not.toThrow()
    const ad = data.meta.data!.entities.find(entity => entity.id === '301')!
    for (const period of ['current', 'previous'] as const) {
      const series = period === 'current' ? ad.series! : ad.comparisonSeries!
      for (const key of ['spend', 'bookings', 'outbound_clicks', 'landing_page_views', 'messaging_conversations_started', 'instagram_profile_visits', 'action_video_views']) {
        expect(series.reduce((sum, point) => sum + Number(point.metrics[key].current.value), 0)).toBe(ad.metrics[key][period]!.value)
        expect(ad.breakdowns!.reduce((sum, row) => sum + Number(row.metrics[key][period]!.value), 0)).toBe(ad.metrics[key][period]!.value)
      }
      for (const point of series) expect(point.metrics.landing_page_views.current.availability.state).toBe('available')
    }
    expect(ad.series).toHaveLength(3); expect(ad.breakdowns).toHaveLength(2)
    expect(data.meta.data!.entities.find(entity => entity.id === '304')!.series).toEqual([])
    expect(creativeReportingFixture().meta.data!.entities.find(entity => entity.id === '301')!.series).toEqual([])
  })
  it('accepts only the narrowly scoped HTTPS media origin and never modifies metric evidence with media modes', () => {
    expect(creativeMediaOrigin('https://127.0.0.1:41234')).toBe('https://127.0.0.1:41234')
    for (const bad of ['http://127.0.0.1:41234', 'https://example.test:41234', 'https://user@127.0.0.1:41234',
      'https://127.0.0.1:41234/file', 'https://127.0.0.1:41234?x=1', 'https://127.0.0.1']) expect(creativeMediaOrigin(bad)).toBeNull()
    expect(creativeMediaMode('unexpected')).toBe('ok')
    const normal = creativeReportingFixture(), denied = creativeReportingFixture(undefined, undefined, 'https://127.0.0.1:41234', 'all-denied')
    for (const entity of normal.meta.data!.entities) expect(denied.meta.data!.entities.find(other => other.id === entity.id)!.metrics).toEqual(entity.metrics)
    expect(denied.context).toEqual(normal.context)
    expect(denied.meta.data!.entities.find(entity => entity.id === '301')!.creative!.videoUrl).toContain('/denied/original-8.mp4')
  })
})
