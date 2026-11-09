import './_support/outcome-noun-booking'
import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { EntityComparison } from '@/components/reporting/EntityComparison'
import { CreativeReport } from '@/components/reporting/CreativeReport'
import { AdDetail } from '@/components/reporting/AdDetail'
import { creativeRetention } from '@/lib/reporting/creative-retention'
import { validateReportingPacket } from '@/lib/reporting/validation'
import { InvestigationExport, comparisonMetricKeys } from '@/components/reporting/MetricTable'
import * as reportExport from '@/lib/reporting/export'
import { creativeAd, creativeContext, creativeData } from './fixtures/reporting-creative'

const navigation = vi.hoisted(() => ({ search: '', pathname: '/creative' }))
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(navigation.search), usePathname: () => navigation.pathname,
}))
function video(id: string, length: number, starts: number, quarter: number, half: number) {
  const ad = creativeAd(id, {
    spend: '30', impressions: '500',
    video_play_actions: [{ action_type: 'video_view', value: String(starts) }],
    video_p25_watched_actions: [{ action_type: 'video_view', value: String(quarter) }],
    video_p50_watched_actions: [{ action_type: 'video_view', value: String(half) }],
    video_p75_watched_actions: [{ action_type: 'video_view', value: '0' }],
  })
  return { ...ad, creative: { ...ad.creative!, durationSeconds: length } }
}

