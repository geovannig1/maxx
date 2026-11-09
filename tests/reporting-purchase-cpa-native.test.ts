import { describe, expect, it } from 'vitest'
import { buildMetaBreakdowns, buildMetaSeries, previousContext, reconcileReportOutcomes, META_DAILY_METRIC_KEYS, CAMPAIGN_DAILY_INPUT_KEYS, selectMetaMetrics } from '@/lib/reporting/meta-breakdowns'
import { buildMetaMetrics, type MetaRow } from '@/lib/reporting/meta-metrics'
import type { MetaReport, ReportEntity, ReportMetricMap, ReportingContext } from '@/lib/reporting/contracts'
import type { MetricClaim } from '@/lib/cockpit/contracts'
import { validateScopedReportingPacket } from '@/lib/reporting/packet-scope'
import { makeReportingSnapshotScope } from '@/lib/reporting/snapshot-scope'
import { canonicalReportingJson } from '@/lib/reporting/snapshot-contract'
import { validateReportingPacket } from '@/lib/reporting/validation'

const context: ReportingContext = {
  account: { id: '00000000-0000-4000-8000-000000001311', metaAccountId: '123', name: 'Fictional hierarchy' },
  range: { from: '2026-09-02', to: '2026-09-04' }, comparison: { from: '2026-08-30', to: '2026-09-01' },
  timezone: 'America/New_York', currency: 'USD', asOf: '2026-09-20T16:00:00Z',
}
type NativeValue = number | string | null
type Period = Record<'account' | 'campaign' | 'adset' | 'ad', MetaRow[] | undefined>
function row(id: string, count: NativeValue, value: NativeValue, spend: NativeValue = 50, bookings = id === '302' ? 0 : 2): MetaRow {
  return { account_id: '123', campaign_id: '101', campaign_name: 'Campaign',
    adset_id: id === '302' ? '202' : '201', ad_id: id,
    ...(spend === null ? {} : { spend: String(spend) }),
    ...(count === null ? {} : { actions: [{ action_type: 'purchase', value: String(count) }] }),
    ...(value === null ? {} : { action_values: [{ action_type: 'purchase', value: String(value) }] }),
    results: [{ indicator: 'AppointmentConfirmed', values: [
      { value: String(bookings), attribution_windows: ['default'] },
      { value: String(bookings), attribution_windows: ['7d_click'] },
      { value: '0', attribution_windows: ['1d_view'] },
    ] }], conversion_values: [{ action_type: 'AppointmentConfirmed', value: String(bookings * 100) }],
  }
}
function period(a = row('301', 2, 200), b = row('302', 0, 0), parent = row('101', 2, 200, 100)): Period {
  return { account: [parent], campaign: [parent], adset: [a, b], ad: [a, b] }
}
function fixture(current = period(), previous = period()) {
  const reads = new Map<string, MetaRow[]>()
  for (const [name, data, range] of [['current', current, context.range], ['previous', previous, context.comparison]] as const) {
    for (const [level, rows] of Object.entries(data)) {
      if (rows) reads.set(`${name}:${level}`, rows.map(value => ({ ...value, date_start: range.from, date_stop: range.to })))
    }
  }
  const details = (now: MetaRow | null, prior: MetaRow | null, entity: MetricClaim['entity'] = { level: 'account', id: context.account.id }) => {
    const currentDays = now ? [{ ...now, date_start: context.range.from, date_stop: context.range.from }] : []
    const priorDays = prior ? [{ ...prior, date_start: context.comparison.from, date_stop: context.comparison.from }] : []
    return { series: buildMetaSeries(context, currentDays, priorDays, entity),
      comparisonSeries: buildMetaSeries(previousContext(context), priorDays, null, entity),
      breakdowns: buildMetaBreakdowns(context, 'placement', now ? [{ ...now, publisher_platform: 'instagram', platform_position: 'feed' }] : [],
        prior ? [{ ...prior, publisher_platform: 'instagram', platform_position: 'feed' }] : [], entity) }
  }
  const entities: ReportEntity[] = []
  for (const level of ['campaign', 'adset', 'ad'] as const) {
    const now = new Map((reads.get(`current:${level}`) ?? []).map(value => [String(value[`${level}_id`]), value]))
    const prior = new Map((reads.get(`previous:${level}`) ?? []).map(value => [String(value[`${level}_id`]), value]))
    for (const id of new Set([...now.keys(), ...prior.keys()])) {
      const native = now.get(id) ?? prior.get(id)!
      const entity = { level, id }
      entities.push({ ...entity, name: `${level} ${id}`, campaignId: String(native.campaign_id), campaignName: 'Campaign',
        adsetId: level === 'ad' ? String(native.adset_id) : null, adsetName: null, status: 'UNKNOWN',
        configurationAsOf: null, audience: 'unknown', audienceLabel: 'Unavailable', creative: null,
        metrics: buildMetaMetrics(context, now.get(id) ?? null, prior.get(id) ?? null, entity),
        ...(level === 'ad' && id === '301' ? details(now.get(id) ?? null, prior.get(id) ?? null, entity) : {}) })
    }
  }
  const report: MetaReport = { metrics: buildMetaMetrics(context, current.account?.[0] ?? null, previous.account?.[0] ?? null),
    entities, ...details(current.account?.[0] ?? null, previous.account?.[0] ?? null), observations: [],
    sourceDescription: 'Fictional native reads', attributionWindow: 'Native attribution', reportingTime: 'Impression date' }
  return { report, reads }
}
function reconcile(current = period(), previous = period()) {
  const input = fixture(current, previous)
  const before = JSON.stringify(input.report)
  const readsBefore = JSON.stringify([...input.reads])
  const result = reconcileReportOutcomes(context, input.report, input.reads)
  expect(JSON.stringify(input.report)).toBe(before)
  expect(JSON.stringify([...input.reads])).toBe(readsBefore)
  expect(() => validateReportingPacket({ context, section: 'meta', result: {
    state: 'partial', data: result.report, asOf: context.asOf, notes: result.notes,
  }, notes: [] })).not.toThrow()
  return { ...result, original: input.report }
}
const ad = (report: MetaReport) => report.entities.find(entity => entity.level === 'ad' && entity.id === '301')!
const cpa = (report: MetaReport) => ad(report).metrics.cost_per_purchase

