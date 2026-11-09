import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { AdsReport } from '@/components/reporting/AdsReport'
import { filterEntities } from '@/components/reporting/MetricTable'
import { OverviewPerformance } from '@/components/reporting/OverviewPerformance'
import { SavedReportProvider } from '@/components/reporting/SavedReportContext'
import { SavedViewSchema, type OpenSavedReportingReportReply } from '@/lib/reporting/saved-contract'
import { deriveExpertReview } from '@/lib/reporting/review'
import type { ReportEntity } from '@/lib/reporting/contracts'
import { buildMetaBreakdowns } from '@/lib/reporting/meta-breakdowns'
import * as temporal from '@/lib/reporting/trend'
import { hierarchyHistoryFixture } from './fixtures/reporting-hierarchy-history'

const navigation = vi.hoisted(() => ({ search: '', pathname: '/performance' }))
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams(navigation.search), usePathname: () => navigation.pathname }))
const decode = (value: string) => value.replaceAll('&amp;', '&').replaceAll('&#x27;', "'").replaceAll('&quot;', '"')
const links = (html: string) => [...html.matchAll(/href="([^"]+)"/g)].map(match => new URL(decode(match[1]), 'https://maxx.test'))
const reviewIds = (html: string) => [...html.matchAll(/data-review-id="([^"]+)"/g)].map(match => match[1])
const selectedQuery = (entity: ReportEntity) => new URLSearchParams({ level: entity.level, view: 'detail',
  campaign: entity.level === 'campaign' ? entity.id : entity.campaignId!, ...(entity.level === 'adset' ? { adset: entity.id } : {}) }).toString()
beforeEach(() => { navigation.search = ''; navigation.pathname = '/performance' })

