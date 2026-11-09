import { describe, expect, it } from 'vitest'
import type { MetricClaim } from '@/lib/cockpit/contracts'
import type { ReportingData } from '@/lib/reporting/contracts'
import { deriveCreativeResponseReview } from '@/lib/reporting/review/creative-response'
import { deriveExpertReview } from '@/lib/reporting/review'
import { findingEvidence, verifyFindingReferences } from '@/lib/reporting/review/evidence'
import { validateReportingPacket } from '@/lib/reporting/validation'
import { appointmentResults, creativeAd, creativeData } from './fixtures/reporting-creative'

const outcomeKeys = ['bookings', 'appointment_value', 'appointment_roas', 'purchase_count', 'purchase_value', 'purchase_roas']
type Values = { engagements: number; outbound: number; arrivals: number; bookings: number; bookedValue: number; purchases: number; purchaseValue: number; spend: number }
const prior: Values = { engagements: 100, outbound: 20, arrivals: 15, bookings: 2, bookedValue: 200, purchases: 5, purchaseValue: 500, spend: 100 }
const action = (action_type: string, value: number) => ({ action_type, value: String(value) })
const raw = (values: Partial<Values> = {}) => {
  const v = { ...prior, ...values }
  return { spend: String(v.spend), impressions: '1000',
    actions: [action('post_engagement', v.engagements), action('landing_page_view', v.arrivals), action('offsite_conversion.fb_pixel_purchase', v.purchases)],
    outbound_clicks: [action('outbound_click', v.outbound)], results: appointmentResults(v.bookings),
    action_values: [action('offsite_conversion.fb_pixel_custom.AppointmentConfirmed', v.bookedValue), action('offsite_conversion.fb_pixel_purchase', v.purchaseValue)] }
}
const packet = (values: Partial<Values> = { engagements: 200, outbound: 40, arrivals: 30, purchases: 1, purchaseValue: 100 }) =>
  structuredClone(creativeData([creativeAd('301', raw()), creativeAd('302', raw(values), raw())]))
const assess = (data: ReportingData) => deriveCreativeResponseReview(data).findings.find(finding => finding.id === 'creative_response:302')!
const claim = (data: ReportingData, key: string, period: 'current' | 'previous' = 'current') => data.meta.data!.entities[1].metrics[key][period]!
const evidence = (data: ReportingData, key: string) => findingEvidence(assess(data)).find(ref => ref.metric.key === key)!

