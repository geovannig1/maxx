import { describe, expect, it } from 'vitest'
import { reconcileReportOutcomes } from '@/lib/reporting/meta-breakdowns'
import { buildMetaMetrics, type MetaRow } from '@/lib/reporting/meta-metrics'
import type { ReportEntity, ReportingData } from '@/lib/reporting/contracts'
import { businessPlatformFields, mediaEntityFields } from '@/lib/reporting/review/business-platform-evidence'
import { deriveExpertReview } from '@/lib/reporting/review'
import { derivePerformanceReview } from '@/lib/reporting/review/performance'
import { deriveCreativeResponseReview } from '@/lib/reporting/review/creative-response'
import { deriveBusinessPlatformReview } from '@/lib/reporting/review/business-platform'
import { deriveMediaMovement } from '@/lib/reporting/review/media-movement'
import { verifyFindingReferences } from '@/lib/reporting/review/evidence'
import { validateSavedReview } from '@/lib/reporting/saved-review'
import { PLAYBOOK_VERSION } from '@/lib/reporting/review/contracts'
import { platformData } from './fixtures/reporting-business-platform'

const CPA = 'cost_per_purchase'
function raw(spend: number | null, count: number | null, response?: number): MetaRow {
  return { ...(spend !== null ? { spend: String(spend) } : {}), impressions: '1000',
    actions: [...(count === null ? [] : [{ action_type: 'offsite_conversion.fb_pixel_purchase', value: String(count) }]),
      ...(response === undefined ? [] : [{ action_type: 'post_engagement', value: String(response) },
        { action_type: 'landing_page_view', value: String(response) }])],
    ...(response === undefined ? {} : { outbound_clicks: [{ action_type: 'outbound_click', value: String(response) }] }),
  }
}
function data(current = raw(100, 5), prior = raw(200, 20)): ReportingData {
  const value = platformData(undefined, undefined, current, prior)
  const context = { ...value.context, asOf: value.meta.asOf! }
  value.meta.data!.entities = (['campaign', 'adset', 'ad'] as const).map(level => ({
    id: `${level}-1`, level, name: `${level} example`, campaignId: level === 'campaign' ? null : 'campaign-1', campaignName: null,
    adsetId: level === 'ad' ? 'adset-1' : null, adsetName: null, status: 'ACTIVE', configurationAsOf: null,
    audience: 'unknown', audienceLabel: 'Unknown', creative: null,
    metrics: buildMetaMetrics(context, current, prior, { level, id: `${level}-1` }),
  }))
  return value
}
const field = (value: ReportingData, index?: number) => index === undefined ? businessPlatformFields(value)[CPA] : mediaEntityFields(value, index)[CPA]
const entity = (value: ReportingData, level: ReportEntity['level'] = 'ad') => derivePerformanceReview(value).findings.find(f => f.entity?.level === level)!
const creative = (value: ReportingData) => deriveCreativeResponseReview(value).findings[0]
const metric = (value: ReportingData, index?: number) => index === undefined ? value.meta.data!.metrics[CPA] : value.meta.data!.entities[index].metrics[CPA]

