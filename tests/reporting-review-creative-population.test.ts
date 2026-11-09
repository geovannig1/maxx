import { describe, expect, it } from 'vitest'
import type { ReportEntity, ReportMetric, ReportingData } from '@/lib/reporting/contracts'
import { buildMetaMetrics, type MetaRow } from '@/lib/reporting/meta-metrics'
import { deriveCreativePopulationReview, deriveCreativeReview } from '@/lib/reporting/review/creative'
import { deriveExpertReview, overviewFindings } from '@/lib/reporting/review'
import { findingEvidence, verifyFindingReferences } from '@/lib/reporting/review/evidence'
import { validateReportingPacket } from '@/lib/reporting/validation'
import { snapshotContext as context } from './fixtures/reporting-snapshot'

// Fictional native source rows, with independently specified counts and expected relationships.
type Values = { spend: number; impressions: number; starts: number | null; midpoint: number | null;
  outbound: number | null; landing: number | null }
const base: Values = { spend: 100, impressions: 1000, starts: 100, midpoint: 40, outbound: 10, landing: 8 }
const action = (value: number | null, action_type: string) => value === null ? undefined : [{ action_type, value: String(value) }]
function native(values: Values): MetaRow {
  return { spend: String(values.spend), impressions: String(values.impressions), inline_link_clicks: '100',
    video_play_actions: action(values.starts, 'video_view'), video_p50_watched_actions: action(values.midpoint, 'video_view'),
    outbound_clicks: action(values.outbound, 'outbound_click'), actions: action(values.landing, 'landing_page_view') }
}
function ad(id: string, values: Partial<Values> = {}, prior?: Partial<Values>, format: 'video' | 'image' = 'video'): ReportEntity {
  return { id, name: `Execution ${id}`, level: 'ad', campaignId: 'campaign', campaignName: 'Fictional campaign',
    adsetId: 'adset', adsetName: 'Fictional ad set', status: 'ACTIVE', configurationAsOf: context.asOf,
    audience: 'unknown', audienceLabel: 'Not supplied',
    creative: { id: `asset-${id}`, name: id, format, durationSeconds: format === 'video' ? 20 : null,
      body: null, headline: null, destination: `https://example.test/${id}`, imageUrl: null, thumbnailUrl: null, videoUrl: null },
    metrics: buildMetaMetrics(context, native({ ...base, ...values }), prior ? native({ ...base, ...prior }) : undefined, { level: 'ad', id }) }
}
function report(entities: ReportEntity[]): ReportingData {
  const absent = { state: 'unavailable' as const, data: null, asOf: null, notes: [] }
  return { context, business: absent, website: absent, meta: { state: 'available', asOf: context.asOf, notes: [], data: {
    metrics: {}, entities, series: [], comparisonSeries: [], breakdowns: [], observations: [],
    attributionWindow: 'Native default', reportingTime: 'impression', sourceDescription: 'Fictional Meta source', detailState: 'complete',
  } } }
}
function replace(entity: ReportEntity, key: string, update: (metric: ReportMetric) => ReportMetric): ReportEntity {
  return { ...entity, metrics: { ...entity.metrics, [key]: update(entity.metrics[key]) } }
}
const forAd = (data: ReportingData, id: string) => deriveCreativePopulationReview(data).findings.filter(finding =>
  new URL(finding.nextInspection.href, 'https://maxx.local').searchParams.get('ad') === id)