describe('same-execution response and named-outcome synthesis', () => {
  it('reconciles stronger response with falling Purchase while retaining steady AppointmentConfirmed', () => {
    const data = packet()
    expect(() => validateReportingPacket({ context: data.context, section: 'meta', result: data.meta, notes: [] })).not.toThrow()
    const finding = assess(data)
    expect(finding).toMatchObject({ direction: 'mixed', status: 'mixed', priority: 'investigate' })
    expect(finding.observation.text).toContain('20% (prior 10%)')
    expect(finding.observation.text).toContain('4% (prior 2%)')
    expect(finding.observation.text).toContain('Landing-page views 30 (prior 15)')
    for (const value of ['AppointmentConfirmed 2 [settling period] (prior 2 [settling period])', 'AppointmentConfirmed value: $200', 'AppointmentConfirmed ROAS: 2×',
      'Purchase count: 1', 'prior 5', 'Purchase value: $100', 'prior $500', 'Purchase ROAS: 1×', 'prior 5×']) expect(finding.observation.text).toContain(value)
    expect(finding.observation.text).toMatch(/coexist|oppos|mixed/i)
    expect(finding.observation.text).toContain('Purchase count, Purchase value, Purchase ROAS decreased')
    expect(finding.counterEvidence.text.replaceAll('\n', ' ')).toMatch(/AppointmentConfirmed.*Purchase.*separate/)
    expect(finding.counterEvidence.text).toMatch(/causal|causation/)
    expect(new Set(findingEvidence(finding).filter(ref => outcomeKeys.includes(ref.metric.key)).map(ref => ref.metric.key))).toEqual(new Set(outcomeKeys))
    for (const ref of findingEvidence(finding)) expect(finding.evidencePeriods?.[ref.id]).toEqual(['current', 'prior'])
    expect(() => verifyFindingReferences(data, finding)).not.toThrow()
    expect(deriveCreativeResponseReview(data).coverage).toEqual({ family: 'Creative response', level: 'ad', supplied: 2, evaluated: 2, limited: 2 })
    const review = deriveExpertReview(data)
    expect(review.input.rejectedSources).toEqual([])
    expect(review.findings.find(row => row.id === finding.id)?.direction).toBe('mixed')
  })

  it('keeps supported aligned gains favorable, but preserves outcome-only declines when response rates are stable', () => {
    const aligned = assess(packet({ engagements: 200, outbound: 40, arrivals: 30, purchases: 6, purchaseValue: 600 }))
    expect(aligned.direction).toBe('improved')
    const declined = assess(packet({ purchases: 1, purchaseValue: 100 }))
    expect(declined.direction).toBe('declined')
    expect(declined.status).not.toBe('unchanged')
    expect(declined.counterEvidence.text).not.toContain('does not justify an intervention')
    const stable = assess(packet({}))
    expect(stable).toMatchObject({ status: 'unchanged', priority: 'context' })
    expect(stable.nextInspection.question).toMatch(/optional/i)
  })

  it('keeps falling arrivals as contrary evidence when response rates rise and named outcomes hold steady', () => {
    const finding = assess(packet({ engagements: 200, outbound: 40, arrivals: 5 }))
    expect(finding.direction).toBe('mixed')
    expect(finding.observation.text).toContain('Landing-page views 5 (prior 15)')
    expect(finding.observation.text).toMatch(/coexist|oppos|mixed/i)
  })

  it('does not let stable bookings hide an opposing native event value or ROAS movement', () => {
    const finding = assess(packet({ engagements: 200, outbound: 40, bookedValue: 100 }))
    expect(finding.direction).toBe('mixed')
    expect(finding.observation.text).toContain('AppointmentConfirmed 2 [settling period] (prior 2 [settling period])')
    expect(finding.observation.text).toContain('AppointmentConfirmed value: $100')
    expect(finding.observation.text).toContain('AppointmentConfirmed ROAS: 1×')
    expect(finding.observation.text).toContain('Purchase value: $500')
  })

  it.each(['current', 'previous'] as const)('excludes invalid %s Purchase evidence while retaining the independently valid period and response', period => {
    const data = packet()
    for (const key of ['purchase_count', 'purchase_value', 'purchase_roas']) claim(data, key, period).entity.id = 'foreign-ad'
    const finding = assess(data)
    expect(finding.direction).toBe('improved')
    expect(finding.observation.text).toContain(period === 'current' ? 'Purchase count: unavailable (prior 5' : 'Purchase count: 1')
    for (const key of ['purchase_count', 'purchase_value', 'purchase_roas']) {
      const ref = evidence(data, key)
      expect(ref).toBeTruthy()
      expect(finding.evidencePeriods?.[ref.id]).toEqual([period === 'current' ? 'prior' : 'current'])
    }
  })

  it.each(['unit', 'formula', 'clock', 'fingerprint', 'maturity', 'comparison'] as const)('withholds a mismatched %s booking comparison instead of using the weaker response booking reader', defect => {
    const data = packet({ bookings: 1 })
    const metric = claim(data, 'bookings')
    if (defect === 'unit') metric.unit = 'money'
    if (defect === 'formula') metric.formula = 'Wrong event count formula'
    if (defect === 'clock') metric.asOf = '2026-09-05T17:00:00.000000001Z'
    if (defect === 'fingerprint') metric.setupFingerprint = 'foreign-setup'
    if (defect === 'maturity') metric.maturity = { state: 'settled', matureThrough: '2026-09-04' }
    if (defect === 'comparison') metric.comparison.window!.start = '2026-08-01'
    const finding = assess(data)
    expect(finding.direction).toBeUndefined()
    expect(finding.observation.text).not.toContain('Reported AppointmentConfirmed decreased')
    expect(finding.observation.text).toContain('Purchase count: 5')
    if (defect === 'maturity') expect(finding.observation.text).toContain('maturity differs from the native window')
    if (!['maturity', 'comparison'].includes(defect)) expect(finding.evidencePeriods?.[evidence(data, 'bookings').id]).toEqual(['prior'])
  })

  it('preserves qualified partial Purchase counts without letting them establish decline or hiding independent value evidence', () => {
    const data = packet({ purchases: 1 })
    claim(data, 'purchase_count').coverage = { state: 'partial', numerator: 1, denominator: 2 }
    const finding = assess(data)
    expect(finding.direction).toBeUndefined()
    expect(finding.observation.text).toContain('Purchase count: 1 [partial coverage')
    expect(finding.observation.text).toContain('Purchase value: $500')
    expect(finding.limitations.join(' ')).toMatch(/Purchase count comparison unavailable/)
    expect(finding.evidencePeriods?.[evidence(data, 'purchase_count').id]).toEqual(['current', 'prior'])
  })

  it('qualifies permitted settling changes and rejects invented ratio arithmetic without suppressing native values', () => {
    const settling = assess(packet())
    expect(settling.observation.text).toMatch(/provisional.*settling/i)
    const data = packet({ engagements: 200, outbound: 40 })
    claim(data, 'purchase_roas').value = 0.01
    const finding = assess(data)
    expect(finding.direction).toBe('improved')
    expect(finding.observation.text).toContain('Purchase value: $500')
    expect(finding.observation.text).toContain('Purchase ROAS: unavailable (prior 5×')
    expect(finding.evidencePeriods?.[evidence(data, 'purchase_roas').id]).toEqual(['prior'])
  })

  it('uses exact safe-integer booking movements after native qualification and keeps rejected response periods out of evidence', () => {
    const data = packet({ bookings: Number.MAX_SAFE_INTEGER })
    claim(data, 'bookings', 'previous').value = Number.MAX_SAFE_INTEGER - 1
    const finding = assess(data)
    expect(finding.direction).toBe('improved')
    expect(finding.observation.text).toContain('Reported AppointmentConfirmed increased')
    const invalid = packet()
    claim(invalid, 'engagements').unit = 'money' as MetricClaim['unit']
    const ref = evidence(invalid, 'engagements')
    expect(assess(invalid).evidencePeriods?.[ref.id]).toEqual(['prior'])
  })

  it('uses the same strict spend evidence for outcomes and response costs, retaining valid prior exposure only', () => {
    const data = packet({})
    claim(data, 'spend').setupFingerprint = 'foreign-setup'
    const finding = assess(data)
    expect(finding.observation.text).toContain('Spend unavailable (prior $100)')
    expect(finding.observation.text).not.toContain('Cost per post engagement $1')
    expect(finding.evidencePeriods?.[evidence(data, 'spend').id]).toEqual(['prior'])
    expect(finding.exposure?.unit).toBe('count')
    expect(finding.observation.text).toContain('Post engagements 100')
    expect(finding.observation.text).toContain('Purchase value: $500')
  })

  it.each(['current', 'previous'] as const)('retains the settling qualification on an independently usable %s booking count without any outcome pair', retained => {
    const data = packet({})
    for (const key of outcomeKeys) for (const period of ['current', 'previous'] as const) {
      if (key === 'bookings' && period === retained) continue
      claim(data, key, period).value = null
      claim(data, key, period).availability = { state: 'unavailable', blockerCodes: ['missing_source_count'] }
    }
    const finding = assess(data)
    expect(finding.direction).toBeUndefined()
    expect(finding.observation.text).toContain(retained === 'current'
      ? 'AppointmentConfirmed 2 [settling period] (prior unavailable)'
      : 'AppointmentConfirmed unavailable (prior 2 [settling period])')
    expect(finding.evidencePeriods?.[evidence(data, 'bookings').id]).toEqual([retained === 'current' ? 'current' : 'prior'])
  })

  it('keeps an independently improving outbound rate as contrary evidence to falling Purchase when engagement is unmeasured', () => {
    const withoutEngagement = (values: Partial<Values>) => {
      const row = raw(values)
      return { ...row, actions: row.actions.filter(action => action.action_type !== 'post_engagement') }
    }
    const data = creativeData([creativeAd('302', withoutEngagement({ outbound: 40, purchases: 1, purchaseValue: 100 }), withoutEngagement({}))])
    const finding = assess(data)
    expect(finding.direction).toBe('mixed')
    expect(finding.observation.text).toContain('Outbound CTR increased')
    expect(finding.observation.text).toContain('Outbound CTR 4% (prior 2%)')
    expect(finding.observation.text).toContain('Engagements per impression unavailable')
    expect(finding.observation.text).toContain('Purchase count, Purchase value, Purchase ROAS decreased')
    expect(() => verifyFindingReferences(data, finding)).not.toThrow()
    const noGain = creativeData([creativeAd('302', withoutEngagement({ purchases: 1, purchaseValue: 100 }), withoutEngagement({}))])
    expect(assess(noGain).direction).toBe('declined')
  })

  it('preserves the complete observed answer in three readable, exactly reconstructable paragraph sections', () => {
    const finding = assess(packet())
    expect(finding.observation.sections).toHaveLength(3)
    const sections = finding.observation.sections!
    expect(sections.every(section => section.heading === undefined && section.paragraphs.length === 1)).toBe(true)
    expect(sections.flatMap(section => section.paragraphs).join(' ')).toBe(finding.observation.text)
    expect(sections[0].paragraphs[0]).toContain('Purchase count, Purchase value, Purchase ROAS decreased')
    expect(sections[1].paragraphs[0]).toContain('Post engagements 200')
    expect(sections[2].paragraphs[0]).toContain('Purchase value: $100')
    expect(() => verifyFindingReferences(packet(), finding)).not.toThrow()
  })
})
