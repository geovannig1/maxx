import { describe, expect, it } from 'vitest'
import type { ReportMetric, ReportingData } from '@/lib/reporting/contracts'
import { deriveCreativeResponseReview } from '@/lib/reporting/review/creative-response'
import { deriveExpertReview, overviewFindings } from '@/lib/reporting/review'
import { findingEvidence, verifyFindingReferences } from '@/lib/reporting/review/evidence'
import { validateReportingPacket } from '@/lib/reporting/validation'
import { appointmentResults, creativeAd, creativeContext, creativeData } from './fixtures/reporting-creative'

type Values = { spend: number | null; impressions: number; engagements: number | null; outbound: number | null; bookings: number | null }
const base: Values = { spend: 20, impressions: 1000, engagements: 100, outbound: 20, bookings: 0 }
const action = (action_type: string, value: number) => ({ action_type, value: String(value) })
const raw = (values: Partial<Values> = {}) => {
  const v = { ...base, ...values }
  return { spend: v.spend === null ? undefined : String(v.spend), impressions: String(v.impressions),
    actions: [...(v.engagements === null ? [] : [action('post_engagement', v.engagements)]), action('post_reaction', 7),
      action('comment', 3), action('post', 2), action('onsite_conversion.post_save', 1), action('landing_page_view', 15)],
    outbound_clicks: v.outbound === null ? undefined : [action('outbound_click', v.outbound)],
    results: v.bookings === null ? undefined : appointmentResults(v.bookings),
  }
}
const ad = (id: string, current: Partial<Values> = {}, previous: Partial<Values> = {}) => creativeAd(id, raw(current), raw(previous))
const assess = (data: ReportingData, id = '301') => deriveCreativeResponseReview(data).findings.find(f => f.id === `creative_response:${id}`)!
const change = (key: string, alter: (metric: ReportMetric) => void) => {
  const data = structuredClone(creativeData([ad('301', { engagements: 200, outbound: 10 })]))
  alter(data.meta.data!.entities[0].metrics[key])
  return data
}

