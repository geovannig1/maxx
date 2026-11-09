import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { AdsReport } from '@/components/reporting/AdsReport'
import { CreativeReport } from '@/components/reporting/CreativeReport'
import { ExpertReviewPanel, reviewControlHref } from '@/components/reporting/ExpertReviewPanel'
import { SavedReportProvider } from '@/components/reporting/SavedReportContext'
import { SavedViewSchema, type OpenSavedReportingReportReply } from '@/lib/reporting/saved-contract'
import { deriveExpertReview } from '@/lib/reporting/review'
import { creativeReportingFixture } from './reporting-browser/creative-fixture'

const navigation = vi.hoisted(() => ({ search: 'level=ad&ad=301', pathname: '/creative' }))
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams(navigation.search), usePathname: () => navigation.pathname }))
beforeEach(() => { navigation.search = 'level=ad&ad=301'; navigation.pathname = '/creative' })
const ids = (html: string) => [...html.matchAll(/data-review-id="([^"]+)"/g)].map(match => match[1])
const decode = (text: string) => text.replaceAll('&amp;', '&').replaceAll('&#x27;', "'").replaceAll('&quot;', '"')
const links = (html: string) => [...html.matchAll(/href="([^"]+)"/g)].map(match => new URL(decode(match[1]), 'https://maxx.test'))

describe('complete prepared review at the exact ad', () => {
  it.each(['/creative', '/performance'])('carries all exact-ad findings into %s before the raw metrics', path => {
    navigation.pathname = path
    const data = creativeReportingFixture(), review = deriveExpertReview(data)
    const expected = review.findings.filter(item => item.entity?.level === 'ad' && item.entity.id === '301')
    expect(expected.length).toBeGreaterThan(2)
    const html = renderToStaticMarkup(path === '/creative' ? <CreativeReport data={data} /> : <AdsReport data={data} />)
    expect(ids(html).sort()).toEqual(expected.map(item => item.id).sort())
    for (const item of expected) {
      const article = html.split(`data-review-id="${item.id}"`)[1].split('</article>')[0]
      const text = [...article.matchAll(/<p[^>]*data-observation-text[^>]*>([\s\S]*?)<\/p>/g)].map(match => decode(match[1])).join(' ')
      expect(text).toBe(item.observation.text)
    }
    expect(html.indexOf('data-ad-review')).toBeGreaterThan(0)
    expect(html.indexOf('data-ad-review')).toBeLessThan(html.indexOf('id="ad-metrics"'))
    const full = links(html).find(url => url.searchParams.get('review_entity') === 'ad:301')!
    expect(full.pathname).toBe('/reports'); expect(full.searchParams.get('report')).toBe('results')
    expect(full.hash).toBe('#full-assessments')
    const website = links(html).find(url => url.searchParams.get('report') === 'website')!
    expect(website.searchParams.get('from')).toBe(data.context.range.from)
    expect(website.searchParams.has('ad')).toBe(false)
    expect(html).toContain('not attributed to this ad')
    expect(links(html).some(url => url.hash === '#ad-metrics' && url.searchParams.get('ad') === '301')).toBe(true)
  })

  it('keeps original saved findings including an unfamiliar family and does not derive a missing historical answer', () => {
    const data = creativeReportingFixture(), original = deriveExpertReview(data)
    const finding = original.findings.find(item => item.entity?.level === 'ad' && item.entity.id === '301')!
    const saved: OpenSavedReportingReportReply = {
      saved: { id: '00000000-0000-4000-8000-000000007012' } as OpenSavedReportingReportReply['saved'], data, notes: [],
      review: { ...original, findings: [{ ...finding, id: 'historical-special', observation: { text: 'Original historical answer.', evidence: [] } }] } }
    const html = renderToStaticMarkup(<SavedReportProvider value={saved}><CreativeReport data={data} /></SavedReportProvider>)
    expect(ids(html)).toEqual(['historical-special'])
    expect(html).toContain('Original historical answer.')
    for (const url of links(html).filter(url => url.searchParams.has('report') || url.hash === '#ad-metrics')) expect(url.searchParams.get('saved')).toBe(saved.saved.id)
    const missing = renderToStaticMarkup(<SavedReportProvider value={{ ...saved, review: { ...saved.review, findings: [] } }}><CreativeReport data={data} /></SavedReportProvider>)
    expect(ids(missing)).toEqual([])
    expect(missing).toContain('No ad-specific assessments were included in this saved report.')
  })

  it('filters exact level and identity instead of names, prefixes or text mentions', () => {
    const review = deriveExpertReview(creativeReportingFixture())
    const base = review.findings.find(item => item.entity?.level === 'ad' && item.entity.id === '301')!
    const data = { ...review, findings: [base,
      { ...base, id: 'prefix', entity: { ...base.entity!, id: '3010' } },
      { ...base, id: 'wrong-level', entity: { ...base.entity!, level: 'adset' as const } },
      { ...base, id: 'text-mention', entity: undefined }] }
    navigation.search = 'review_entity=ad%3A301'
    expect(ids(renderToStaticMarkup(<ExpertReviewPanel review={data} expanded />))).toEqual([base.id])
    navigation.search += '&review_area=coverage'
    expect(ids(renderToStaticMarkup(<ExpertReviewPanel review={data} expanded />))).toEqual([])
    navigation.search = 'review_entity=ad%3Aunknown'
    expect(renderToStaticMarkup(<ExpertReviewPanel review={data} expanded />)).toContain('No assessments match')
    const href = reviewControlHref('/reports', 'saved=original&review_entity=ad%3A301&review_page=4', '#full-assessments', { review_entity: null })
    expect(href).toBe('/reports?saved=original#full-assessments')
    expect(SavedViewSchema.safeParse({ pathname: '/reports', hash: '#full-assessments', query: { review_entity: 'ad:301', report: 'results' } }).success).toBe(true)
    expect(SavedViewSchema.safeParse({ pathname: '/reports', query: { made_up_filter: '301' } }).success).toBe(false)
  })
})
