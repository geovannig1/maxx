import './_support/outcome-noun-booking'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { ExpertReviewPanel, reviewControlHref, subscribeReviewPrint } from '@/components/reporting/ExpertReviewPanel'
import { PLAYBOOK_VERSION, type ExpertReportReview, type ReviewFinding } from '@/lib/reporting/review/contracts'
import { snapshotContext as context } from './fixtures/reporting-snapshot'
import { customerReportingFixture } from './reporting-browser/customer-fixture'
import { deriveExpertReview } from '@/lib/reporting/review'
import { findingEvidence, verifyFindingReferences } from '@/lib/reporting/review/evidence'

const navigation = vi.hoisted(() => ({ search: null as string | null, pathname: null as string | null }))
vi.mock('next/navigation', () => ({
  useSearchParams: () => navigation.search === null ? null : new URLSearchParams(navigation.search),
  usePathname: () => navigation.pathname,
}))

// Fictional assessments isolate review navigation from changing diagnostic rules.
function assessment(index: number): ReviewFinding {
  const id = `execution-${index}`, late = index === 44
  return { id, area: index > 30 ? 'creative' : 'advertising', title: late ? 'Late creative divergence' : `Assessment ${index}`,
    status: 'observed', priority: [7, 22, 44].includes(index) ? 'investigate' : 'context',
    entity: { id, name: `Entity ${index}`, level: index <= 15 ? 'campaign' : index <= 30 ? 'adset' : 'ad' },
    observation: { text: `Native observation for ${id}`, evidence: [] },
    materiality: { text: `Exposure for ${id}`, evidence: [], priorityReason: 'Native exposure' },
    explanations: [{ hypothesis: `Possible explanation for ${id}`, evidence: [], missing: ['Matched exposure'] }],
    counterEvidence: { text: 'Delivery composition may explain the observation.', evidence: [] },
    nextInspection: { question: `Inspect ${id}`, href: `/performance?ad=${id}&from=${context.range.from}&to=${context.range.to}`,
      outcomes: [{ result: 'The source confirms the observation.', interpretation: 'Inspect matched exposure.' }] },
    limitations: ['These observations are not causal.'], exposure: null, authority: { state: 'diagnostic', executable: false } }
}
function review(): ExpertReportReview {
  return { contractVersion: 'report_review.v1', playbookVersion: PLAYBOOK_VERSION, context,
    input: { kind: 'validated-report-view', snapshotBinding: 'not_attached', rejectedSources: [] },
    businessContext: { status: 'not_loaded', versionId: null, approvalId: null },
    findings: Array.from({ length: 45 }, (_, index) => assessment(index + 1)),
    populationCoverage: [
      { family: 'Performance', level: 'campaign', supplied: 15, evaluated: 14, limited: 1 },
      { family: 'Performance', level: 'adset', supplied: 15, evaluated: 15, limited: 0 },
      { family: 'Creative', level: 'ad', supplied: 15, evaluated: 13, limited: 2 },
    ] }
}
const ids = (html: string) => [...html.matchAll(/data-review-id="([^"]+)"/g)].map(match => match[1])
const coverageRows = (html: string) => [...(html.match(/<table[^>]*aria-label="Review coverage"[^>]*>(.*?)<\/table>/)?.[1] ?? '')
  .matchAll(/<tr[^>]*>(.*?)<\/tr>/g)].map(match => match[1].replaceAll(/<[^>]*>/g, ' ').trim().replaceAll(/\s+/g, ' '))
const render = (data = review()) => renderToStaticMarkup(<ExpertReviewPanel review={data} expanded />)
beforeEach(() => { navigation.search = null; navigation.pathname = null })