describe('native named Purchase cost', () => {
  it.each(['account', 'campaign', 'adset', 'ad'] as const)('derives %s CPA from exact own spend/count without requiring Purchase value', level => {
    const entity = { level, id: level === 'account' ? context.account.id : '301' }
    const metrics = buildMetaMetrics(context, row('301', 2, null, 50), row('301', 4, null, 80), entity)
    expect(metrics.cost_per_purchase).toMatchObject({ key: 'cost_per_purchase', label: 'Cost per reported Purchase', event: 'Purchase',
      current: { value: 25, unit: 'money', entity, metricKey: 'meta.cost_per_purchase', measurementKind: 'derived',
        attributionScope: 'meta_platform_modelled', coverage: { state: 'complete' }, asOf: context.asOf }, previous: { value: 20 } })
    expect(metrics.cost_per_purchase.definition).toBe('Spend / Reported purchases; matching Meta population and period with complete input coverage.')
    expect(metrics.cost_per_purchase.current.inputClaimIds).toEqual([metrics.spend.current.claimId, metrics.purchase_count.current.claimId])
    expect(metrics.cost_per_purchase.previous!.inputClaimIds).toEqual([metrics.spend.previous!.claimId, metrics.purchase_count.previous!.claimId])
    expect(metrics.cost_per_purchase.previous!.window).toMatchObject({ start: context.comparison.from, end: context.comparison.to })
    expect(metrics.cost_per_purchase.current.window.basis).toBe('impression_date_et')
    expect(metrics.purchase_value.current.value).toBeNull()
    expect(metrics.purchase_roas.current.value).toBeNull()
  })
  it.each([
    ['missing count', row('301', null, 200)], ['zero count', row('301', 0, 200)],
    ['fractional count', row('301', 1.5, 200)], ['malformed count', row('301', 'unknown', 200)],
    ['missing spend', row('301', 2, 200, null)], ['negative spend', row('301', 2, 200, -1)],
  ] as const)('keeps %s unavailable without borrowing Purchase value or prior count', (_reason, native) => {
    const metrics = buildMetaMetrics(context, native, row('301', 2, null))
    expect(metrics.cost_per_purchase?.current.value).toBeNull()
    expect(metrics.cost_per_purchase?.current.availability.state).toBe('unavailable')
    expect(metrics.cost_per_purchase?.previous?.value).toBe(25)
  })
  it('keeps measured zero spend with a positive Purchase count as zero cost', () => {
    const metrics = buildMetaMetrics(context, row('301', 2, null, 0))
    expect(metrics.cost_per_purchase?.current.value).toBe(0)
    expect(metrics.cost_per_purchase?.current.availability.state).toBe('available')
  })
  it('never sums overlapping Purchase aliases into the CPA denominator', () => {
    const native = { ...row('301', 2, null), actions: [{ action_type: 'purchase', value: '2' },
      { action_type: 'omni_purchase', value: '2' }, { action_type: 'offsite_conversion.fb_pixel_purchase', value: '2' }] }
    const metrics = buildMetaMetrics(context, native)
    expect(metrics.purchase_count.current.value).toBe(2)
    expect(metrics.cost_per_purchase?.current.value).toBe(25)
  })
})

