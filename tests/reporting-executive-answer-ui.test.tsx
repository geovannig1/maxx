import './_support/outcome-noun-booking'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { OverviewReport } from '@/components/reporting/OverviewReport'
import { SavedReportProvider } from '@/components/reporting/SavedReportContext'
import { ReportsReport } from '@/components/reporting/ReportsReport'
import { deriveExpertReview, overviewFindings } from '@/lib/reporting/review'
import type { OpenSavedReportingReportReply } from '@/lib/reporting/saved-contract'
import { executiveFixture } from './reporting-browser/executive-fixture'

const navigation = vi.hoisted(() => ({ search: '', path: '/dashboard' }))
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams(navigation.search),
  usePathname: () => navigation.path, useRouter: () => ({ push: vi.fn() }) }))
beforeEach(() => { navigation.search = ''; navigation.path = '/dashboard' })
const section = (html: string) => html.match(/<section[^>]*aria-label="Executive interpretation"[^>]*>[\s\S]*?<\/section>/)?.[0] ?? ''
const decode = (html: string) => html.replaceAll('&#x27;', "'").replaceAll('&amp;', '&').replaceAll('&quot;', '"')
const observationText = (html: string) => [...html.matchAll(/<p[^>]*data-observation-text[^>]*>([\s\S]*?)<\/p>/g)].map(match => decode(match[1])).join(' ')
const paragraphs = (html: string) => [...html.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/g)]
  .map(match => decode(match[1].replace(/<a\b[^>]*>[\s\S]*?<\/a>/g, '').replace(/<[^>]*>/g, '')).trim())
const links = (html: string) => [...html.matchAll(/href="([^"]+)"/g)].map(match => new URL(decode(match[1]), 'https://maxx.test'))

