import './_support/outcome-noun-booking'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { makeReportMetric } from '@/lib/reporting/claims'
import type { ReportEntity, ReportingData } from '@/lib/reporting/contracts'
import { AdsReport } from '@/components/reporting/AdsReport'
import { CreativeReport } from '@/components/reporting/CreativeReport'
import { EntityComparison } from '@/components/reporting/EntityComparison'
import { AdDetail } from '@/components/reporting/AdDetail'
import { CreativeAsset } from '@/components/reporting/CreativeAsset'
import { AudienceReport } from '@/components/reporting/AudienceReport'
import { OverviewReport } from '@/components/reporting/OverviewReport'
import { filterEntities, sortEntities, investigationHref, InvestigationExport, InvestigationSourceState, METRIC_GROUPS } from '@/components/reporting/MetricTable'
import * as reportExport from '@/lib/reporting/export'

const navigation = vi.hoisted(() => ({ search: '', pathname: '/ads' }))
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(navigation.search),
  usePathname: () => navigation.pathname,
}))

const context: ReportingData['context'] = {
  account: { id: 'studio-db', metaAccountId: 'act_123', name: 'Studio' },
  range: { from: '2026-09-02', to: '2026-09-04' },
  comparison: { from: '2026-08-30', to: '2026-09-01' },
  timezone: 'America/New_York', currency: 'USD', asOf: '2026-09-05T16:00:00Z',
}
function metric(key: string, value: number | null, date?: string) {
  return makeReportMetric({ context: date ? { ...context, range: { from: date, to: date } } : context, key, label: key === 'spend' ? 'Spend' : 'Impressions',
    definition: `Meta-reported ${key} for the selected period.`, source: 'meta',
    unit: key === 'spend' ? 'money' : 'count', current: value, previous: 2,
    coverage: { state: 'complete', numerator: 1, denominator: 1 },
    previousCoverage: { state: 'complete', numerator: 1, denominator: 1 },
  })
}
const first: ReportEntity = {
  id: 'ad-1', level: 'ad', name: 'Studio walkthrough', campaignId: 'c1', campaignName: 'Rental',
  adsetId: 's1', adsetName: 'Local creators', status: 'PAUSED', configurationAsOf: context.asOf,
  audience: 'cold', audienceLabel: 'Cold · broad audience',
  creative: { id: 'creative-1', name: 'Studio tour', format: 'video', thumbnailUrl: 'https://example.com/tour.jpg',
    imageUrl: null, videoUrl: null, durationSeconds: 20, body: 'Room to make something great.',
    headline: 'Book the studio', destination: 'https://example.com/rentals' },
  metrics: { spend: metric('spend', 0), impressions: metric('impressions', 20) },
}
const second: ReportEntity = { ...first, id: 'ad-2', name: 'Portrait still', adsetId: 's2',
  audience: 'warm', audienceLabel: 'Warm · visitors', status: 'ACTIVE', creative: null,
  metrics: { spend: metric('spend', 10), impressions: metric('impressions', null) } }
const missing: ReportEntity = { ...first, id: 'ad-3', name: 'Unmeasured', campaignId: 'c2',
  metrics: { spend: metric('spend', null) } }
const data: ReportingData = {
  context, meta: { state: 'available', asOf: context.asOf, notes: [], data: {
    entities: [first, second, missing], metrics: {}, series: [], comparisonSeries: [], breakdowns: [], observations: [],
    attributionWindow: '7-day click / 1-day view', reportingTime: 'impression', sourceDescription: 'Meta-reported delivery',
  } },
  business: { state: 'unavailable', data: null, asOf: null, notes: [] },
  website: { state: 'unavailable', data: null, asOf: null, notes: [] },
}
beforeEach(() => { navigation.search = ''; navigation.pathname = '/ads' })

function detailData(detailState: 'loading' | 'complete' | 'unavailable', entities: ReportEntity[] = [{ ...second, configurationAsOf: null }]): ReportingData {
  return { ...data, meta: { ...data.meta, data: { ...data.meta.data!, detailState, entities } } }
}