describe('independent Purchase count and value reconciliation', () => {
  it.each(['current', 'previous'] as const)('retains complete own CPA under %s incomplete sibling counts and missing value', which => {
    const incomplete = period(row('301', 2, null), row('302', null, null), row('101', 2, null, 100))
    const { report, original } = reconcile(which === 'current' ? incomplete : period(), which === 'previous' ? incomplete : period())
    expect(cpa(report)?.[which]?.value).toBe(25)
    expect(cpa(report)?.[which]).toEqual(cpa(original)?.[which])
    expect(ad(report).series![0].metrics.cost_per_purchase?.[which]?.value).toBe(25)
    expect(ad(report).breakdowns![0].metrics.cost_per_purchase?.[which]?.value).toBe(25)
    expect(report.observations.filter(item => item.detail.includes('Purchase hierarchy comparison is incomplete')).length).toBeGreaterThan(0)
  })
  it.each([
    ['complete excess', row('301', 3, 200), row('302', 0, 0)],
    ['complete shortfall', row('301', 1, 200), row('302', 0, 0)],
    ['known subtotal excess', row('301', 3, 200), row('302', null, null)],
  ] as const)('blocks prior CPA for supported count %s without losing current or native inputs', (_label, a, b) => {
    const { report, original } = reconcile(period(), period(a, b))
    expect(cpa(report)?.current.value).toBe(25)
    expect(cpa(report)?.previous?.value).toBeNull()
    expect(cpa(report)?.previous?.availability.blockerCodes).toContain('meta_outcome_hierarchy_unreconciled')
    expect(ad(report).metrics.purchase_count.previous).toEqual(ad(original).metrics.purchase_count.previous)
    expect(ad(report).series![0].metrics.cost_per_purchase?.previous?.value).toBeNull()
    expect(ad(report).comparisonSeries![0].metrics.cost_per_purchase?.current.value).toBeNull()
    expect(ad(report).breakdowns![0].metrics.cost_per_purchase?.previous?.value).toBeNull()
    expect(ad(report).metrics.purchase_roas.previous?.value).toBeNull()
    expect(ad(report).metrics.appointment_roas.previous?.value).toBe(4)
  })
  it.each([100, 300])('keeps CPA when complete child value %s conflicts with campaign200 but count agrees', value => {
    const { report, original } = reconcile(period(row('301', 2, value)))
    expect(cpa(report)?.current.value).toBe(25)
    expect(cpa(report)).toEqual(cpa(original))
    expect(ad(report).series![0].metrics.cost_per_purchase?.current.value).toBe(25)
    expect(ad(report).breakdowns![0].metrics.cost_per_purchase?.current.value).toBe(25)
    expect(ad(report).metrics.purchase_roas.current.value).toBeNull()
    expect(ad(report).metrics.appointment_roas.current.value).toBe(4)
  })
  it.each([1, 3])('compares account count%s to complete campaign2 independently from matching value', count => {
    const { report, original } = reconcile({ ...period(), account: [row('101', count, 200, 100)] })
    expect(report.metrics.cost_per_purchase?.current.value).toBeNull()
    expect(report.metrics.cost_per_purchase?.current.availability.blockerCodes).toContain('meta_outcome_hierarchy_unreconciled')
    expect(report.metrics.cost_per_purchase?.previous?.value).toBe(50)
    expect(report.metrics.purchase_roas).toEqual(original.metrics.purchase_roas)
    expect(report.metrics.purchase_roas.current.value).toBe(2)
    expect(report.series[0].metrics.cost_per_purchase?.current.value).toBeNull()
    expect(report.breakdowns[0].metrics.cost_per_purchase?.current.value).toBeNull()
  })
  it('withholds account ROAS but retains native account CPA for value-only conflict', () => {
    const { report, original } = reconcile({ ...period(), account: [row('101', 2, 300, 100)] })
    expect(report.metrics.cost_per_purchase?.current.value).toBe(50)
    expect(report.metrics.cost_per_purchase).toEqual(original.metrics.cost_per_purchase)
    expect(report.metrics.purchase_roas.current.value).toBeNull()
  })
  it.each([1, 2, 3])('uses account as parent for incomplete known campaign count subtotal%s', count => {
    const base = period(row('301', count, 200), row('302', 0, 0), row('101', count, 200, 100))
    const { report } = reconcile({ ...base, account: [row('101', 2, 200, 100)], campaign: [...base.campaign!,
      { ...row('102', null, null, 0, 0), campaign_id: '102' }] })
    expect(report.metrics.cost_per_purchase?.current.value).toBe(count > 2 ? null : 50)
    expect(report.metrics.purchase_count.current.value).toBe(2)
    expect(report.metrics.purchase_roas.current.value).toBe(2)
    expect(new Set(report.observations.map(item => item.id)).size).toBe(report.observations.length)
  })
  it('does not fabricate CPA when campaign count is unavailable but keeps a valid account numerator/denominator', () => {
    const { report } = reconcile({ ...period(), campaign: [row('101', null, 200, 100)] })
    expect(report.metrics.cost_per_purchase?.current.value).toBe(50)
    expect(report.entities.find(item => item.level === 'campaign')!.metrics.cost_per_purchase?.current.value).toBeNull()
    expect(cpa(report)?.current.value).toBe(25)
  })
  it('rejects foreign entity, date and input lineage on native CPA packets', () => {
    const { report } = reconcile()
    expect(cpa(report)?.current.value).toBe(25)
    for (const mutate of [
      (value: MetaReport) => { cpa(value).current.entity.id = 'foreign' },
      (value: MetaReport) => { cpa(value).current.window.start = context.comparison.from },
      (value: MetaReport) => { cpa(value).current.inputClaimIds = [value.metrics.spend.current.claimId, value.metrics.purchase_count.current.claimId] },
      (value: MetaReport) => { cpa(value).current.inputClaimIds = [ad(value).metrics.spend.previous!.claimId, ad(value).metrics.purchase_count.previous!.claimId] },
    ]) {
      const changed = structuredClone(report); mutate(changed)
      expect(() => validateReportingPacket({ context, section: 'meta', result: { state: 'partial', data: changed, asOf: context.asOf, notes: [] }, notes: [] })).toThrow()
    }
  })
})