describe('creative response across the complete supplied execution population', () => {
  it('validates a native packet and explains engagement-rate gain with outbound-rate decline, counts and zero outcomes together', () => {
    const data = creativeData([ad('301', { engagements: 200, outbound: 10 })])
    expect(() => validateReportingPacket({ context: data.context, section: 'meta', result: data.meta, notes: [] })).not.toThrow()
    const finding = assess(data)
    expect(finding).toMatchObject({ area: 'creative', direction: 'mixed', status: 'mixed', priority: 'investigate', exposure: { value: 20, unit: 'money' } })
    expect(finding.observation.text).toContain('Post engagements 200 (prior 100)')
    expect(finding.observation.text).toContain('Engagements per impression 20% (prior 10%)')
    expect(finding.observation.text).toContain('Outbound CTR 1% (prior 2%)')
    expect(finding.observation.text).toContain('AppointmentConfirmed 0 [settling period] (prior 0 [settling period])')
    for (const label of ['Post reactions 7', 'Comments 3', 'Post shares 2', 'Post saves 1', 'Landing-page views 15', 'Spend $20', 'Cost per post engagement $0.10']) {
      expect(`${finding.observation.text} ${finding.counterEvidence.text}`).toContain(label)
    }
    expect(finding.counterEvidence.text).toMatch(/zero.*does not|does not.*zero/i)
    expect(findingEvidence(finding).some(ref => ref.metric.key === 'engagement_rate')).toBe(true)
    expect(() => verifyFindingReferences(data, finding)).not.toThrow()
    const url = new URL(finding.nextInspection.href, 'https://maxx.local')
    expect(Object.fromEntries(url.searchParams)).toEqual({ ad: '301', group: 'response', from: creativeContext.range.from, to: creativeContext.range.to })
  })
  it('uses rates instead of mistaking larger raw volumes for stronger response and recognizes the reverse divergence', () => {
    const data = creativeData([ad('301', { impressions: 2000, engagements: 150, outbound: 50 })])
    const finding = assess(data)
    expect(finding.direction).toBe('mixed')
    expect(finding.observation.text).toMatch(/engagement per impression decreased while outbound CTR increased/i)
    expect(finding.observation.text).toContain('7.5% (prior 10%)')
    expect(finding.observation.text).toContain('2.5% (prior 2%)')
  })
  it('explains inquiry/profile response beside flat bookings without calling those people or sales', () => {
    const data = creativeData([creativeAd('301', {
      ...raw(), spend: '30', instagram_profile_visits: '9',
      actions: [...raw().actions, action('onsite_conversion.messaging_conversation_started_7d', 3), action('video_view', 20)],
    }, {
      ...raw(), spend: '30', instagram_profile_visits: '3',
      actions: [...raw().actions, action('onsite_conversion.messaging_conversation_started_7d', 1), action('video_view', 20)],
    })])
    const finding = assess(data)
    expect(finding.direction).toBe('improved')
    expect(finding.observation.text).toContain('Messaging conversations started 3 (prior 1)')
    expect(finding.observation.text).toContain('Instagram profile visits 9 (prior 3)')
    expect(finding.observation.text).toContain('Cost per messaging conversation started $10 (prior $30)')
    expect(finding.observation.text).toContain('AppointmentConfirmed 0 [settling period] (prior 0 [settling period])')
    expect(finding.counterEvidence.text).toMatch(/not unique people|not.*customers|not.*sales/i)
    expect(() => verifyFindingReferences(data, finding)).not.toThrow()
  })
  it('retains a seventh low-spend image divergence in the overview and all ads in exact source order', () => {
    const rows = Array.from({ length: 8 }, (_, index) => ad(String(index + 1), { spend: 100 - index,
      ...(index === 6 ? { spend: 0.01, engagements: 200, outbound: 10 } : {}) }))
    rows[6].creative!.format = 'image'
    const data = creativeData(rows)
    const result = deriveCreativeResponseReview(data)
    // Response observations are eligible, but this fixture supplies no event values or Purchase evidence.
    expect(result.coverage).toEqual({ family: 'Creative response', level: 'ad', supplied: 8, evaluated: 8, limited: 8 })
    expect(assess(data, '7').limitations.join(' ')).toContain('Purchase count comparison unavailable')
    expect(result.findings.map(f => f.id)).toEqual(rows.map(row => `creative_response:${row.id}`))
    expect(findingEvidence(assess(data, '7')).every(ref => ref.path.startsWith('/meta/data/entities/6/metrics/'))).toBe(true)
    const review = deriveExpertReview(data)
    expect(review.input.rejectedSources).toEqual([])
    expect(review.playbookVersion).toBe('maxx-diagnostic-2026-09-08.v16')
    expect(review.populationCoverage).toContainEqual(result.coverage)
    expect(overviewFindings(review).some(f => f.id === 'creative_response:7')).toBe(true)
  })
  it('distinguishes missing reported bookings from explicit zero and retains missing-spend response', () => {
    const zero = assess(creativeData([ad('301')]))
    const missing = assess(creativeData([ad('301', { bookings: null, spend: null })]))
    expect(zero.observation.text).toContain('AppointmentConfirmed 0')
    expect(missing.observation.text).toContain('AppointmentConfirmed unavailable')
    expect(missing.observation.text).toContain('Post engagements 100')
    expect(missing.exposure?.unit).not.toBe('money')
    expect(missing.zeroOutcomeSpend).not.toBe(true)
  })
  it('preserves independent prior-only values without inventing current zero or direction', () => {
    const data = creativeData([creativeAd('301', {}, raw())])
    const finding = assess(data)
    expect(finding.status).not.toBe('unavailable')
    expect(finding.direction).toBeUndefined()
    expect(finding.observation.text).toContain('Post engagements unavailable (prior 100)')
    expect(finding.observation.text).toContain('AppointmentConfirmed unavailable (prior 0 [settling period])')
    expect(finding.exposure).toBeNull()
  })
  it('supports gains and stable evidence without inventing an intervention or urgency', () => {
    const stable = assess(creativeData([ad('301')]))
    expect(stable.status).toBe('unchanged')
    expect(stable.priority).toBe('context')
    expect(stable.counterEvidence.text).toContain('does not justify an intervention')
    expect(stable.nextInspection.question).toMatch(/optional/i)
    const gain = assess(creativeData([ad('301', { engagements: 200, outbound: 30, bookings: 2 })]))
    expect(gain.direction).toBe('improved')
    expect(gain.observation.text).toContain('AppointmentConfirmed 2 [settling period] (prior 0 [settling period])')
  })
  it('qualifies stable response rates when reported bookings fall to zero and spend/costs worsen', () => {
    const finding = assess(creativeData([ad('301', { spend: 40, bookings: 0 }, { spend: 20, bookings: 1 })]))
    expect(finding.direction).toBe('declined')
    expect(finding.status).not.toBe('unchanged')
    expect(finding.counterEvidence.text).not.toContain('does not justify an intervention')
    expect(finding.observation.text).toMatch(/AppointmentConfirmed.*decreased/i)
    expect(finding.observation.text).toContain('AppointmentConfirmed 0 [settling period] (prior 1 [settling period])')
    expect(finding.observation.text).toContain('Spend $40 (prior $20)')
    expect(finding.observation.text).toContain('Cost per post engagement $0.40 (prior $0.20)')
  })
  it('leads with the conclusion and supported response instead of every unavailable metric', () => {
    const finding = assess(creativeData([ad('301', { engagements: 200, outbound: 10 })]))
    expect(finding.observation.text.indexOf('increased while')).toBeLessThan(finding.observation.text.indexOf('Post engagements 200'))
    expect(finding.observation.text).not.toContain('Cost per reported booking unavailable')
    expect(finding.observation.text).not.toContain('Post reactions')
    expect(findingEvidence(finding).some(ref => ref.metric.key === 'reactions')).toBe(true)
  })
  it('does not turn accepted floating-point roundoff into a claimed response gain', () => {
    const data = structuredClone(creativeData([ad('301')]))
    const claim = data.meta.data!.entities[0].metrics.engagement_rate.current
    claim.value = (claim.value as number) + Number.EPSILON * 10
    const finding = assess(data)
    expect(finding.direction).toBeUndefined()
    expect(finding.status).toBe('unchanged')
  })
  it('preserves a small positive cost and rejects replacing it with an invented zero', () => {
    // Native decimal strings are required; scientific notation is not a supported source field.
    const native = creativeAd('301', { ...raw(), spend: '0.000000000000001' }, { ...raw(), spend: '0.000000000000001' })
    const data = structuredClone(creativeData([native]))
    expect(assess(data).observation.text).toContain('Cost per post engagement <$0.01')
    data.meta.data!.entities[0].metrics.cost_per_engagement.current.value = 0
    expect(assess(data).observation.text).toContain('Cost per post engagement unavailable')
  })
  it('preserves an exact native count increase even at the safe-integer boundary', () => {
    const finding = assess(creativeData([ad('301', { bookings: Number.MAX_SAFE_INTEGER }, { bookings: Number.MAX_SAFE_INTEGER - 1 })]))
    expect(finding.observation.text).toContain('Reported AppointmentConfirmed increased')
    expect(finding.direction).toBe('improved')
  })
  it.each(['definition', 'identity', 'period', 'source', 'clock', 'futureNano', 'unit', 'attribution', 'lineage', 'arithmetic'] as const)('withholds an invalid %s response rate while preserving independent native counts', defect => {
    const data = change('engagement_rate', metric => {
      if (defect === 'definition') { metric.definition = 'Invented quality score'; metric.current.formula = metric.definition }
      if (defect === 'identity') metric.current.entity.id = 'other'
      if (defect === 'period') metric.current.window.start = creativeContext.comparison.from
      if (defect === 'source') metric.current.source.role = 'decision_context'
      if (defect === 'clock') metric.current.asOf = '2026-09-05T16:00:00.000Z'
      if (defect === 'futureNano') metric.current.asOf = '2026-09-05T17:00:00.000000001Z'
      if (defect === 'unit') metric.current.unit = 'count'
      if (defect === 'attribution') metric.current.attributionScope = 'none'
      if (defect === 'lineage') metric.current.inputClaimIds = ['unrelated-input']
      if (defect === 'arithmetic') metric.current.value = 99
    })
    const finding = assess(data)
    // Invalid engagement rate cannot erase valid lower engagement cost and higher outbound cost/declining CTR.
    expect(finding.direction).toBe('mixed')
    expect(finding.observation.text).toContain('Outbound CTR decreased')
    expect(finding.observation.text).toContain('Engagements per impression unavailable')
    expect(finding.observation.text).toContain('Post engagements 200')
    expect(finding.observation.text).toContain('Outbound clicks 10')
  })
  it('keeps a valid current observation when only its prior is incompatible', () => {
    const data = change('engagements', metric => { metric.previous!.unit = 'money' })
    const finding = assess(data)
    expect(finding.direction).toBe('declined')
    expect(finding.observation.text).toContain('Outbound CTR decreased')
    expect(finding.observation.text).toContain('Post engagements 200 (prior unavailable)')
    expect(finding.observation.text).toContain('Engagements per impression 20% (prior unavailable)')
  })
  it('preserves partial raw response counts and other complete fields but withholds dependent rates and comparisons', () => {
    const data = change('engagements', metric => { metric.current.coverage = { state: 'partial', numerator: 1, denominator: 2 } })
    const finding = assess(data)
    expect(finding.observation.text).toContain('Post engagements 200 [partial coverage]')
    expect(finding.observation.text).toContain('Outbound CTR 1% (prior 2%)')
    expect(finding.observation.text).toContain('Engagements per impression unavailable')
    expect(finding.direction).toBe('declined')
    expect(finding.observation.text).toContain('Outbound CTR decreased')
    expect(finding.limitations.join(' ')).toMatch(/coverage/i)
    expect(deriveCreativeResponseReview(data).coverage.limited).toBe(1)
  })
  it('accepts a healthy older source in a newer report but rejects native observation/head mismatches', () => {
    const data = creativeData([ad('301', { engagements: 200, outbound: 10 })])
    data.context = { ...data.context, asOf: '2026-09-05T18:00:00.000Z' }
    expect(assess(data).direction).toBe('mixed')
    const invalid = change('engagements', metric => { metric.current.source.head = 'unrelated-source' })
    expect(assess(invalid).observation.text).toContain('Post engagements unavailable')
    expect(assess(invalid).observation.text).toContain('Outbound clicks 10')
  })
  it('returns an explicit limited assessment for a supplied ad with no usable response', () => {
    const data = creativeData([creativeAd('301', {}, null), ad('302')])
    const result = deriveCreativeResponseReview(data)
    expect(result.findings).toHaveLength(2)
    expect(assess(data).status).toBe('unavailable')
    expect(result.coverage).toEqual({ family: 'Creative response', level: 'ad', supplied: 2, evaluated: 1, limited: 2 })
    expect(assess(data, '302').limitations.join(' ')).toContain('Purchase count comparison unavailable')
  })
})