describe('complete supplied creative execution review', () => {
  it('does not repeat a single creative improvement as both an anchor and a population highlight', () => {
    const data = report([ad('improving', { spend: 10, midpoint: 60, outbound: 30 }, { spend: 10, midpoint: 10, outbound: 2 })])
    const highlights = overviewFindings(deriveExpertReview(data)).filter(finding => finding.area === 'creative')
    expect(highlights).toHaveLength(1)
    expect(highlights[0].direction).toBe('improved')
    expect(new URL(highlights[0].nextInspection.href, 'https://maxx.local').searchParams.get('ad')).toBe('improving')
  })
  it('retains the seventh low-spend divergence and every execution with its original evidence index', () => {
    const entities = Array.from({ length: 8 }, (_, index) => ad(String(index + 1),
      { spend: index < 6 ? 900 - index * 100 : index === 6 ? 0.01 : 0,
        ...(index === 6 ? { midpoint: 20, outbound: 20 } : {}) },
      index === 6 ? { midpoint: 60, outbound: 5 } : {}))
    const parent = { ...ad('parent'), level: 'adset' as const, metrics: {} }
    const data = report([parent, ...entities])
    const result = deriveCreativePopulationReview(data)
    expect(result.coverage).toEqual({ level: 'ad', supplied: 8, evaluated: 8, limited: 0 })
    expect(result.findings).toHaveLength(16)
    expect(new Set(result.findings.map(finding => finding.id)).size).toBe(16)
    for (const [index, entity] of entities.entries()) {
      const findings = result.findings.filter(finding => finding.entity?.id === entity.id)
      expect(findings.map(finding => finding.id).sort()).toEqual([`creative_attention:${entity.id}`, `creative_landing:${entity.id}`])
      for (const finding of findings) {
        expect(finding.entity).toEqual({ id: entity.id, level: 'ad', name: entity.name })
        expect(findingEvidence(finding).every(ref => ref.path.startsWith(`/meta/data/entities/${index + 1}/metrics/`))).toBe(true)
        expect(() => verifyFindingReferences(data, finding)).not.toThrow()
      }
    }
    const seventh = result.findings.find(finding => finding.id === 'creative_attention:7')!
    expect(seventh.status).toBe('mixed')
    expect(seventh.priority).toBe('investigate')
    expect(seventh.exposure?.value).toBe(0.01)
    expect(seventh.observation.text).toContain('20%')
    expect(seventh.observation.text).toContain('60%')
    expect(seventh.observation.text).toContain('prior equal period')
    expect(seventh.nextInspection.question).toMatch(/qualif/i)
    expect(result.findings.filter(finding => finding.priority === 'investigate').map(finding => finding.id)).toEqual(['creative_attention:7'])
    const changed = report([parent, ...entities.map(entity => entity.id === '7' ? ad('7', { spend: 0.01, midpoint: 20, outbound: 20 }, { midpoint: 60, outbound: 30 }) : entity)])
    const reversed = forAd(changed, '7').find(finding => finding.id === 'creative_attention:7')!
    expect(reversed.priority).toBe('investigate')
    expect(reversed.direction).toBe('declined')
    expect(reversed.nextInspection.question).not.toBe(seventh.nextInspection.question)
  })

  it('does not compare each ad to a differently delivered current ad, while preserving the legacy pair', () => {
    const data = report([ad('one', { midpoint: 20, outbound: 20, spend: 200 }), ad('two', { midpoint: 80, outbound: 5 })])
    expect(deriveCreativeReview(data)[0].status).toBe('mixed')
    const population = deriveCreativePopulationReview(data)
    expect(population.coverage.evaluated).toBe(2)
    expect(population.findings.every(finding => finding.priority === 'context')).toBe(true)
    for (const finding of population.findings) {
      expect(findingEvidence(finding).every(ref => ref.metric.current.entity.id === finding.entity?.id)).toBe(true)
      expect(finding.status).toBe('observed')
    }
  })

  it.each(['unknown', 'unit', 'event', 'date'] as const)('counts wrong %s outbound evidence as limited, with a valid same-invocation control', field => {
    const original = ad('invalid', { starts: null, midpoint: null }, undefined, 'image')
    const invalid = replace(original, 'outbound_clicks', value => field === 'event' ? { ...value, event: 'Purchase' }
      : { ...value, current: field === 'unknown' ? { ...value.current, coverage: { ...value.current.coverage, state: 'unknown' } }
        : field === 'unit' ? { ...value.current, unit: 'money' }
          : { ...value.current, window: { ...value.current.window, start: context.comparison.from, end: context.comparison.to } } })
    const data = report([invalid, ad('valid', { starts: null, midpoint: null }, undefined, 'image')])
    const result = deriveCreativePopulationReview(data)
    expect(result.coverage).toEqual({ level: 'ad', supplied: 2, evaluated: 1, limited: 1 })
    expect(result.findings.map(finding => finding.id)).toEqual(['creative_landing:valid'])
    expect(() => verifyFindingReferences(data, result.findings[0])).not.toThrow()
  })

  it('retains zero counts and image clicks without inventing a video weakness or arrival loss', () => {
    const data = report([
      ad('zero', { spend: 0, outbound: 0, landing: 0, starts: null, midpoint: null }, undefined, 'image'),
      ad('unknown-landing', { outbound: 0, landing: null, starts: null, midpoint: null }, undefined, 'image'),
      ad('above-clicks', { outbound: 10, landing: 15, starts: null, midpoint: null }, undefined, 'image'),
    ])
    const result = deriveCreativePopulationReview(data)
    expect(result.coverage).toEqual({ level: 'ad', supplied: 3, evaluated: 2, limited: 1 })
    expect(result.findings).toHaveLength(3)
    expect(result.findings.every(finding => finding.id.startsWith('creative_landing:') && finding.priority === 'context')).toBe(true)
    const [zero] = forAd(data, 'zero'), [unknown] = forAd(data, 'unknown-landing'), [above] = forAd(data, 'above-clicks')
    expect(zero.status).toBe('unchanged')
    expect(zero.exposure?.value).toBe(0)
    expect(zero.observation.text).toContain('0 outbound clicks; 0 landing-page views')
    expect(unknown.status).toBe('unavailable')
    expect(unknown.observation.text).toContain('0 outbound clicks')
    expect(unknown.nextInspection.question).not.toBe(zero.nextInspection.question)
    expect(above.counterEvidence.text).toMatch(/not lower/i)
    for (const finding of result.findings) expect(() => verifyFindingReferences(data, finding)).not.toThrow()
  })

  it('withholds invalid native arithmetic but retains current counts and limits prior contrast separately', () => {
    const original = ad('source', { midpoint: 20, outbound: 20, landing: null }, { midpoint: 60, outbound: 5 })
    expect(forAd(report([original]), 'source')[0].priority).toBe('investigate')
    const invalidCurrent = replace(original, 'retention_p50', value => ({ ...value, current: { ...value.current, value: 90 } }))
    const currentData = report([invalidCurrent])
    const current = forAd(currentData, 'source').find(finding => finding.id === 'creative_attention:source')!
    expect(deriveCreativePopulationReview(currentData).coverage).toEqual({ level: 'ad', supplied: 1, evaluated: 0, limited: 1 })
    expect(current.status).toBe('unavailable')
    expect(current.priority).toBe('context')
    expect(current.observation.text).toContain('20 50% watches from 100 video starts')
    expect(current.observation.evidence.some(ref => ref.metric.key === 'retention_p50')).toBe(false)
    const invalidPrior = replace(original, 'retention_p50', value => ({ ...value, previous: { ...value.previous!, value: 90 } }))
    const priorData = report([invalidPrior])
    const prior = forAd(priorData, 'source').find(finding => finding.id === 'creative_attention:source')!
    expect(deriveCreativePopulationReview(priorData).coverage.evaluated).toBe(1)
    expect(prior.status).toBe('observed')
    expect(prior.priority).toBe('context')
    expect(prior.observation.text).not.toContain('prior equal period')
    for (const data of [currentData, priorData]) for (const finding of deriveCreativePopulationReview(data).findings) {
      expect(() => verifyFindingReferences(data, finding)).not.toThrow()
    }
  })

  it('reports limited supplied ads when exposure is unavailable and ignores inaccessible section payloads', () => {
    const missingSpend = replace(ad('missing-spend'), 'spend', value => ({ ...value, current: { ...value.current,
      value: null, availability: { state: 'unavailable', blockerCodes: ['missing_source_spend'] } } }))
    const data = report([missingSpend, ad('known')])
    expect(deriveCreativePopulationReview(data).coverage).toEqual({ level: 'ad', supplied: 2, evaluated: 1, limited: 1 })
    expect(forAd(data, 'missing-spend')).toEqual([])
    expect(deriveCreativePopulationReview({ ...data, meta: { ...data.meta, state: 'unavailable' } })).toEqual({
      findings: [], coverage: { level: 'ad', supplied: 0, evaluated: 0, limited: 0 },
    })
  })

  it.each(['declined', 'improved'] as const)('surfaces the seventh low-spend same-ad %s relationship through the integrated overview', direction => {
    const current = direction === 'declined' ? { midpoint: 10, outbound: 2 } : { midpoint: 60, outbound: 30 }
    const prior = direction === 'declined' ? { midpoint: 60, outbound: 30 } : { midpoint: 10, outbound: 2 }
    const stable = Array.from({ length: 6 }, (_, index) => ad(`stable-${index + 1}`, { spend: 900 - index * 100 }, { spend: 900 - index * 100 }))
    const data = report([...stable, ad('seventh', { ...current, spend: 50 }, { ...prior, spend: 50 })])
    expect(() => validateReportingPacket({ context, section: 'meta', result: data.meta, notes: [] })).not.toThrow()
    const review = deriveExpertReview(data)
    expect(review.input.rejectedSources).toEqual([])
    const finding = review.findings.find(item => item.id === 'creative_attention:seventh')!
    expect(finding.priority).toBe('investigate')
    expect(finding.direction).toBe(direction)
    expect(finding.status).toBe('observed')
    expect(overviewFindings(review).filter(item => item.area === 'creative').map(item => item.id)).toEqual(['creative_attention:seventh'])
    expect(finding.observation.text).toContain('10%')
    expect(finding.observation.text).toContain('60%')
    expect(finding.observation.text).toContain('0.2% outbound CTR')
    expect(finding.observation.text).toContain('3% outbound CTR')
    expect(finding.authority).toEqual({ state: 'diagnostic', executable: false })
    expect(finding.limitations.join(' ')).toMatch(/not a causal creative test/)
    expect(findingEvidence(finding).every(ref => ref.metric.current.entity.id === 'seventh')).toBe(true)
    expect(() => verifyFindingReferences(data, finding)).not.toThrow()
  })

  it.each(['same', 'absent', 'inconsistent', 'attention-only', 'response-only'] as const)('does not promote low current attention and clicks when the prior comparison is %s', mode => {
    const current = { spend: 50, midpoint: 10, outbound: 2 }
    const prior = mode === 'absent' ? undefined : mode === 'same' ? current
      : mode === 'attention-only' ? { ...current, midpoint: 60 } : mode === 'response-only' ? { ...current, outbound: 30 }
        : { ...current, midpoint: 60, outbound: 30 }
    const original = ad('seventh', current, prior)
    const seventh = mode === 'inconsistent' ? replace(original, 'retention_p50', value => ({ ...value,
      previous: { ...value.previous!, value: 99 } })) : original
    const data = report([ad('stable-control', {}, {}), seventh])
    expect(() => validateReportingPacket({ context, section: 'meta', result: data.meta, notes: [] })).not.toThrow()
    const review = deriveExpertReview(data)
    expect(review.input.rejectedSources).toEqual([])
    const finding = review.findings.find(item => item.id === 'creative_attention:seventh')!
    expect(finding.priority).toBe('context')
    expect(finding.direction).toBeUndefined()
    expect(finding.observation.text).toContain('0.2% outbound CTR')
    expect(overviewFindings(review).some(item => item.id === 'creative_attention:seventh')).toBe(false)
    expect(() => verifyFindingReferences(data, finding)).not.toThrow()
  })

  it('keeps a supported creative improvement alongside a lower-spend decline in overview highlights', () => {
    const stable = Array.from({ length: 6 }, (_, index) => ad(`stable-${index + 1}`, { spend: 900 - index * 100 }, { spend: 900 - index * 100 }))
    const data = report([...stable,
      ad('improve', { spend: 80, midpoint: 60, outbound: 30 }, { spend: 80, midpoint: 10, outbound: 2 }),
      ad('decline', { spend: 50, midpoint: 10, outbound: 2 }, { spend: 50, midpoint: 60, outbound: 30 }),
    ])
    expect(() => validateReportingPacket({ context, section: 'meta', result: data.meta, notes: [] })).not.toThrow()
    const review = deriveExpertReview(data)
    expect(review.findings.find(finding => finding.id === 'creative_attention:improve')?.direction).toBe('improved')
    expect(review.findings.find(finding => finding.id === 'creative_attention:decline')?.direction).toBe('declined')
    const highlights = overviewFindings(review).filter(finding => finding.area === 'creative')
    expect(highlights.map(finding => finding.id)).toEqual(['creative_attention:decline', 'creative_attention:improve'])
    for (const finding of highlights) expect(() => verifyFindingReferences(data, finding)).not.toThrow()
  })
})