const INQUIRY_DAILY_KEYS = ['messaging_conversations_started', 'messaging_conversations_replied',
  'messaging_first_replies', 'instagram_profile_visits', 'instagram_profile_follows', 'action_video_views',
  'cost_per_messaging_conversation_started', 'cost_per_instagram_profile_visit',
  'cost_per_instagram_profile_follow', 'cost_per_action_video_view']

function parentPacket(level: 'campaign' | 'adset', legacy = false) {
  const { report } = reconcile()
  const selected = report.entities.find(item => item.level === level)!
  const value = row('301', 2, 200)
  const prior = { ...value, date_start: context.comparison.from }
  const current = { ...value, date_start: context.range.from }
  const identity = { level, id: selected.id }
  const full = { ...selected,
    series: buildMetaSeries(context, [current], [prior], identity, META_DAILY_METRIC_KEYS),
    comparisonSeries: buildMetaSeries(previousContext(context), [prior], null, identity, META_DAILY_METRIC_KEYS) }
  const laterAdditions = new Set(['cost_per_purchase', ...INQUIRY_DAILY_KEYS])
  const removeLaterAdditions = (metrics: ReportMetricMap) => Object.fromEntries(Object.entries(metrics)
    .filter(([key]) => !laterAdditions.has(key)))
  const legacyPoints = (points: typeof full.series) => points.map(point => ({ ...point, metrics: removeLaterAdditions(point.metrics) }))
  const data = { ...report, entities: report.entities.map(item => item.id === selected.id && item.level === selected.level
    ? { ...full, series: legacy ? legacyPoints(full.series) : full.series, comparisonSeries: legacy ? legacyPoints(full.comparisonSeries) : full.comparisonSeries }
    : { ...item, series: undefined, comparisonSeries: undefined, breakdowns: undefined }) }
  return { packet: { context, section: 'meta' as const, result: { state: 'partial' as const, data, asOf: context.asOf, notes: [] }, notes: [] },
    scope: makeReportingSnapshotScope('meta', context, { historyEntity: { level, id: selected.id } }), id: selected.id }
}