describe('creative retention investigation', () => {
  it.each(['attention', 'engagement', 'clicks', 'results'] as const)('retains native ROAS inputs and prior values in %s comparison and CSV', group => {
    const ads = ['301', '302', '303', '304'].map(id => creativeAd(id, {
      spend: '100', actions: [{ action_type: 'purchase', value: '1' }], action_values: [{ action_type: 'purchase', value: '300' }],
    }, {
      spend: '100', actions: [{ action_type: 'purchase', value: '1' }], action_values: [{ action_type: 'purchase', value: '200' }],
    }))
    const html = renderToStaticMarkup(<EntityComparison entities={ads} context={creativeContext} group={group} />)
    expect(html).toContain('3.00×')
    expect(html).toMatch(/<th scope="row"[^>]*>Reported purchase value<\/th>/)
    expect(html).toMatch(/<th scope="row"[^>]*>Reported purchases<\/th>/)
    expect(html).toMatch(/<th scope="row"[^>]*>Reported booking value<\/th>/)
    const download = vi.spyOn(reportExport, 'downloadReportCsv').mockImplementation(() => {})
    try {
      InvestigationExport({ entities: ads, group, context: creativeContext, filename: 'comparison', extraKeys: comparisonMetricKeys(group) }).props.onClick()
      const rows = download.mock.calls.at(-1)![0]
      for (const ad of ads) expect(rows.some(row => row.entity.includes(ad.id) && row.metric === 'Reported purchase value' && row.value === 300 && row.previous_value === 200)).toBe(true)
    } finally { download.mockRestore() }
  })

  it.each(['definition', 'future observation', 'foreign denominator', 'foreign native pair'] as const)('withholds %s without suppressing a healthy execution', defect => {
    const ads = structuredClone([video('301', 8, 100, 80, 40), video('302', 60, 100, 80, 40)])
    const bad = ads[0]
    if (defect === 'definition') {
      bad.metrics.retention_p25.definition = '25% watches / unique viewers × 100; a different population.'
      bad.metrics.retention_p25.current.formula = bad.metrics.retention_p25.definition
      bad.metrics.retention_p25.previous!.formula = bad.metrics.retention_p25.definition
    } else if (defect === 'future observation') {
      for (const key of ['video_plays', 'watch_p25', 'retention_p25']) {
        bad.metrics[key].current.asOf = '2026-09-05T17:00:00.000000001Z'
        bad.metrics[key].current.freshness.observedAt = bad.metrics[key].current.asOf
        if (!key.startsWith('retention_')) bad.metrics[key].current.source.head = `meta-live:${creativeContext.account.metaAccountId}:${bad.metrics[key].current.asOf}`
      }
    } else {
      bad.metrics.video_plays.current.source.head = `meta-live:act_foreign:${creativeContext.asOf}`
      if (defect === 'foreign native pair') bad.metrics.watch_p25.current.source.head = bad.metrics.video_plays.current.source.head
    }
    const data = creativeData(ads)
    expect(() => validateReportingPacket({ section: 'meta', context: data.context, result: data.meta, notes: [] })).not.toThrow()
    const rows = creativeRetention(ads, creativeContext)
    expect(rows[0].points[0].value).toBeNull()
    expect(rows[1].points[0].value).toBe(80)
  })

  it('keeps valid earlier Meta evidence when another source advances the combined report time', () => {
    const rows = creativeRetention([video('301', 8, 100, 80, 40), video('302', 60, 100, 80, 40)], {
      ...creativeContext, asOf: '2026-09-05T18:00:00.000Z',
    })
    expect(rows.map(row => row.points[0].value)).toEqual([80, 80])
  })

  it('does not identify the currently displayed video as the historical watched asset', () => {
    const ad = video('301', 8, 100, 80, 40)
    const html = renderToStaticMarkup(<AdDetail entity={ad} context={creativeContext} meta={creativeData([ad]).meta.data!} />)
    expect(html).not.toContain('share of this video’s length')
    expect(html).toContain('historical media')
  })
  it('lets the owner add a third and fourth execution through the visible controls', () => {
    const ads = [video('301', 8, 100, 80, 40), video('302', 60, 200, 100, 60), video('303', 20, 50, 25, 10), video('304', 90, 40, 30, 20)]
    navigation.search = 'compare=301,302&group=attention'
    const html = renderToStaticMarkup(<CreativeReport data={creativeData(ads)} />)
    const third = html.match(/<input[^>]*aria-label="Compare Ad 303"[^>]*>/)?.[0]
    expect(third).toBeDefined()
    expect(third).not.toContain('disabled')
    expect(html).toContain('>Engagement</button>')
  })

  it('warns when the fourth execution uses a different metric definition', () => {
    const ads = structuredClone(['301', '302', '303', '304'].map(id => video(id, 20, 100, 80, 40)))
    ads[3].metrics.spend.current.definitionVersion = 2
    const html = renderToStaticMarkup(<EntityComparison entities={ads} context={creativeContext} group="results" />)
    expect(html).toContain('Not directly comparable')
  })

  it('compares four selected executions without silently dropping the third and fourth', () => {
    const ads = [video('301', 8, 100, 80, 40), video('302', 60, 200, 100, 60), video('303', 20, 50, 25, 10), video('304', 90, 40, 30, 20)]
    navigation.search = 'view=compare&compare=301,302,303,304&group=attention'
    const html = renderToStaticMarkup(<CreativeReport data={creativeData(ads)} />)
    for (const id of ['301', '302', '303', '304']) expect(html).toContain(`Ad ${id}`)
    expect(html).toContain('Video retention comparison')
  })

  it('keeps native milestone denominators and current preview durations distinct for short and long cuts', () => {
    const html = renderToStaticMarkup(<EntityComparison entities={[video('301', 8, 100, 80, 40), video('302', 60, 200, 100, 60)]} context={creativeContext} group="attention" />)
    expect(html).toContain('Video retention comparison')
    expect(html).toContain('80 / 100 starts')
    expect(html).toContain('100 / 200 starts')
    expect(html).toContain('Current preview: 8 seconds')
    expect(html).toContain('Current preview: 60 seconds')
    expect(html).not.toContain('3-second views')
    expect(html).not.toContain('the 25% point is')
  })

  it('does not plot a supplied percentage that contradicts the underlying native counts', () => {
    const ad = video('301', 8, 100, 80, 40)
    const bad = structuredClone(ad)
    bad.metrics.retention_p25.current.value = 99
    const html = renderToStaticMarkup(<EntityComparison entities={[bad, video('302', 60, 200, 100, 60)]} context={creativeContext} group="attention" />)
    expect(html).toContain('Milestone comparison unavailable')
    expect(html).toContain('80 / 100 starts')
    expect(html).not.toContain('data-retention-value="99"')
    expect(html).toContain('data-retention-value="50"')
  })

  it('preserves measured zero milestones and shows missing milestones without drawing a zero', () => {
    const html = renderToStaticMarkup(<EntityComparison entities={[video('301', 8, 100, 80, 40), video('302', 60, 200, 100, 60)]} context={creativeContext} group="attention" />)
    expect(html).toContain('data-retention-value="0"')
    expect(html).toContain('100% milestone unavailable')
    expect(html).toContain('0 / 100 starts')
  })
})