// These fixtures use the real native adapter, not a client-reconstructed or forged cost claim.
describe('named Purchase CPA prepared interpretation', () => {
  it.each([undefined, 0, 1, 2])('validates independent current/prior CPA without Purchase value at population %s', index => {
    const value = data(), cost = field(value, index)
    expect(cost).toMatchObject({ label: 'Purchase CPA', current: { value: 20 }, prior: { value: 10 }, change: 10 })
    expect(metric(value, index).event).toBe('Purchase')
    expect(metric(value, index).current.unit).toBe('money')
    expect(metric(value, index).current.inputClaimIds).toEqual([
      (index === undefined ? value.meta.data!.metrics : value.meta.data!.entities[index].metrics).spend.current.claimId,
      (index === undefined ? value.meta.data!.metrics : value.meta.data!.entities[index].metrics).purchase_count.current.claimId,
    ])
    expect(value.meta.data!.metrics.purchase_value.current.value).toBeNull()
    expect(value.meta.data!.metrics.purchase_roas.current.value).toBeNull()
  })
  it('explains worsening cost despite lower spend at every entity level and the account without assuming a target', () => {
    const value = data(), review = deriveExpertReview(value)
    expect(review.input.rejectedSources).toEqual([])
    for (const level of ['campaign', 'adset', 'ad'] as const) {
      const result = entity(value, level)
      expect(result.direction).toBe('declined')
      expect(result.observation.text).toMatch(/Purchase CPA rose from \$10 to \$20/)
      expect(result.observation.text).toMatch(/Meta spend fell from \$200 to \$100/)
      expect(result.observation.text).toMatch(/Purchase count fell from 20 to 5/)
      expect(result.observation.text).not.toMatch(/healthy|unprofitable|pause|increase.*budget/i)
      verifyFindingReferences(value, result)
    }
    const opening = deriveBusinessPlatformReview(value)
    expect(opening.observation.text).toMatch(/Purchase CPA rose.*\$20.*prior \$10/)
    expect(deriveMediaMovement(value).observation.text).toMatch(/Purchase CPA: \$20 \(prior \$10\)/)
    expect(review.findings.find(f => f.id === 'performance:ad:ad-1')!.observation.text).toContain('Purchase CPA')
  })
  it('keeps lower CPA and lower Purchase volume mixed instead of treating cheaper events as growth', () => {
    const value = data(raw(50, 10), raw(200, 20))
    expect(entity(value).direction).toBe('mixed')
    expect(entity(value).observation.text).toMatch(/Purchase CPA fell from \$10 to \$5/)
    expect(entity(value).observation.text).toMatch(/Purchase count fell from 20 to 10/)
    expect(creative(value).direction).toBe('mixed')
    expect(creative(value).observation.text).toContain('Purchase CPA decreased')
  })
  it.each(['campaign', 'adset'] as const)('opens the assessed %s own inputs and history instead of its children', level => {
    const value = data(), finding = entity(value, level)
    const href = new URL(finding.nextInspection.href, 'https://maxx.test')
    expect(href.pathname).toBe('/performance')
    expect(href.searchParams.get('view')).toBe('detail')
    expect(href.searchParams.get('level')).toBe(level)
    expect(href.searchParams.get('campaign')).toBe('campaign-1')
    expect(href.searchParams.get('adset')).toBe(level === 'adset' ? 'adset-1' : null)
    expect(href.searchParams.has('ad')).toBe(false)
    expect(href.searchParams.get('group')).toBe('results')
    expect(href.searchParams.get('from')).toBe(value.context.range.from)
    expect(href.searchParams.get('to')).toBe(value.context.range.to)
    expect(href.hash).toBe('#entity-metrics')
  })
  it('keeps response gains and higher Purchase CPA opposed when ROAS is unavailable', () => {
    const value = data(raw(600, 10, 300), raw(200, 5, 50)), result = creative(value)
    expect(result).toMatchObject({ direction: 'mixed', status: 'mixed' })
    expect(result.observation.text).toContain('Purchase CPA increased')
    expect(result.observation.text).toContain('Purchase CPA: $60 (prior $40)')
    expect(result.counterEvidence.text).toMatch(/causal|causation/i)
    verifyFindingReferences(value, result)
  })
  it.each([0, null])('does not make a cost from a zero or unknown Purchase denominator (%s)', count => {
    const value = data(raw(100, count))
    expect(field(value)?.current).toBeNull()
    expect(field(value)?.prior?.value).toBe(10)
    expect(field(value)?.change).toBeNull()
    expect(entity(value).observation.text).toMatch(/Purchase CPA: unavailable \(prior \$10\)/)
  })
  it('retains a real zero cost when observed spend is zero and Purchase count is positive', () => {
    expect(field(data(raw(0, 5)))).toMatchObject({ current: { value: 0 }, prior: { value: 10 }, change: -10 })
  })
  it.each(['event', 'unit', 'entity', 'window', 'input', 'order', 'duplicate', 'formula', 'arithmetic', 'source'] as const)(
    'rejects wrong current CPA %s while retaining independent structurally valid evidence', reason => {
      const value = data(), cost = metric(value, 2), original = cost.current
      if (reason === 'event') cost.event = 'AppointmentConfirmed'
      else cost.current = { ...original, ...(reason === 'unit' ? { unit: 'ratio' } : reason === 'entity' ? { entity: { level: 'ad', id: 'other-ad' } }
        : reason === 'window' ? { window: { ...original.window, start: value.context.comparison.from } }
          : reason === 'input' ? { inputClaimIds: [value.meta.data!.entities[2].metrics.spend.current.claimId, value.meta.data!.entities[2].metrics.bookings.current.claimId] }
            : reason === 'order' ? { inputClaimIds: [...original.inputClaimIds].reverse() }
              : reason === 'duplicate' ? { inputClaimIds: [original.inputClaimIds[0], original.inputClaimIds[0]] }
                : reason === 'formula' ? { formula: 'Count / spend' } : reason === 'arithmetic' ? { value: 999 }
                  : { source: { ...original.source, head: 'wrong-source' } }) }
      const observed = field(value, 2)
      expect(observed?.current).toBeNull()
      expect(observed?.change).toBeNull()
      if (!['event', 'duplicate'].includes(reason)) expect(observed?.prior?.value).toBe(10)
      expect(entity(value).observation.text).not.toContain('999')
      expect(entity(value).observation.text).toMatch(/Purchase count fell from 20 to 5/)
      expect(creative(value).observation.text).not.toContain('Purchase CPA increased')
    })
  it.each(['current', 'previous'] as const)('rejects a wrong %s input population without hiding the other period', period => {
    const value = data(), count = value.meta.data!.entities[2].metrics.purchase_count
    count[period] = { ...count[period]!, entity: { level: 'campaign', id: 'campaign-1' } }
    const observed = field(value, 2)
    expect(observed?.[period === 'current' ? 'current' : 'prior']).toBeNull()
    expect(observed?.[period === 'current' ? 'prior' : 'current']?.value).toBe(period === 'current' ? 10 : 20)
    expect(observed?.change).toBeNull()
  })
  it('qualifies partial/settling evidence and does not infer a signed change from mismatched input comparison', () => {
    const value = data(), count = value.meta.data!.entities[2].metrics.purchase_count
    count.current = { ...count.current, comparison: { method: 'none', window: null } }
    expect(field(value, 2)?.change).toBeNull()
    const partial = data()
    const partialCount = partial.meta.data!.entities[2].metrics.purchase_count
    partialCount.current = { ...partialCount.current, coverage: { ...partialCount.current.coverage, state: 'partial' } }
    expect(field(partial, 2)?.current).toBeNull()
    expect(field(partial, 2)?.prior?.value).toBe(10)
  })
  it.each(['count', 'value'] as const)('preserves the source gate for a real native hierarchy %s conflict', conflict => {
    const withValue = (row: MetaRow, value: number) => ({ ...row,
      action_values: [{ action_type: 'offsite_conversion.fb_pixel_purchase', value: String(value) }] })
    const current = withValue(raw(100, 5), 200), prior = withValue(raw(200, 20), 200)
    const value = data(current, prior), context = { ...value.context, asOf: value.meta.asOf! }
    const changedAd = withValue(raw(100, conflict === 'count' ? 6 : 5), conflict === 'value' ? 300 : 200)
    value.meta.data!.entities[2].metrics = buildMetaMetrics(context, changedAd, prior, { level: 'ad', id: 'ad-1' })
    const reads = new Map<string, MetaRow[]>()
    for (const period of ['current', 'previous'] as const) for (const level of ['account', 'campaign', 'adset', 'ad'] as const) {
      const row = period === 'previous' ? prior : level === 'ad' ? changedAd : current
      const range = period === 'current' ? context.range : context.comparison
      reads.set(`${period}:${level}`, [{ ...row, campaign_id: 'campaign-1', adset_id: 'adset-1', ad_id: 'ad-1',
        date_start: range.from, date_stop: range.to }])
    }
    const projected = reconcileReportOutcomes(context, value.meta.data!, reads)
    value.meta = { ...value.meta, state: 'partial', data: projected.report, notes: projected.notes }
    const cost = field(value, 2)
    expect(cost.current?.value ?? null).toBe(conflict === 'count' ? null : 20)
    expect(cost.prior?.value).toBe(10)
    expect(value.meta.data!.entities[2].metrics.purchase_roas.current.value).toBeNull()
    if (conflict === 'value') expect(entity(value).observation.text).toContain('Purchase CPA rose from $10 to $20')
    else expect(entity(value).observation.text).toContain('Purchase CPA: unavailable')
  })
  it('keeps an original snapshot without the optional CPA metric unavailable instead of reconstructing it', () => {
    const value = data()
    delete value.meta.data!.metrics[CPA]
    for (const row of value.meta.data!.entities) delete row.metrics[CPA]
    expect(field(value)).toMatchObject({ ref: null, current: null, prior: null, change: null })
    expect(field(value, 2)).toMatchObject({ ref: null, current: null, prior: null, change: null })
    const before = JSON.stringify(value), review = deriveExpertReview(value)
    expect(review.input.rejectedSources).toEqual([])
    expect(review.findings.find(f => f.id === 'performance:ad:ad-1')!.observation.text).toContain('Purchase CPA: unavailable')
    expect(JSON.stringify(value)).toBe(before)
  })
  it('versions new interpretation while validating original v12 saved wording and references unchanged', () => {
    expect(PLAYBOOK_VERSION).toBe('maxx-diagnostic-2026-09-08.v16')
    const value = data(), review = deriveExpertReview(value)
    const original = { ...review, playbookVersion: 'maxx-diagnostic-2026-09-07.v12', findings: review.findings
      .filter(f => f.id === 'performance:ad:ad-1').map(f => ({ ...f,
        observation: { text: 'Original saved assessment before named Purchase CPA.', evidence: f.observation.evidence.filter(ref => ref.metric.key !== CPA) } })) }
    const before = JSON.stringify(original)
    expect(validateSavedReview(original, value)).toEqual(original)
    expect(JSON.stringify(original)).toBe(before)
    expect(validateSavedReview(original, value).findings[0].observation.text).not.toContain('rose from')
    const changed = structuredClone(value)
    changed.meta.data!.entities[2].metrics.spend.current.value = 999
    expect(() => validateSavedReview(original, changed)).toThrow()
  })
})
