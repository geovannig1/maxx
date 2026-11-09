import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { deriveExpertReview, overviewFindings } from '@/lib/reporting/review'
import { verifyFindingReferences } from '@/lib/reporting/review/evidence'
import { derivePerformanceReview } from '@/lib/reporting/review/performance'
import { validateReportingPacket } from '@/lib/reporting/validation'
import { ExpertReviewPanel } from '@/components/reporting/ExpertReviewPanel'
import { executiveFixture } from './reporting-browser/executive-fixture'

describe('account-wide prepared review', () => {
  it('assesses the full campaign, ad-set and ad population, including the seventh row', () => {
    const data = executiveFixture()
    const review = deriveExpertReview(data)
    const findings = review.findings.filter(finding => finding.id.startsWith('performance:'))
    expect(findings).toHaveLength(23)
    const seventh = findings.find(finding => finding.id === 'performance:adset:set-7')!
    expect(seventh).toBeDefined()
    expect(seventh.observation.text).toContain('zero AppointmentConfirmed')
    expect(seventh.zeroOutcomeSpend).toBe(true)
    expect(seventh.counterEvidence.text).toContain('Purchase')
    const unknown = findings.find(finding => finding.id === 'performance:adset:set-10')!
    expect(unknown.observation.text).not.toContain('zero AppointmentConfirmed')
    expect(unknown.zeroOutcomeSpend).toBe(false)
    for (const finding of findings) expect(() => verifyFindingReferences(data, finding), finding.id).not.toThrow()
  })
  it('explains per-event ROAS deterioration with its native values and comparison', () => {
    const review = deriveExpertReview(executiveFixture())
    const row = review.findings.find(finding => finding.id === 'performance:adset:set-8')!
    expect(row).toBeDefined()
    expect(row.observation.text).toContain('AppointmentConfirmed ROAS fell from 50× to 25×')
    expect(row.observation.text).toContain('Purchase ROAS fell')
    expect(row.authority.executable).toBe(false)
    expect(row.limitations.join(' ')).toMatch(/unequal|optimizer/)
  })
  it.each(['event', 'unit', 'arithmetic', 'input_identity'] as const)('rejects %s corruption without fabricating a ROAS finding', field => {
    const data = executiveFixture()
    const businessBefore = deriveExpertReview(data).findings.filter(finding => finding.area === 'business')
    const entity = data.meta.data!.entities.find(entity => entity.id === 'set-8')!
    const original = entity.metrics.appointment_roas
    entity.metrics = { ...entity.metrics, appointment_roas: { ...original,
      event: field === 'event' ? 'Purchase' : original.event,
      current: { ...original.current, unit: field === 'unit' ? 'count' : original.current.unit,
        value: field === 'arithmetic' ? 999 : original.current.value,
        inputClaimIds: field === 'input_identity' ? ['wrong', 'inputs'] : original.current.inputClaimIds } } }
    const row = derivePerformanceReview(data).findings.find(finding => finding.id === 'performance:adset:set-8')!
    expect(row).toBeDefined()
    expect(row.observation.text).not.toContain('AppointmentConfirmed ROAS fell')
    expect(row.observation.text).toContain('Purchase ROAS fell')
    const review = deriveExpertReview(data)
    if (field === 'unit' || field === 'input_identity') {
      expect(() => validateReportingPacket({ context: data.context, section: 'meta', result: data.meta, notes: [] })).toThrow()
      expect(review.input.rejectedSources).toEqual(['meta'])
      expect(review.findings.some(finding => finding.id.startsWith('performance:'))).toBe(false)
      const businessAfter = review.findings.filter(finding => finding.area === 'business')
      expect(businessAfter.map(finding => finding.id).sort()).toEqual(businessBefore.map(finding => finding.id).sort())
      expect(businessAfter.filter(finding => finding.id !== 'business_platform_trend'))
        .toEqual(businessBefore.filter(finding => finding.id !== 'business_platform_trend'))
    } else {
      expect(review.input.rejectedSources).toEqual([])
      expect(review.findings.find(finding => finding.id === row.id)?.observation.text).toBe(row.observation.text)
    }
  })
  it('prepares a favorable lower-spend case alongside deterioration before the owner selects a filter', () => {
    const data = executiveFixture('2026-09-02', '2026-09-04', true)
    expect(() => validateReportingPacket({ context: data.context, section: 'meta', result: data.meta, notes: [] })).not.toThrow()
    const review = deriveExpertReview(data)
    const opportunity = review.findings.find(finding => finding.id === 'performance:adset:set-8')!
    expect(opportunity.direction).toBe('improved')
    expect(opportunity.priority).toBe('investigate')
    expect(opportunity.observation.text).toContain('AppointmentConfirmed ROAS increased from 12.5× to 25×')
    expect(opportunity.authority.executable).toBe(false)
    const highlights = overviewFindings(review)
    expect(highlights.some(finding => finding.id === opportunity.id)).toBe(true)
    expect(highlights.some(finding => finding.id === 'performance:adset:set-7')).toBe(true)
    expect(highlights.some(finding => finding.direction === 'declined')).toBe(true)
    expect(highlights.some(finding => finding.id === 'performance:ad:ad-8')).toBe(false)
    const creative = highlights.find(finding => finding.id === 'creative_response:ad-8')!
    expect(creative).toBe(review.findings.find(finding => finding.id === 'creative_response:ad-8'))
    expect(creative.observation.text).toContain('Outbound CTR was unchanged')
    expect(creative.observation.text).toContain('Spend $40 (prior $80)')
    expect(creative.observation.text).toContain('AppointmentConfirmed 2 [settling period] (prior 2 [settling period])')
    expect(creative.observation.text).toContain('Purchase value: $100 [settling period] (prior $100 [settling period])')
    expect(opportunity.counterEvidence.text).toContain('moving budget')
    expect(() => verifyFindingReferences(data, opportunity)).not.toThrow()
  })
  it('integrates creative checks across every eligible execution and discloses its bounded coverage', () => {
    const review = deriveExpertReview(executiveFixture())
    const creative = review.findings.filter(finding => finding.id.startsWith('creative_landing:'))
    expect(creative).toHaveLength(10)
    expect(creative.some(finding => finding.entity?.id === 'ad-7')).toBe(true)
    expect(review.populationCoverage).toContainEqual({ family: 'Creative', level: 'ad', supplied: 10, evaluated: 10, limited: 0 })
  })
  it('excludes refund and cancellation reporting from every assessment while retaining source-payment qualifications', () => {
    const findings = deriveExpertReview(executiveFixture()).findings
    expect(JSON.stringify(findings).match(/refund|cancel|customer returns/i)?.[0]).toBeUndefined()
    expect(JSON.stringify(findings.filter(finding => finding.area === 'business'))).toContain('settlement')
  })
  it('identifies highlights as a subset and exposes all assessments through the complete review', () => {
    const review = deriveExpertReview(executiveFixture())
    expect(overviewFindings(review).some(finding => finding.id.startsWith('performance:'))).toBe(true)
    const html = renderToStaticMarkup(<ExpertReviewPanel review={review} expanded />)
    expect(html).toContain('Search assessments')
    expect(html).toContain('Review coverage')
    expect(html).toContain('Next assessments')
    expect(html).not.toContain('Every reporting check')
  })
})