describe('pending Meta detail presentation', () => {
  it('keeps large partial-source qualification sets complete but collapsed behind one counted disclosure', () => {
    const notes = Array.from({ length: 25 }, (_, index) => `Qualification ${index + 1}`)
    const partial = { ...data, meta: { ...data.meta, state: 'partial' as const, notes: [...notes, notes[0]] } }
    const html = renderToStaticMarkup(<InvestigationSourceState data={partial} />)
    expect(html).toContain('Some Meta evidence is incomplete')
    expect(html).toContain('Review 25 Meta source qualifications')
    expect(html).toContain('Qualification 1')
    expect(html).toContain('Qualification 25')
    expect(html).not.toContain('<details open=""')

    const loading = { ...partial, meta: { ...partial.meta, data: { ...partial.meta.data!, detailState: 'loading' as const } } }
    const loadingHtml = renderToStaticMarkup(<InvestigationSourceState data={loading} />)
    expect(loadingHtml).toContain('Loading Meta details')
    expect(loadingHtml).toContain('Review 25 Meta source qualifications')
    expect(loadingHtml.match(/>Qualification 1<\/p>/g)).toHaveLength(1)
    expect(loadingHtml).not.toContain('<details open=""')
  })

  it('keeps ad metrics visible while preview, copy, configuration and history are pending', () => {
    navigation.search = 'ad=ad-2'
    const html = renderToStaticMarkup(<AdsReport data={detailData('loading')} />)
    for (const label of ['Loading preview', 'Loading primary text', 'Loading destination', 'Loading configuration', 'Loading ad-level daily history', 'Loading ad-level placement detail', '$10.00']) expect(html).toContain(label)
    for (const label of ['Preview unavailable', 'was not supplied', 'URL unavailable', 'history is unavailable', 'placement detail is unavailable', 'breakdowns were not supplied']) expect(html).not.toContain(label)
  })

  it.each(['complete', 'unavailable'] as const)('retains honest missing-detail labels when detail state is %s', detailState => {
    navigation.search = 'ad=ad-2'
    const html = renderToStaticMarkup(<AdsReport data={detailData(detailState)} />)
    for (const label of ['Preview unavailable', 'Primary text was not supplied', 'Destination URL unavailable', 'daily history is unavailable', 'placement detail is unavailable', '$10.00']) expect(html).toContain(label)
    expect(html).not.toContain('Loading preview')
  })

  it('propagates pending preview state through ads, creative cards and comparisons', () => {
    const pending = detailData('loading', [{ ...first, creative: null }, second])
    for (const view of [<AdsReport key="ads" data={pending} />, <CreativeReport key="creative" data={pending} />]) {
      const html = renderToStaticMarkup(view)
      expect(html).toContain('Loading preview')
      expect(html).toContain('$10.00')
      expect(html).not.toContain('Preview unavailable')
    }
    navigation.search = 'compare=ad-1,ad-2&view=compare'
    const html = renderToStaticMarkup(<CreativeReport data={pending} />)
    expect(html).toContain('Loading preview')
    expect(html).toContain('$10.00')
    expect(html).not.toContain('Preview unavailable')
  })

  it('keeps supplied preview and ad details visible while other optional reads continue', () => {
    const entity = { ...first, series: [{ date: '2026-09-02', metrics: { spend: metric('spend', 4, '2026-09-02') } }],
      breakdowns: [{ id: 'ad1-ig', dimension: 'placement' as const, label: 'Instagram Reels', metrics: { spend: metric('spend', 3) } }] }
    const html = renderToStaticMarkup(<AdDetail entity={entity} context={context} meta={detailData('loading').meta.data!} />)
    for (const label of ['https://example.com/tour.jpg', 'Book the studio', 'Daily values and evidence', 'Instagram Reels', '$4.00', '$3.00']) expect(html).toContain(label)
    for (const label of ['Loading preview', 'Loading primary text', 'Loading ad-level daily history', 'Loading ad-level placement detail']) expect(html).not.toContain(label)
  })

  it('keeps missing selected ads and comparisons pending until inventory resolves', () => {
    navigation.search = 'ad=not-yet-returned'
    const selected = renderToStaticMarkup(<AdsReport data={detailData('loading')} />)
    expect(selected).toContain('Loading selected ad')
    expect(selected).not.toContain('Ad not in this view')
    expect(selected).not.toContain('is not in the returned entities')
    navigation.search = 'compare=ad-1,ad-2&view=compare'
    const comparison = renderToStaticMarkup(<CreativeReport data={detailData('loading')} />)
    expect(comparison).toContain('Loading selected entities')
    expect(comparison).not.toContain('Select two to four entities in the same filtered view')
    expect(renderToStaticMarkup(<CreativeReport data={detailData('complete')} />)).toContain('Select two to four entities in the same filtered view')
  })

  it('keeps filtered and empty inventory results pending instead of asserting absence', () => {
    navigation.search = 'format=video'
    const filtered = renderToStaticMarkup(<CreativeReport data={detailData('loading')} />)
    expect(filtered).toContain('Loading ad inventory')
    expect(filtered).not.toContain('No matches for these filters')
    navigation.search = ''
    const empty = renderToStaticMarkup(<AdsReport data={detailData('loading', [])} />)
    expect(empty).toContain('Loading ad inventory')
    expect(empty).not.toContain('No entities returned')
    expect(renderToStaticMarkup(<AdsReport data={detailData('complete', [])} />)).toContain('No entities returned')
  })

  it('does not call pending source detail incomplete or missing filter options absent', () => {
    navigation.search = 'campaign=not-yet-returned'
    const pending = detailData('loading')
    const html = renderToStaticMarkup(<AdsReport data={{ ...pending, meta: { ...pending.meta, state: 'partial', notes: ['Creative details are loading.'] } }} />)
    expect(html).toContain('Loading Meta details')
    expect(html).toContain('Loading option (not-yet-returned)')
    expect(html).toContain('Creative details are loading.')
    expect(html).not.toContain('Some Meta evidence is incomplete')
    expect(html).not.toContain('Not in this response')
  })

  it('marks missing audience dimensions pending while retaining supplied ad-set metrics', () => {
    const pending = detailData('loading', [{ ...second, level: 'adset' }])
    const html = renderToStaticMarkup(<AudienceReport data={pending} />)
    for (const dimension of ['Placement', 'Age', 'Gender', 'Region']) expect(html).toContain(`Loading ${dimension.toLowerCase()} breakdown`)
    expect(html).toContain('$10.00')
    expect(html).not.toContain('Meta did not return supported rows')
    expect(renderToStaticMarkup(<AudienceReport data={detailData('complete')} />)).toContain('Meta did not return supported rows')
    const empty = renderToStaticMarkup(<AudienceReport data={detailData('loading', [])} />)
    expect(empty).toContain('Loading ad sets')
    expect(empty).not.toContain('No ad sets were returned')
  })

  it('carries pending detail state into overview previews and source-specific daily evidence', () => {
    const html = renderToStaticMarkup(<OverviewReport data={detailData('loading')} showFindings={false} />)
    expect(html).toContain('Loading preview')
    expect(html).toContain('Loading Meta daily evidence')
    expect(html).toContain('$10.00')
    expect(html).not.toContain('Preview unavailable')
    expect(html).not.toContain('Ad-set distribution unavailable')
  })

  it('keeps an empty overview creative inventory pending until optional Meta details finish', () => {
    const empty = renderToStaticMarkup(<OverviewReport data={detailData('loading', [])} showFindings={false} />)
    expect(empty).toMatch(/Loading creative inventory|Creative evidence is loading/)
    expect(empty).not.toContain('Creative inventory is unavailable')
    expect(empty).not.toContain('No ad executions were supplied')
  })
})