describe('the executive answer before the result bands', () => {
  it('leads with two supported daily observations and links to the exact dashboard evidence', () => {
    const data = executiveFixture(), review = deriveExpertReview(data)
    const finding = review.findings.find(item => item.id === 'business_platform_trend')!
    const html = renderToStaticMarkup(<OverviewReport data={data} />), opening = section(html)
    expect(opening).not.toBe('')
    const primaryReading = paragraphs(opening.split('</div><aside')[0])
    expect(primaryReading).toHaveLength(2)
    expect(primaryReading[0]).toBe('Meta spend doubled while all-source MER held at 0.23×; Sep 2 supplied 100% of booked value.')
    expect(primaryReading[1]).toContain('Average booking value fell 20% to $100')
    expect(opening).toContain('aria-label="All-source booked value ÷ Meta spend: 0.23×"')
    expect(paragraphs(opening).join(' ')).toContain('0 paid bookings')
    expect(paragraphs(opening).join(' ')).toContain('Meta daily spend is unavailable for a matched calendar comparison')
    expect(paragraphs(opening)).toContain('2026-09-02 supplied $500.00 of $500.00 booked value (100%), with 5 of 5 paid bookings.')
    expect(html.indexOf('aria-label="Executive interpretation"')).toBeLessThan(html.indexOf('aria-label="Business results"'))
    expect(html.indexOf('aria-label="Executive interpretation"')).toBeLessThan(html.indexOf('Creative comparison'))
    expect(links(opening)).toHaveLength(2)
    for (const url of links(opening)) {
      expect(url.hash).toBe('#overview-trends')
      expect(html).toContain(`id="${url.hash.slice(1)}"`)
    }
    navigation.path = '/reports'; navigation.search = 'report=results&review_q=business_platform_trend'
    const full = renderToStaticMarkup(<ReportsReport data={data} />)
    expect(observationText(full)).toBe(finding.observation.text)
    for (const date of ['2026-09-02', '2026-09-04', '2026-08-30', '2026-09-01']) expect(full).toContain(date)
  })

  it('keeps broader highlights reachable in the full Results review, including lower-spend zero-result and favorable members', () => {
    const data = executiveFixture(undefined, undefined, true), review = deriveExpertReview(data)
    const html = renderToStaticMarkup(<OverviewReport data={data} />)
    const highlights = overviewFindings(review).filter(item => item.id !== 'business_platform_trend')
    expect(highlights.some(item => item.zeroOutcomeSpend)).toBe(true)
    expect(highlights.some(item => item.direction === 'improved')).toBe(true)
    expect(html).not.toContain('aria-label="What deserves a closer look"')
    navigation.path = '/reports'
    for (const finding of highlights) {
      navigation.search = new URLSearchParams({ report: 'results', review_q: finding.id }).toString()
      const full = renderToStaticMarkup(<ReportsReport data={data} />)
      expect(full).toContain(`data-review-id="${finding.id}"`)
      expect(observationText(full)).toContain(finding.observation.text)
    }
  })

  it('uses the original saved wording and keeps all inspection links bound to the saved identity', () => {
    const data = executiveFixture(), review = deriveExpertReview(data)
    const original = 'Original period assessment: retain this exact historical interpretation.'
    const saved = { saved: { id: '00000000-0000-4000-8000-000000007009' }, data,
      review: { ...review, findings: review.findings.map(item => item.id === 'business_platform_trend'
        ? { ...item, observation: { ...item.observation, text: original } } : item) } } as OpenSavedReportingReportReply
    const html = section(renderToStaticMarkup(<SavedReportProvider value={saved}><OverviewReport data={data} /></SavedReportProvider>))
    expect(html).toContain(original)
    expect(decode(html)).not.toContain(review.findings.find(item => item.id === 'business_platform_trend')!.observation.text)
    expect(links(html)).toHaveLength(2)
    for (const url of links(html)) {
      expect(url.searchParams.get('saved')).toBe(saved.saved.id)
      expect(url.searchParams.get('account')).toBe(data.context.account.id)
      expect(url.searchParams.get('from')).toBe(data.context.range.from)
      expect(url.searchParams.get('to')).toBe(data.context.range.to)
    }
    navigation.path = '/reports'; navigation.search = 'report=results&review_q=business_platform_trend'
    const full = renderToStaticMarkup(<SavedReportProvider value={saved}><ReportsReport data={data} /></SavedReportProvider>)
    expect(observationText(full)).toBe(original)
  })

  it('does not fabricate an opening assessment absent from the saved review', () => {
    const data = executiveFixture(), review = deriveExpertReview(data)
    const saved = { saved: { id: '00000000-0000-4000-8000-000000007009' }, data,
      review: { ...review, findings: review.findings.filter(item => item.id !== 'business_platform_trend') } } as OpenSavedReportingReportReply
    const opening = section(renderToStaticMarkup(<SavedReportProvider value={saved}><OverviewReport data={data} /></SavedReportProvider>))
    expect(opening).toContain('This assessment was not included in the saved report.')
    expect(decode(opening)).not.toContain(review.findings.find(item => item.id === 'business_platform_trend')!.observation.text)
  })

  it('keeps the existing embedded Results view free of a duplicate opening review', () => {
    const html = renderToStaticMarkup(<OverviewReport data={executiveFixture()} showFindings={false} />)
    expect(section(html)).toBe('')
    expect(html).toContain('aria-label="All-source booked value ÷ Meta spend: 0.23×"')
    expect(html.match(/aria-label="All-source booked value ÷ Meta spend:/g)).toHaveLength(1)
    expect(html).toContain('aria-label="Advertising results"')
    expect(html).toContain('aria-label="Campaign and ad-set comparison"')

    const dashboard = renderToStaticMarkup(<OverviewReport data={executiveFixture()} />)
    expect(section(dashboard)).not.toBe('')
    expect(dashboard.match(/aria-label="All-source booked value ÷ Meta spend:/g)).toHaveLength(1)
  })
})