describe('campaign and ad-set reading paths', () => {
  it.each(['campaign', 'adset'] as const)('opens the exact %s from the executive and complete period table', level => {
    const data = hierarchyHistoryFixture(), entity = data.meta.data!.entities.find(row => row.level === level)!
    for (const surface of ['overview', 'ads']) {
      navigation.search = surface === 'overview' ? `overview_level=${level}` : `level=${level}`
      const html = renderToStaticMarkup(surface === 'overview' ? <OverviewPerformance data={data} /> : <AdsReport data={data} />)
      const target = links(html).find(url => url.searchParams.get('view') === 'detail' && url.searchParams.get(level) === entity.id)
      expect(target, `${surface} must open its own entity before child drill`).toBeDefined()
      expect(target!.searchParams.get('level')).toBe(level)
      expect(target!.searchParams.get('from')).toBe(data.context.range.from)
    }
  })

  it.each(['campaign', 'adset'] as const)('keeps the full prepared %s answer, own results/history and all-child destination together', level => {
    const data = hierarchyHistoryFixture(), entity = data.meta.data!.entities.find(row => row.level === level)!
    navigation.search = `${selectedQuery(entity)}&entity_trend=purchase_roas&status=${entity.status}&q=${entity.id}`
    const expected = deriveExpertReview(data).findings.filter(finding => finding.entity?.level === level && finding.entity.id === entity.id)
    expect(expected.length).toBeGreaterThan(0)
    const html = renderToStaticMarkup(<AdsReport data={data} />)
    expect(reviewIds(html).sort()).toEqual(expected.map(finding => finding.id).sort())
    expect(html).toContain(level === 'campaign' ? 'What this campaign’s results show' : 'What this ad set’s results show')
    expect(html).toContain(`aria-label="${level === 'campaign' ? 'Campaign' : 'Ad set'}-level daily history"`)
    expect(html).toContain('value="purchase_roas" selected')
    expect(html).toContain('2.40×'); expect(html).toContain('0.00×')
    expect(html).toContain('id="entity-metrics"')
    const childLabel = level === 'campaign' ? 'All ad sets in this campaign' : 'All ads in this ad set'
    const childHtml = html.match(new RegExp(`<a[^>]*aria-label="${childLabel}"[^>]*>`))![0]
    const child = links(childHtml)[0]
    expect(child).toBeDefined()
    expect(child.searchParams.get(level)).toBe(entity.id)
    for (const key of ['q', 'status', 'format', 'audience', 'compare']) expect(child.searchParams.has(key)).toBe(false)
    expect(child.searchParams.get('from')).toBe(data.context.range.from)
    expect(html).toContain('Daily and period results are independent observations')
  })

  it('shows exact prior dates and keeps all daily metrics in the entity export', () => {
    const data = hierarchyHistoryFixture(), entity = data.meta.data!.entities.find(row => row.level === 'adset')!
    navigation.search = `${selectedQuery(entity)}&entity_trend=purchase_roas&entity_trend_period=previous`
    const html = renderToStaticMarkup(<AdsReport data={data} />)
    expect(html).toContain('value="previous" selected')
    expect(html).toContain('1.20×')
    expect(html).toContain(data.context.comparison.from)
    const rows = temporal.entityDailyExportRows?.(entity, data.context) ?? []
    expect(rows.length).toBeGreaterThan(20)
    expect(rows.some(row => row.metric === entity.comparisonSeries![0].metrics.purchase_roas.label && row.value === 1.2 && row.from === data.context.comparison.to)).toBe(true)
    expect(rows.every(row => row.entity.includes(`Meta adset ${entity.id}`))).toBe(true)
    expect(rows.some(row => row.metric === entity.series![0].metrics.spend.label)).toBe(true)
  })

  it.each(['campaign', 'adset'] as const)('reveals opposing %s trajectories despite equal period results', level => {
    const data = hierarchyHistoryFixture(), peers = data.meta.data!.entities.filter(entity => entity.level === level)
    expect(peers).toHaveLength(2)
    expect(peers.map(entity => entity.metrics.purchase_roas.current.value)).toEqual([200 / 150, 200 / 150])
    const first = level === 'campaign' ? ['2.40×', '1.60×', '0.00×'] : ['0.00×', '1.60×', '2.40×']
    peers.forEach((entity, index) => {
      navigation.search = `${selectedQuery(entity)}&entity_trend=purchase_roas`
      const html = renderToStaticMarkup(<AdsReport data={data} />)
      const history = html.slice(html.indexOf(`aria-label="${level === 'campaign' ? 'Campaign' : 'Ad set'}-level daily history"`))
      const rows = [...history.matchAll(/<tr[^>]*>[\s\S]*?<\/tr>/g)].slice(1, 4).map(match => match[0])
      const expected = index === 0 ? first : [...first].reverse()
      rows.forEach((row, day) => { expect(row).toContain(entity.series![day].date); expect(row).toContain(expected[day]) })
    })
  })

  it.each(['campaign', 'adset'] as const)('clears parent filters to reveal a paused, spend-bearing %s child', level => {
    const data = hierarchyHistoryFixture(), parent = data.meta.data!.entities.find(row => row.level === level)!
    const childLevel = level === 'campaign' ? 'adset' : 'ad'
    const child = data.meta.data!.entities.find(row => row.level === childLevel && (level === 'campaign' ? row.campaignId : row.adsetId) === parent.id)!
    const population = data.meta.data!.entities.map(entity => entity === child ? { ...entity, status: 'PAUSED' } : entity)
    expect(child.metrics.spend.current.value).toBeGreaterThan(0)
    navigation.search = `${selectedQuery(parent)}&status=ACTIVE&q=${parent.id}&format=unknown&audience=unknown&compare=${parent.id}`
    const html = renderToStaticMarkup(<AdsReport data={{ ...data, meta: { ...data.meta, data: { ...data.meta.data!, entities: population } } }} />)
    const childLabel = level === 'campaign' ? 'All ad sets in this campaign' : 'All ads in this ad set'
    const anchor = html.match(new RegExp(`<a[^>]*aria-label="${childLabel}"[^>]*>`))![0]
    const target = links(anchor)[0]
    expect(filterEntities(population, new URLSearchParams(navigation.search), childLevel).some(entity => entity.id === child.id)).toBe(false)
    expect(filterEntities(population, target.searchParams, childLevel).some(entity => entity.id === child.id)).toBe(true)
  })

  it('flags complete daily/period disagreement only for the affected period and keeps incomplete days unknown', () => {
    const original = hierarchyHistoryFixture(), entity = original.meta.data!.entities.find(row => row.level === 'campaign')!
    const mismatched = { ...entity, metrics: { ...entity.metrics, spend: { ...entity.metrics.spend,
      current: { ...entity.metrics.spend.current, value: 200 } } } }
    const dataFor = (row: ReportEntity) => ({ ...original, meta: { ...original.meta, data: { ...original.meta.data!,
      entities: original.meta.data!.entities.map(item => item === entity ? row : item) } } })
    navigation.search = `${selectedQuery(entity)}&entity_trend=spend`
    expect(renderToStaticMarkup(<AdsReport data={dataFor(mismatched)} />)).toContain('Reported daily sum: $150.00. Period aggregate: $200.00.')
    navigation.search += '&entity_trend_period=previous'
    expect(renderToStaticMarkup(<AdsReport data={dataFor(mismatched)} />)).not.toContain('These independent readings disagree')
    navigation.search = `${selectedQuery(entity)}&entity_trend=spend`
    const partial = { ...mismatched, series: mismatched.series!.slice(0, 2) }
    const html = renderToStaticMarkup(<AdsReport data={dataFor(partial)} />)
    expect(html).not.toContain('Reported daily sum:')
    expect(html).toContain('Unavailable')
  })

  it.each(['campaign', 'adset', 'ad'] as const)('keeps the %s evidence clock when another source is newer', level => {
    const original = hierarchyHistoryFixture(), entity = original.meta.data!.entities.find(row => row.level === level)!
    const data = { ...original, context: { ...original.context, asOf: '2026-09-05T18:00:00Z' } }
    navigation.search = level === 'ad' ? `ad=${entity.id}` : selectedQuery(entity)
    const html = renderToStaticMarkup(<AdsReport data={data} />)
    expect(html).toContain(`Source as of ${original.meta.asOf}`)
    expect(html).not.toContain('Source as of 2026-09-05T18:00:00Z')
  })

  it.each(['campaign', 'adset', 'ad'] as const)('keeps the %s history selection when opening its own period results', level => {
    const data = hierarchyHistoryFixture(), entity = data.meta.data!.entities.find(row => row.level === level)!
    const prefix = level === 'ad' ? 'ad' : 'entity'
    navigation.search = `${level === 'ad' ? `ad=${entity.id}` : selectedQuery(entity)}&${prefix}_trend=purchase_roas&${prefix}_trend_period=previous`
    const html = renderToStaticMarkup(<AdsReport data={data} />)
    const target = links(html).find(url => url.hash === (level === 'ad' ? '#ad-metrics' : '#entity-metrics'))!
    expect(target.searchParams.get(`${prefix}_trend`)).toBe('purchase_roas')
    expect(target.searchParams.get(`${prefix}_trend_period`)).toBe('previous')
  })

  it('rejects a mismatched parent selection rather than falling back to another entity or the account', () => {
    const data = hierarchyHistoryFixture(), entity = data.meta.data!.entities.find(row => row.level === 'adset')!
    navigation.search = `view=detail&level=adset&campaign=not-this-campaign&adset=${entity.id}`
    const html = renderToStaticMarkup(<AdsReport data={data} />)
    expect(html).toContain('Ad set not in this view')
    expect(html).not.toContain('Delivery over time')
    expect(html).not.toContain('id="entity-metrics"')
  })

  it('preserves original saved assessment and missing parent history without reconstructing a new answer', () => {
    const data = hierarchyHistoryFixture(), parent = data.meta.data!.entities.find(row => row.level === 'adset')!
    const original = deriveExpertReview(data), finding = original.findings.find(item => item.entity?.level === 'adset' && item.entity.id === parent.id)!
    const frozen = { ...data, meta: { ...data.meta, data: { ...data.meta.data!, entities: data.meta.data!.entities.map(entity => entity === parent ? { ...entity, series: undefined, comparisonSeries: undefined } : entity) } } }
    const saved: OpenSavedReportingReportReply = { saved: { id: '00000000-0000-4000-8000-000000007023' } as OpenSavedReportingReportReply['saved'],
      data: frozen, notes: [], review: { ...original, findings: [{ ...finding, id: 'historical-parent', observation: { text: 'Original saved parent conclusion.', evidence: [] } }] } }
    navigation.search = selectedQuery(parent)
    const html = renderToStaticMarkup(<SavedReportProvider value={saved}><AdsReport data={frozen} /></SavedReportProvider>)
    expect(reviewIds(html)).toEqual(['historical-parent'])
    expect(html).toContain('Original saved parent conclusion.')
    expect(html).toContain('Ad set-level daily history is unavailable')
    expect(html).not.toContain('2.40×')
    for (const url of links(html).filter(url => url.searchParams.get('level') === 'ad' || url.hash === '#entity-metrics')) expect(url.searchParams.get('saved')).toBe(saved.saved.id)
  })

  it('retains parent-history selection with the existing saved view and rejects unrelated keys', () => {
    const query = { view: 'detail', level: 'adset', campaign: '101', adset: '201', breakdown: 'placement', entity_trend: 'purchase_roas', entity_trend_period: 'previous' }
    expect(SavedViewSchema.safeParse({ pathname: '/performance', query }).success).toBe(true)
    expect(SavedViewSchema.safeParse({ pathname: '/performance', query: { ...query, breakdown: 'device' } }).success).toBe(false)
    expect(SavedViewSchema.safeParse({ pathname: '/performance', query: { ...query, unknown_history: 'bad' } }).success).toBe(false)
    expect(temporal.temporalViewHref('/performance', 'saved=original&view=detail&level=campaign&campaign=101', '#history', 'entity_trend', 'spend'))
      .toBe('/performance?saved=original&view=detail&level=campaign&campaign=101&entity_trend=spend#history')
  })

  it.each(['campaign', 'adset'] as const)('shows on-demand placement, age, gender and region controls with the selected %s evidence', level => {
    const original = hierarchyHistoryFixture(), entity = original.meta.data!.entities.find(row => row.level === level)!
    const breakdowns = buildMetaBreakdowns(original.context, 'placement', [{ campaign_id: entity.campaignId ?? entity.id,
      ...(level === 'adset' ? { adset_id: entity.id } : {}), publisher_platform: 'instagram', platform_position: 'reels',
      spend: '50', impressions: '1000' }], [], { level, id: entity.id })
    const data = { ...original, meta: { ...original.meta, data: { ...original.meta.data!, entities: original.meta.data!.entities.map(row =>
      row === entity ? { ...row, breakdowns } : row) } } }
    navigation.search = `${selectedQuery(entity)}&breakdown=placement`
    const html = renderToStaticMarkup(<AdsReport data={data} />)
    expect(html).toContain('Placement, age, gender and region')
    for (const label of ['Placement', 'Age', 'Gender', 'Region']) expect(html).toContain(`>${label}</button>`)
    expect(html).toContain('aria-pressed="true"')
    expect(html).toContain(`${level === 'campaign' ? 'Campaign' : 'Ad set'} placement metrics`)
    expect(html).toContain('instagram / reels')
  })

  it('binds a frozen report to its captured breakdown instead of a changed URL dimension', () => {
    const original = hierarchyHistoryFixture(), entity = original.meta.data!.entities.find(row => row.level === 'adset')!
    const breakdowns = buildMetaBreakdowns(original.context, 'region', [{ campaign_id: entity.campaignId,
      adset_id: entity.id, region: 'Massachusetts', spend: '50', impressions: '1000' }], [], { level: 'adset', id: entity.id })
    const frozen = { ...original, meta: { ...original.meta, data: { ...original.meta.data!, entities: original.meta.data!.entities.map(row =>
      row === entity ? { ...row, breakdowns } : row) } } }
    const saved = { saved: { id: '00000000-0000-4000-8000-000000007024', view: { pathname: '/performance',
      query: { view: 'detail', level: 'adset', campaign: '101', adset: entity.id, breakdown: 'region' } } },
      data: frozen, notes: [], review: deriveExpertReview(frozen) } as unknown as OpenSavedReportingReportReply
    navigation.search = `${selectedQuery(entity)}&breakdown=age`
    const html = renderToStaticMarkup(<SavedReportProvider value={saved}><AdsReport data={frozen} /></SavedReportProvider>)
    expect(html).toContain('Ad set region metrics')
    expect(html).toContain('Massachusetts')
    expect(html).toContain('Region was captured in this saved report')
    expect(html).not.toContain('No validated age rows were returned')
  })

  it('does not describe an ad-set breakdown as captured for a different saved parent', () => {
    const frozen = hierarchyHistoryFixture()
    const saved = { saved: { id: '00000000-0000-4000-8000-000000007025', view: { pathname: '/performance',
      query: { view: 'detail', level: 'adset', campaign: '101', adset: '201', breakdown: 'region' } } },
      data: frozen, notes: [], review: deriveExpertReview(frozen) } as unknown as OpenSavedReportingReportReply
    navigation.search = 'view=detail&level=campaign&campaign=101&breakdown=region'
    const html = renderToStaticMarkup(<SavedReportProvider value={saved}><AdsReport data={frozen} /></SavedReportProvider>)
    expect(html).toContain('A parent breakdown was not included in this saved report')
    expect(html).not.toContain('Region was captured in this saved report')
    expect(html).not.toContain('Campaign region metrics')
  })
})