describe('investigation scope and ordering', () => {
  it('keeps both named-event counts and values visible in the Results columns', () => {
    expect(METRIC_GROUPS.results.keys).toEqual([
      'spend', 'bookings', 'cost_per_booking', 'appointment_value', 'appointment_roas',
      'purchase_count', 'cost_per_purchase', 'purchase_value', 'purchase_roas', 'bookings_click', 'bookings_view',
    ])
  })

  it('keeps paused and zero-spend ads unless the owner filters them', () => {
    expect(filterEntities([first, second], new URLSearchParams(), 'ad')).toHaveLength(2)
    expect(filterEntities([first, second], new URLSearchParams('status=PAUSED'), 'ad')).toEqual([first])
  })
  it('combines hierarchy, audience, format and case-insensitive search without inventing matches', () => {
    const params = new URLSearchParams('campaign=c1&adset=s1&audience=cold&q=STUDIO&format=video')
    expect(filterEntities([first, second, missing], params, 'ad')).toEqual([first])
    expect(filterEntities([first, second], new URLSearchParams('campaign=does-not-exist'), 'ad')).toEqual([])
  })
  it('sorts measured zero normally and places unavailable values last in both directions', () => {
    expect(sortEntities([first, missing, second], 'spend', 'asc').map(row => row.id)).toEqual(['ad-1', 'ad-2', 'ad-3'])
    expect(sortEntities([first, missing, second], 'spend', 'desc').map(row => row.id)).toEqual(['ad-2', 'ad-1', 'ad-3'])
    expect([first, missing, second].map(row => row.id)).toEqual(['ad-1', 'ad-3', 'ad-2'])
  })
  it('retains dates and source filters through detail and return links', () => {
    const start = new URLSearchParams('from=2026-09-02&to=2026-09-04&campaign=c1&adset=s1&group=clicks&q=studio')
    const detail = investigationHref('/creative', start, { ad: 'ad-1' })
    const query = new URL(detail, 'https://local.test').searchParams
    expect(query.get('ad')).toBe('ad-1')
    expect(query.get('group')).toBe('clicks')
    const back = new URL(investigationHref('/creative', query, { ad: null }), 'https://local.test')
    expect(back.searchParams.toString()).toBe(start.toString())
  })
  it('exports only the current entity scope and preset while retaining explicit zero and exposure', () => {
    const download = vi.spyOn(reportExport, 'downloadReportCsv').mockImplementation(() => {})
    const button = InvestigationExport({ entities: [first], group: 'results', context, filename: 'comparison', extraKeys: ['impressions'] })
    button.props.onClick()
    const [exported, filename] = download.mock.calls[0]
    expect(exported).toHaveLength(2)
    expect(exported[0]).toMatchObject({ value: 0, source: 'meta', from: context.range.from, to: context.range.to, timezone: context.timezone })
    expect(exported[0].entity).toContain('ad-1')
    expect(exported[0].entity).toContain('s1')
    expect(exported.some(row => row.entity.includes('ad-2'))).toBe(false)
    expect(filename).toContain('2026-09-02-2026-09-04')
    download.mockRestore()
  })
})