describe('full assessment navigation', () => {
  it.each(['current', 'prior'] as const)('does not display a semantically rejected customer %s period as supporting evidence', period => {
    const data = structuredClone(customerReportingFixture())
    const metric = data.business.data!.intelligence!.customers.data!.groups[0].metrics.booked_value
    if (period === 'current') metric.current.value = 0
    else metric.previous!.value = 0
    const prepared = deriveExpertReview(data), customer = prepared.findings.find(finding => finding.id === 'business_customers')!
    expect(prepared.input.rejectedSources).not.toContain('business')
    expect(customer.observation.text).toMatch(period === 'current' ? /Prior booking.*unavailable.*prior \$1,000/ : /Prior booking.*\$200.*prior unavailable/)
    const ref = findingEvidence(customer).find(ref => ref.path.endsWith('/groups/0/metrics/booked_value'))!
    expect(ref.metric).toEqual(metric)
    expect(() => verifyFindingReferences(data, customer)).not.toThrow()
    const html = render({ ...prepared, findings: [customer] })
    const card = html.split('data-evidence-population=').find(part => part.startsWith(`"${metric.current.entity.id}"`) && part.includes(' · Booked value</p>'))!
    expect(card).toBeDefined()
    expect(card).not.toContain('$0.00')
    expect(card).toContain(period === 'current' ? '$1,000.00' : '$200.00')
    expect(card).toContain(period === 'current' ? 'Prior-period evidence' : 'Selected-period evidence')
    if (period === 'current') expect(card).toContain('Selected-period value withheld')
  })

  it('renders a bounded first page with nullable SSR hooks and meaningful coverage', () => {
    const html = render()
    expect(ids(html)).toHaveLength(20)
    expect(ids(html)[0]).toBe('execution-1')
    expect(ids(html).at(-1)).toBe('execution-20')
    expect(html).toContain('45 matching of 45 assessments')
    expect(html).toContain('Search assessments')
    expect(html).toContain('Review coverage')
    expect(html).toContain('Supplied')
    expect(html).toContain('Evaluated')
    expect(html).toContain('Limited')
    expect(coverageRows(html)).toEqual(['Family Level Supplied Evaluated Limited', 'Performance Campaign 15 14 1', 'Performance Ad set 15 15 0', 'Creative Ad 15 13 2'])
    expect(html).toMatch(/at least one.*check/i)
    expect(html).not.toContain('Every reporting check')
  })

  it('exposes every remaining assessment through consecutive URL pages', () => {
    const seen: string[] = []
    for (const page of [1, 2, 3]) {
      navigation.search = `review_page=${page}`
      const html = render()
      seen.push(...ids(html))
      expect(html).toContain(`Page ${page} of 3`)
    }
    expect(seen).toEqual(Array.from({ length: 45 }, (_, index) => `execution-${index + 1}`))
    expect(new Set(seen).size).toBe(45)
  })

  it('searches beyond the current page and combines area, level and investigation filters', () => {
    navigation.search = 'review_q=late&review_area=creative&review_level=ad&review_filter=investigate&review_page=3'
    const matched = render()
    expect(ids(matched)).toEqual(['execution-44'])
    expect(matched).toContain('1 matching of 45 assessments')
    expect(matched).toContain('Page 1 of 1')
    expect(matched).toContain('ad=execution-44')
    expect(matched).toContain('Possible explanation for execution-44')
    expect(coverageRows(matched)).toContain('Creative Ad 15 13 2')
    navigation.search = 'review_q=late&review_area=advertising&review_filter=investigate'
    const contradicted = render()
    expect(ids(contradicted)).toEqual([])
    expect(contradicted).toContain('No assessments match')
    expect(contradicted).toContain('Clear assessment filters')
  })

  it('uses exact entity ID search and makes descriptive assessments available outside investigations', () => {
    navigation.search = 'review_q=execution-43'
    expect(ids(render())).toEqual(['execution-43'])
    navigation.search += '&review_filter=investigate'
    expect(ids(render())).toEqual([])
    navigation.search = 'review_level=adset&review_filter=investigate'
    expect(ids(render())).toEqual(['execution-22'])
    navigation.search = 'review_level=campaign&review_filter=investigate'
    expect(ids(render())).toEqual(['execution-7'])
  })

  it.each(['-2', 'no-page', 'Infinity', '1.5'])('rejects invalid page %s without hiding the first page', page => {
    navigation.search = `review_page=${page}`
    expect(ids(render())[0]).toBe('execution-1')
  })

  it('preserves account/date/report/hash state while changing filters and resetting only review pagination', () => {
    const href = reviewControlHref('/reports', 'account=studio&from=2026-09-02&to=2026-09-04&report=website&q=ad-copy&review_page=3', '#website-journey',
      { review_q: 'late', review_area: 'creative' })
    const url = new URL(href, 'https://maxx.test')
    expect(url.pathname).toBe('/reports')
    expect(url.hash).toBe('#website-journey')
    expect(Object.fromEntries(url.searchParams)).toEqual({ account: 'studio', from: '2026-09-02', to: '2026-09-04',
      report: 'website', q: 'ad-copy', review_q: 'late', review_area: 'creative' })
    navigation.search = url.search
    expect(ids(render())).toEqual(['execution-44'])
    const cleared = new URL(reviewControlHref(url.pathname, url.search, url.hash,
      { review_q: null, review_area: null, review_level: null, review_filter: null }), url.origin)
    expect(cleared.searchParams.has('review_page')).toBe(false)
    expect(cleared.searchParams.get('q')).toBe('ad-copy')
    expect(cleared.searchParams.get('report')).toBe('website')
    expect(cleared.hash).toBe('#website-journey')
    navigation.search = cleared.search
    expect(ids(render())).toHaveLength(20)
    const next = new URL(reviewControlHref(cleared.pathname, cleared.search, cleared.hash, { review_page: '2' }), url.origin)
    navigation.search = next.search
    expect(ids(render())[0]).toBe('execution-21')
  })

  it('labels overview highlights as a subset with a full-review destination and keeps legacy coverage optional', () => {
    const data = review()
    const overview = renderToStaticMarkup(<ExpertReviewPanel review={data} />)
    expect(ids(overview).length).toBeLessThan(data.findings.length)
    expect(overview).toMatch(/highlights.*subset/i)
    expect(overview).toContain('See all assessments')
    expect(overview).not.toContain('Search assessments')
    expect(() => render({ ...data, populationCoverage: undefined })).not.toThrow()
  })

  it('prepares printing synchronously and restores pagination afterward without leaking listeners', () => {
    const target = new EventTarget()
    let printing = false
    const stop = subscribeReviewPrint(target, value => { printing = value })
    target.dispatchEvent(new Event('beforeprint'))
    expect(printing).toBe(true)
    target.dispatchEvent(new Event('afterprint'))
    expect(printing).toBe(false)
    stop()
    target.dispatchEvent(new Event('beforeprint'))
    expect(printing).toBe(false)
  })
})
