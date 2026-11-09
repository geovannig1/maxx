import './_support/outcome-noun-booking'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { validateReportingPacket } from '@/lib/reporting/validation'
import { OverviewReport } from '@/components/reporting/OverviewReport'
import { BusinessDetailReport } from '@/components/reporting/BusinessDetailReport'
import { ExpertReviewPanel } from '@/components/reporting/ExpertReviewPanel'
import { WebsiteJourney } from '@/components/reporting/WebsiteJourney'
import { ReportsReport, reportPresetFromSearch } from '@/components/reporting/ReportsReport'
import { deriveExpertReview, overviewFindings } from '@/lib/reporting/review'
import { verifyFindingReferences } from '@/lib/reporting/review/evidence'
import { ReportMetricValue } from '@/components/reporting/MetricValue'
import { fixturePacket, reportingFixture } from '../scripts/demo/sample/reports'

const navigation = vi.hoisted(() => ({ search: '', path: '/dashboard' }))
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams(navigation.search),
  usePathname: () => navigation.path, useRouter: () => ({ push: vi.fn() }) }))
beforeEach(() => { navigation.search = ''; navigation.path = '/dashboard' })

describe('expert review owner workflow', () => {
  it('uses semantically valid sample data in all four source lanes', () => {
    for (const section of ['meta', 'business', 'website', 'measurement']) {
      expect(() => validateReportingPacket(fixturePacket(section, '2026-09-02', '2026-09-04')), section).not.toThrow()
    }
  })
  it('uses the prepared assessment before results when daily evidence is absent, retaining the full reasoning in Results', () => {
    const original = reportingFixture()
    const data = { ...original, business: { ...original.business, data: { ...original.business.data!, series: [] } } }
    const html = renderToStaticMarkup(<OverviewReport data={data} />)
    const reading = html.match(/<section[^>]*aria-label="Executive interpretation"[^>]*>[\s\S]*?<\/section>/)?.[0] ?? ''
    expect(reading).not.toBe('')
    expect(reading.split('<details')[0].match(/<p\b/g)).toHaveLength(2)
    expect(reading).toContain('Outcomes, all sources:')
    expect(html.indexOf('aria-label="Executive interpretation"')).toBeLessThan(html.indexOf('aria-label="Business results"'))
    expect(html.indexOf('aria-label="Executive interpretation"')).toBeLessThan(html.indexOf('Creative comparison'))
    const targets = [...reading.matchAll(/href="([^"]+)"/g)].map(match => new URL(match[1].replaceAll('&amp;', '&'), 'https://maxx.test'))
    expect(targets).toHaveLength(2)
    for (const target of targets) {
      expect(target.searchParams.get('from')).toBe(data.context.range.from)
      expect(target.searchParams.get('to')).toBe(data.context.range.to)
      expect(target.pathname).toBe('/reports')
      navigation.path = target.pathname; navigation.search = target.search
      expect(renderToStaticMarkup(<ReportsReport data={data} />)).toContain(`id="${target.hash.slice(1)}"`)
    }
    navigation.path = '/reports'; navigation.search = 'report=results&review_q=business_platform_trend'
    const full = renderToStaticMarkup(<ReportsReport data={data} />)
    expect(full).toContain('Why it matters')
    expect(full).toContain('Possible explanations')
    expect(full).toContain('What could change this interpretation')
    expect(full).toContain('Evidence and limits')
    expect(full).not.toContain('Largest matched relative change')
  })
  it('preserves the baseline questions while adding population assessments with verifiable references', () => {
    const data = reportingFixture()
    const review = deriveExpertReview(data)
    expect(review.findings.map(finding => finding.id)).toEqual(expect.arrayContaining([
      'business_platform_trend', 'business_payment_coverage', 'business_type_contribution',
      'advertising.allocation', 'advertising.attribution', 'creative_attention', 'creative_landing',
      'journey.ga4.matched_pair', 'journey.ga4.event_telemetry', 'journey.measurement.association_transport', 'review.coverage',
    ]))
    expect(review.findings.filter(finding => finding.id.startsWith('performance:')).map(finding => finding.entity?.id).sort()).toEqual(['ad-1', 'ad-2', 'campaign-1', 'set-1'])
    expect(review.input.rejectedSources).toEqual([])
    expect(review.businessContext.status).toBe('not_loaded')
    expect(review.input.snapshotBinding).toBe('not_attached')
    expect(new Set(overviewFindings(review).map(f => f.area))).toEqual(new Set(['business', 'advertising', 'creative', 'website', 'measurement']))
    for (const finding of review.findings) {
      expect(() => verifyFindingReferences(data, finding), finding.id).not.toThrow()
      expect(finding.observation.text, finding.id).not.toContain('could not be validated')
      expect(finding.authority).toEqual({ state: 'diagnostic', executable: false })
    }
  })
  it('withholds a wrong-window source without losing valid independent observations', () => {
    const data = reportingFixture()
    const before = deriveExpertReview(data)
    const wrong = structuredClone(data)
    wrong.website.data!.metrics.sessions.current.window.start = '2026-08-01'
    const after = deriveExpertReview(wrong)
    expect(after.input.rejectedSources).toEqual(['website'])
    expect(after.findings.filter(f => f.area === 'website').every(f => f.status === 'unavailable')).toBe(true)
    expect(after.findings.filter(f => f.area === 'business')).toEqual(before.findings.filter(f => f.area === 'business'))
    expect(after.findings.filter(f => f.area === 'advertising')).toEqual(before.findings.filter(f => f.area === 'advertising'))
    const changedAccount = { ...data, context: { ...data.context, account: { ...data.context.account, id: 'different-account' } } }
    expect(deriveExpertReview(changedAccount).input.rejectedSources.sort()).toEqual(['business', 'measurement', 'meta', 'website'])
  })
  it('summarizes large partial-source qualification sets without discarding their source detail', () => {
    const data = reportingFixture()
    const uniqueNotes = Array.from({ length: 24 }, (_, index) => `Private qualification ${index + 1}.`)
    data.meta = { ...data.meta!, state: 'partial', notes: [...uniqueNotes, uniqueNotes[0]] }

    const coverage = deriveExpertReview(data).findings.find(finding => finding.id === 'review.coverage')!
    expect(coverage.observation.text).toContain('Meta: partial. 24 source qualifications are available in Meta source details.')
    expect(coverage.observation.text).not.toContain('Private qualification')
    expect(data.meta.notes).toEqual([...uniqueNotes, uniqueNotes[0]])
  })
  it('keeps a directly useful failure reason when a source is unavailable', () => {
    const data = reportingFixture()
    data.measurement = { state: 'unavailable', data: null, asOf: null, notes: ['Credential scope rejected.'] }

    const coverage = deriveExpertReview(data).findings.find(finding => finding.id === 'review.coverage')!
    expect(coverage.observation.text).toContain('Paid association and CAPI: unavailable. Credential scope rejected.')
  })
  it('takes website and business investigations to real report sections with the selected dates', () => {
    const data = reportingFixture()
    const review = deriveExpertReview(data)
    const webHtml = renderToStaticMarkup(<WebsiteJourney data={data} />)
    const businessHtml = renderToStaticMarkup(<BusinessDetailReport data={data} />)
    for (const finding of review.findings.filter(f => f.area === 'website' || f.area === 'measurement' || f.area === 'business')) {
      const url = new URL(finding.nextInspection.href, 'https://maxx.test')
      const preset = reportPresetFromSearch(url.search)
      if (finding.status !== 'unavailable') {
        expect(preset).toBe(finding.area === 'business' ? 'business' : 'website')
        expect(url.hash).not.toBe('')
        expect(finding.area === 'business' ? businessHtml : webHtml).toContain(`id="${url.hash.slice(1)}"`)
      }
      expect(url.searchParams.get('from')).toBe(data.context.range.from)
      expect(url.searchParams.get('to')).toBe(data.context.range.to)
    }
    const attention = review.findings.find(finding => finding.id === 'creative_attention')!
    expect(new URL(attention.nextInspection.href, 'https://maxx.test').searchParams.get('group')).toBe('attention')
  })
  it('labels repeated evidence metrics with their actual populations and source time basis', () => {
    const review = deriveExpertReview(reportingFixture())
    const html = renderToStaticMarkup(<ExpertReviewPanel review={review} expanded />)
    expect(html).toContain('data-evidence-population="ad-1"')
    expect(html).toContain('data-evidence-population="ad-2"')
    expect(html).toContain('ad: Studio walkthrough')
    expect(html).toContain('ad: Portrait still')
    expect(html).toContain('/studio-rentals · mobile · Paid Social')
    expect(html).toContain('/studio-rentals · desktop · Paid Social')
    expect(html).toContain('Impression dates')
    expect(html).toContain('Booking creation dates')
  })
  it('does not reintroduce unsupported prior values through evidence disclosures', () => {
    const data = reportingFixture()
    const metric = data.meta.data!.metrics.spend
    const tampered = { ...metric, previous: { ...metric.previous!, value: 987654321 } }
    for (const compact of [true, false]) {
      const hidden = renderToStaticMarkup(<ReportMetricValue metric={tampered} compact={compact} comparison={false} />)
      expect(hidden).not.toContain('987,654,321')
      expect(hidden).not.toContain('Comparison')
      expect(renderToStaticMarkup(<ReportMetricValue metric={tampered} compact={compact} />)).toContain('987,654,321')
    }
    const review = deriveExpertReview(data)
    const changed = { ...review, findings: review.findings.map(finding => ({ ...finding,
      observation: { ...finding.observation, evidence: finding.observation.evidence.map(ref => ({ ...ref,
        metric: ref.metric.previous ? { ...ref.metric, previous: { ...ref.metric.previous, value: 987654321 } } : ref.metric,
      })) }, materiality: { ...finding.materiality, evidence: [] }, explanations: [], counterEvidence: { ...finding.counterEvidence, evidence: [] }, exposure: null,
    })) }
    expect(renderToStaticMarkup(<ExpertReviewPanel review={changed} expanded />)).not.toContain('987,654,321')
  })
})