describe('additive daily catalog preserves exact saved parent evidence', () => {
  it.each(['campaign', 'adset'] as const)('accepts the current %s daily catalog with scoped native metrics', level => {
    const { packet, scope, id } = parentPacket(level)
    const selected = packet.result.data.entities.find(item => item.id === id && item.level === level)!
    expect(Object.keys(selected.series![0].metrics)).toHaveLength(META_DAILY_METRIC_KEYS.length)
    expect(selected.series![0].metrics.cost_per_purchase.current.value).toBe(25)
    expect(() => validateScopedReportingPacket(packet, scope, context.asOf)).not.toThrow()
  })
  it.each(['campaign', 'adset'] as const)('accepts original48 %s daily fields byte-for-byte without adding CPA', level => {
    const { packet, scope, id } = parentPacket(level, true)
    const original = JSON.stringify(packet)
    const selected = packet.result.data.entities.find(item => item.id === id && item.level === level)!
    expect(Object.keys(selected.series![0].metrics)).toHaveLength(48)
    const validated = validateScopedReportingPacket(packet, scope, context.asOf)
    expect(JSON.stringify(packet)).toBe(original)
    expect(canonicalReportingJson(validated) === canonicalReportingJson(packet)).toBe(true)
    expect(selected.series![0].metrics.cost_per_purchase).toBeUndefined()
  })
  it.each(['campaign', 'adset'] as const)('accepts the prior 49-field %s catalog without reconstructing inquiry metrics', level => {
    const { packet, scope, id } = parentPacket(level)
    const selected = packet.result.data.entities.find(item => item.id === id && item.level === level)!
    for (const points of [selected.series!, selected.comparisonSeries!]) for (const point of points) {
      point.metrics = Object.fromEntries(Object.entries(point.metrics).filter(([key]) => !INQUIRY_DAILY_KEYS.includes(key)))
    }
    expect(Object.keys(selected.series![0].metrics)).toHaveLength(49)
    expect(() => validateScopedReportingPacket(packet, scope, context.asOf)).not.toThrow()
  })
  it.each(['campaign', 'adset'] as const)('rejects a partial current %s catalog instead of accepting an invented hybrid', level => {
    const { packet, scope, id } = parentPacket(level)
    const selected = packet.result.data.entities.find(item => item.id === id && item.level === level)!
    selected.series![0].metrics = Object.fromEntries(Object.entries(selected.series![0].metrics)
      .filter(([key]) => !['instagram_profile_follows', 'cost_per_instagram_profile_follow'].includes(key)))
    expect(() => validateReportingPacket(packet)).not.toThrow()
    expect(() => validateScopedReportingPacket(packet, scope, context.asOf)).toThrow()
  })
  it.each([false, true])('rejects a missing original key even when old-catalog cardinality could match, legacy=%s', legacy => {
    const { packet, scope, id } = parentPacket('campaign', legacy)
    const selected = packet.result.data.entities.find(item => item.id === id && item.level === 'campaign')!
    selected.series![0].metrics = Object.fromEntries(Object.entries(selected.series![0].metrics).filter(([key]) => key !== 'cpm'))
    expect(() => validateReportingPacket(packet)).not.toThrow()
    expect(() => validateScopedReportingPacket(packet, scope, context.asOf)).toThrow()
  })
  it('rejects unknown keys and four-input authority packets relabelled as full history', () => {
    for (const mode of ['unknown', 'four_inputs']) {
      const { packet, scope, id } = parentPacket('campaign', true)
      const selected = packet.result.data.entities.find(item => item.id === id && item.level === 'campaign')!
      if (mode === 'unknown') selected.series![0].metrics.future_metric = selected.series![0].metrics.cpm
      else selected.series![0].metrics = selectMetaMetrics(selected.series![0].metrics, CAMPAIGN_DAILY_INPUT_KEYS)
      expect(() => validateScopedReportingPacket(packet, scope, context.asOf)).toThrow()
    }
  })
})