describe('prepared investigation presentation', () => {
  it('renders useful metric presets, explicit source identity and paused delivered ads', () => {
    const html = renderToStaticMarkup(<AdsReport data={data} />)
    for (const label of ['Results', 'Delivery', 'Clicks', 'Engagement', 'Meta booking event value', 'Reported purchases', 'Reported purchase value', 'Studio walkthrough', 'PAUSED', 'act_123', '2026-09-02', 'America/New_York']) expect(html).toContain(label)
    expect(html).toContain('Export CSV')
    expect(html).toContain('Search')
    expect(html).toContain('$0.00')
    expect(html).toContain('Unavailable')
  })
  it('renders a filtered empty result without claiming that delivery was zero', () => {
    navigation.search = 'q=does-not-exist'
    const html = renderToStaticMarkup(<AdsReport data={data} />)
    expect(html).toContain('No matches')
    expect(html).toContain('Clear filters')
    expect(html).not.toContain('Studio walkthrough')
  })
  it('shows source failure and partial notes instead of an empty success', () => {
    const failed = renderToStaticMarkup(<AdsReport data={{ ...data, meta: { state: 'unavailable', data: null, asOf: null, notes: ['Meta request failed.'] } }} />)
    expect(failed).toContain('Meta request failed.')
    expect(failed).not.toContain('No matches')
    const partial = renderToStaticMarkup(<AdsReport data={{ ...data, meta: { ...data.meta, state: 'partial', notes: ['Placements were not returned.'] } }} />)
    expect(partial).toContain('Placements were not returned.')
    expect(partial).toContain('Studio walkthrough')
  })
  it('puts actual creative and duration next to watch metrics without declaring winners', () => {
    const html = renderToStaticMarkup(<CreativeReport data={data} />)
    expect(html).toContain('https://example.com/tour.jpg')
    expect(html).toContain('20 seconds')
    expect(html).toContain('Attention')
    expect(html).toContain('Preview unavailable')
    expect(html).not.toMatch(/winner|best-performing/i)
  })
  it('keeps asset absence understandable without an empty image or video control', () => {
    const html = renderToStaticMarkup(<CreativeAsset creative={null} name="Missing preview" />)
    expect(html).toContain('Preview unavailable')
    expect(html).not.toContain('<img')
    expect(html).not.toContain('<video')
  })
  it('rejects unsafe preview URLs and does not give thumbnails fake playback controls', () => {
    const unsafe = renderToStaticMarkup(<CreativeAsset creative={{ ...first.creative!, imageUrl: 'javascript:alert(1)', thumbnailUrl: 'http://example.com/unsafe.jpg' }} name="Unsafe source" />)
    expect(unsafe).toContain('Preview unavailable')
    expect(unsafe).not.toContain('<img')
    const thumbnail = renderToStaticMarkup(<CreativeAsset creative={first.creative} name={first.name} />)
    expect(thumbnail).toContain('Video thumbnail')
    expect(thumbnail).not.toContain('<video')
  })
  it('labels a playable configured story-video preview without hiding alternate native identities', () => {
    const creative = { ...first.creative!, videoUrl: 'https://cdn.example.test/story-video.mp4', durationSeconds: 11,
      videoPreviewEvidence: { videoId: '33', basis: 'object_story_spec_video_id' as const },
      identity: { version: 1 as const, basis: 'current_meta_configuration' as const, observedAt: context.asOf,
        structure: 'unknown' as const, completeness: 'observed_fields_only' as const,
        members: [
          { kind: 'video' as const, role: 'media' as const, id: '22', sourcePaths: ['/video_id'] },
          { kind: 'video' as const, role: 'media' as const, id: '33', sourcePaths: ['/object_story_spec/video_data/video_id'] },
        ], unresolvedSourcePaths: ['/object_story_spec/video_data/video_id', '/video_id'] } }
    const html = renderToStaticMarkup(<CreativeAsset creative={creative} name={first.name} />)
    expect(html).toContain('<video')
    expect(html).toContain('Configured story-video preview')
    expect(html).toContain('33')
    expect(html).toContain('alternate video identities')
    expect(html).not.toContain('Playable video not supplied')
  })
  it('ignores inherited-object names passed as metric groups', () => {
    navigation.search = 'group=__proto__'
    expect(renderToStaticMarkup(<AdsReport data={data} />)).toContain('Ad investigation')
    navigation.search = 'group=toString'
    expect(renderToStaticMarkup(<CreativeReport data={data} />)).toContain('Creative performance')
  })
  it('shows matched-date comparison with both audiences, exposure and missing evidence', () => {
    const html = renderToStaticMarkup(<EntityComparison entities={[first, second]} context={context} group="results" />)
    for (const label of ['Studio walkthrough', 'Portrait still', 'Cold', 'Warm', 'Impressions', 'Spend', '2026-09-02', '2026-09-04']) expect(html).toContain(label)
    expect(html).toContain('Unavailable')
    expect(html).not.toMatch(/winner|loser/i)
  })
  it('does not present account trends or placements as ad evidence when detail is absent', () => {
    const html = renderToStaticMarkup(<AdDetail entity={first} context={context} meta={data.meta.data!} />)
    expect(html).toContain('Ad-level daily history is unavailable')
    expect(html).toContain('Ad-level placement detail is unavailable')
    expect(html).toContain('7-day click / 1-day view')
    expect(html).toContain('Book the studio')
    expect(html).toContain('https://example.com/rentals')
  })
  it('surfaces a source/event/date mismatch rather than calling unequal metrics comparable', () => {
    const mismatched = { ...second, metrics: { ...second.metrics, spend: {
      ...second.metrics.spend, event: 'Purchase', current: { ...second.metrics.spend.current,
        window: { ...second.metrics.spend.current.window, start: '2026-08-02' } },
    } } }
    expect(renderToStaticMarkup(<EntityComparison entities={[first, mismatched]} context={context} group="results" />)).toContain('Not directly comparable')
    expect(renderToStaticMarkup(<EntityComparison entities={[first, second]} context={context} group="results" />)).not.toContain('Not directly comparable')
  })
  it('renders supplied ad history and placements without borrowing account totals', () => {
    const entity = { ...first, series: [{ date: '2026-09-02', metrics: { spend: metric('spend', 4, '2026-09-02') } }],
      breakdowns: [{ id: 'ad1-ig', dimension: 'placement' as const, label: 'Instagram Reels', metrics: { spend: metric('spend', 3) } }] }
    const html = renderToStaticMarkup(<AdDetail entity={entity} context={context} meta={data.meta.data!} />)
    expect(html).toContain('Daily values and evidence')
    expect(html).toContain('Instagram Reels')
    expect(html).toContain('$4.00')
    expect(html).toContain('$3.00')
    expect(html).not.toContain('Ad-level daily history is unavailable')
    expect(html).not.toContain('Ad-level placement detail is unavailable')
  })
  it('retains group and scope in the rendered detail return link', () => {
    navigation.search = 'campaign=c1&adset=s1&group=clicks&ad=ad-1&from=2026-09-02&to=2026-09-04'
    const html = renderToStaticMarkup(<AdsReport data={data} />)
    expect(html).toContain('Back to ads')
    expect(html).toContain('href="/ads?campaign=c1&amp;adset=s1&amp;group=clicks&amp;from=2026-09-02&amp;to=2026-09-04"')
    navigation.search = 'campaign=c2&ad=ad-1'
    expect(renderToStaticMarkup(<AdsReport data={data} />)).toContain('Ad not in this view')
  })
  it('does not let missing comparison IDs disable selection of available rows', () => {
    navigation.search = 'compare=not-present,also-missing'
    const html = renderToStaticMarkup(<AdsReport data={data} />)
    expect(html).not.toMatch(/type="checkbox"[^>]*disabled/)
    expect(html).toContain('Select two to four to compare')
    navigation.search = 'compare=ad-1,ad-2&view=compare&campaign=c2'
    expect(renderToStaticMarkup(<AdsReport data={data} />)).toContain('Select two to four entities in the same filtered view')
  })
})
