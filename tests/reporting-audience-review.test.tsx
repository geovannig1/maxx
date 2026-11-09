import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { deriveExpertReview, overviewFindings } from '@/lib/reporting/review'
import { verifyFindingReferences } from '@/lib/reporting/review/evidence'
import { AudienceReport } from '@/components/reporting/AudienceReport'
import { collectReportExportRows } from '@/components/reporting/ReportsReport'
import { ExpertReviewPanel } from '@/components/reporting/ExpertReviewPanel'
import { ReportingDataSchema } from '@/lib/reporting/contracts'
import { audienceReportingFixture } from './reporting-browser/audience-fixture'

describe('owner audience readiness workflow', () => {
  it('keeps large Meta qualification sets complete but collapsed behind one counted disclosure', () => {
    const data = audienceReportingFixture()
    const notes = Array.from({ length: 25 }, (_, index) => `Audience qualification ${index + 1}`)
    data.meta.state = 'partial'
    data.meta.notes = [...notes, notes[0]]
    const html = renderToStaticMarkup(<AudienceReport data={data} />)
    expect(html).toContain('Review 25 Meta source qualifications')
    expect(html.match(/>Audience qualification 1<\/p>/g)).toHaveLength(1)
    expect(html).toContain('Audience qualification 25')
    expect(html).not.toContain('<details open=""')

    const unavailable = ReportingDataSchema.parse({
      ...structuredClone(data),
      meta: { ...data.meta, state: 'unavailable', data: null },
    })
    const unavailableHtml = renderToStaticMarkup(<AudienceReport data={unavailable} />)
    expect(unavailableHtml).toContain('Review 25 Meta source qualifications')
    expect(unavailableHtml.match(/>Audience qualification 1<\/p>/g)).toHaveLength(1)
    expect(unavailableHtml).not.toContain('<details open=""')
  })

  it('surfaces the lower-spend active exclusion concern before filtering without losing healthy and paused counterparts', () => {
    const data = audienceReportingFixture(), review = deriveExpertReview(data)
    const findings = review.findings.filter(item => item.area === 'audience')
    expect(findings).toHaveLength(10)
    const concern = findings.find(item => item.entity?.id === 'set-7')!
    expect(concern).toMatchObject({ status: 'mixed', priority: 'investigate' })
    expect(concern.observation.text).toMatch(/excluded.*failed-exclusion.*433.*200/)
    expect(concern.configurationEvidence?.[0].value.adsetId).toBe('set-7')
    expect(concern.nextInspection.href).toContain('report=audience')
    expect(concern.nextInspection.href).toContain('#audience-adset-set-7')
    expect(overviewFindings(review).some(item => item.id === concern.id)).toBe(true)
    expect(findings.find(item => item.entity?.id === 'set-1')?.status).toBe('observed')
    expect(findings.find(item => item.entity?.id === 'set-3')?.observation.text).toMatch(/operation.*unavailable/)
    expect(findings.find(item => item.entity?.id === 'set-8')?.priority).toBe('context')
    expect(JSON.stringify(findings)).not.toMatch(/contributes no reachable|is suppressing nobody|Unused failed audience/)
    expect(review.populationCoverage).toContainEqual({ family: 'Audience', level: 'adset', supplied: 10, evaluated: 9, limited: 1 })
  })
  it('binds configuration evidence content and its exact inspection destination', () => {
    const data = audienceReportingFixture(), finding = deriveExpertReview(data).findings.find(item => item.area === 'audience' && item.entity?.id === 'set-7')!
    expect(finding).toBeDefined()
    expect(() => verifyFindingReferences(data, finding)).not.toThrow()
    const altered = structuredClone(finding)
    altered.configurationEvidence![0].value.members[1].operationCode = 200
    expect(() => verifyFindingReferences(data, altered)).toThrow()
    expect(() => verifyFindingReferences(data, { ...finding, nextInspection: { ...finding.nextInspection, href: finding.nextInspection.href.replace('set-7', 'set-8') } })).toThrow()
  })
  it('keeps a valid audience concern when its optional spend has the wrong unit', () => {
    const data = structuredClone(audienceReportingFixture()), entity = data.meta.data!.entities.find(item => item.id === 'set-7')!
    entity.metrics.spend.current.unit = 'count'
    entity.metrics.spend.previous!.unit = 'count'
    const finding = deriveExpertReview(data).findings.find(item => item.area === 'audience' && item.entity?.id === 'set-7')!
    expect(finding).toMatchObject({ status: 'mixed', priority: 'investigate', exposure: null })
    expect(finding.configurationEvidence).toHaveLength(1)
  })
  it('uses the report evaluation time consistently in review cards and detail evidence', () => {
    const data = audienceReportingFixture()
    const render = () => {
      const review = deriveExpertReview(data)
      return renderToStaticMarkup(<ExpertReviewPanel review={{ ...review, findings: review.findings.filter(item => item.area === 'audience') }} expanded />)
    }
    const currentHtml = render()
    expect(currentHtml.includes('Configuration observed')).toBe(true)
    data.context.asOf = '2026-09-08T17:00:00Z'
    const oldHtml = render()
    expect(oldHtml.includes('Configuration stale')).toBe(true)
    expect(oldHtml.includes('Configuration observed')).toBe(false)
  })
  it('surfaces a current same-ID inclusion/exclusion conflict even without a non-ready native code', () => {
    const data = audienceReportingFixture()
    for (const entity of data.meta.data!.entities) for (const member of entity.audienceEvidence?.members ?? []) member.operationCode = 200
    const review = deriveExpertReview(data)
    expect(overviewFindings(review).some(finding => finding.area === 'audience' && finding.entity?.id === 'set-6' && finding.priority === 'investigate')).toBe(true)
  })
  it('renders every membership and exports statuses, seeds, bounds and observation basis with no fake exact pool count', () => {
    const data = audienceReportingFixture(), html = renderToStaticMarkup(<AudienceReport data={data} />)
    expect(html).toContain('id="audience-adset-set-7"')
    expect(html).toContain('failed-exclusion')
    expect(html).toContain('seed-b')
    expect(html).toContain('Operation status')
    expect(html).toContain('Approximate size bounds')
    expect(html).not.toMatch(/100% exhausted|20 members|Unused failed audience/)
    const rows = collectReportExportRows(data, 'audience')
    const operation = rows.find(row => row.entity.includes('set-7') && row.entity.includes('failed-exclusion') && row.metric === 'Operation status')!
    expect(operation).toMatchObject({ value: 433, source: 'meta_configuration', date_basis: 'configuration_observation', as_of: data.context.asOf, previous_value: null })
    expect(operation.entity).toContain('excluded')
    expect(operation.limitations).toContain('not exact members')
    expect(rows.some(row => row.entity.includes('set-10') && row.metric === 'Operation status')).toBe(true)
    expect(rows.some(row => row.metric === 'Seed audience IDs' && row.value === 'seed-a; seed-b')).toBe(true)
  })
})
