import { describe, expect, it } from 'vitest'
import { buildMetaBreakdowns, buildMetaSeries, previousContext, reconcileReportOutcomes } from '@/lib/reporting/meta-breakdowns'
import { buildMetaMetrics, type MetaRow } from '@/lib/reporting/meta-metrics'
import type { MetaReport, ReportEntity, ReportingContext } from '@/lib/reporting/contracts'
import type { MetricClaim } from '@/lib/cockpit/contracts'
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
const ad = (report: MetaReport, id = '301') => report.entities.find(entity => entity.level === 'ad' && entity.id === id)!
const qualifier = (report: MetaReport, scope = 'campaign 101') => report.observations.filter(item => item.detail.includes(scope) && /Purchase hierarchy comparison is incomplete/.test(item.detail))

describe('entity-native Purchase ROAS with incomplete hierarchy evidence', () => {
  it.each(['current', 'previous'] as const)('retains the full own claim and daily/placement lineage when %s sibling Purchase fields are omitted', which => {
    const incomplete = period(row('301', 2, 200), row('302', null, null))
    const result = reconcile(which === 'current' ? incomplete : period(), which === 'previous' ? incomplete : period())
    const measured = ad(result.report)
    expect(measured.metrics.purchase_roas[which]).toEqual(ad(result.original).metrics.purchase_roas[which])
    expect(measured.metrics.purchase_roas[which]?.value).toBe(4)
    expect(measured.metrics.purchase_roas[which]?.coverage.state).toBe('complete')
    const adset = result.report.entities.find(entity => entity.level === 'adset' && entity.id === '201')!
    expect(adset.metrics.purchase_roas[which]).toEqual(result.original.entities.find(entity => entity.level === 'adset' && entity.id === '201')!.metrics.purchase_roas[which])
    expect(ad(result.report, '302').metrics.purchase_count[which]?.value).toBeNull()
    expect(ad(result.report, '302').metrics.purchase_value[which]?.value).toBeNull()
    expect(ad(result.report, '302').metrics.purchase_roas[which]?.value).toBeNull()
    expect(measured.series).toEqual(ad(result.original).series)
    expect(measured.comparisonSeries).toEqual(ad(result.original).comparisonSeries)
    expect(measured.breakdowns).toEqual(ad(result.original).breakdowns)
    expect(qualifier(result.report).some(item => item.detail.startsWith(which))).toBe(true)
    expect(result.notes.join(' ')).not.toContain('purchase_roas is withheld')
  })
  it('keeps native zero value/ROAS and missing count distinct without blocking another ad', () => {
    const { report } = reconcile(period(row('301', 2, 200), row('302', null, 0)))
    expect(ad(report).metrics.purchase_roas.current.value).toBe(4)
    expect(ad(report, '302').metrics.purchase_value.current.value).toBe(0)
    expect(ad(report, '302').metrics.purchase_roas.current.value).toBe(0)
    expect(ad(report, '302').metrics.purchase_count.current.value).toBeNull()
    expect(qualifier(report)).toHaveLength(1)
  })
  it('retains complete agreement without an incomplete qualification and preserves canonical AppointmentConfirmed', () => {
    const native = period()
    const { report, original } = reconcile({ ...native, account: [row('101', 2, 200, 100, 0)] })
    expect(ad(report).metrics.purchase_roas).toEqual(ad(original).metrics.purchase_roas)
    expect(ad(report, '302').metrics.purchase_roas.current.value).toBe(0)
    expect(qualifier(report)).toHaveLength(0)
    expect(report.metrics.purchase_roas).toEqual(original.metrics.purchase_roas)
    expect(report.metrics.bookings.current.value).toBe(2)
    expect(report.metrics.bookings.current.claimId).toMatch(/:campaign-canonical$/)
    expect(report.metrics.bookings.current.inputClaimIds).toEqual([report.entities.find(entity => entity.level === 'campaign')!.metrics.bookings.current.claimId])
    expect(ad(report).metrics.appointment_roas.current.value).toBe(4)
  })
  it.each(['parent_field', 'parent_read', 'sibling_level_read', 'empty_sibling_level'] as const)('retains valid own ROAS for %s without inventing an aggregate', mode => {
    let input = period()
    if (mode === 'parent_field') input = period(row('301', 2, 200), row('302', 0, 0), row('101', null, null, 100))
    if (mode === 'parent_read') input = { ...input, campaign: undefined }
    if (mode === 'sibling_level_read') input = { ...input, adset: undefined }
    if (mode === 'empty_sibling_level') input = { ...input, adset: [] }
    const { report } = reconcile(input)
    expect(ad(report).metrics.purchase_roas.current.value).toBe(4)
    expect(qualifier(report)).toHaveLength(1)
    if (mode === 'parent_read') expect(report.metrics.bookings.current.value).toBeNull()
  })
  it.each([
    ['missing value', row('301', 2, null)], ['malformed value', row('301', 2, 'invalid')],
    ['negative value', row('301', 2, -1)], ['missing spend', row('301', 2, 200, null)],
    ['zero spend', row('301', 2, 200, 0)], ['malformed spend', row('301', 2, 200, 'invalid')],
  ] as const)('keeps own %s unavailable even when incomplete siblings cease blocking', (_name, native) => {
    const { report, original } = reconcile(period(native, row('302', null, null)))
    expect(ad(report).metrics.purchase_roas.current.value).toBeNull()
    expect(ad(report).metrics.purchase_roas.current).toEqual(ad(original).metrics.purchase_roas.current)
  })
})

describe('supported Purchase hierarchy contradictions stay blocked', () => {
  it.each([
    ['count unavailable but complete value conflicts', row('301', 2, 200), row('302', null, 100)],
    ['value unavailable but complete count conflicts', row('301', 2, 200), row('302', 1, null)],
  ] as const)('keeps each native field independent: %s', (_name, a, b) => {
    const { report } = reconcile(period(a, b))
    expect(ad(report).metrics.purchase_roas.current.value).toBeNull()
    expect(ad(report).metrics.purchase_value.current.value).toBe(200)
    expect(ad(report).metrics.purchase_count.current.value).toBe(2)
    expect(ad(report).metrics.purchase_roas.current.availability.blockerCodes).toContain('meta_outcome_hierarchy_unreconciled')
    expect(qualifier(report)).toHaveLength(1)
  })
  it.each([200.009, 200.011])('retains the existing value tolerance for a known child subtotal %s', value => {
    const { report } = reconcile(period(row('301', 2, value), row('302', null, null)))
    expect(ad(report).metrics.purchase_roas.current.value).toBe(value - 200 > 0.01 ? null : value / 50)
  })
  it.each([
    ['complete count excess', 3, 200, 0, 0], ['complete value excess', 2, 300, 0, 0],
    ['complete count shortfall', 1, 200, 0, 0], ['complete value shortfall', 2, 100, 0, 0],
    ['known count subtotal excess', 3, 200, null, null], ['known value subtotal excess', 2, 300, null, null],
  ] as const)('withholds only the contradicted period for %s, including existing downstream policy', (_name, count, value, bCount, bValue) => {
    const current = period(row('301', 2, 200), row('302', null, null))
    const prior = period(row('301', count, value), row('302', bCount, bValue))
    const { report, original } = reconcile(current, prior)
    const entity = ad(report)
    expect(entity.metrics.purchase_roas.current).toEqual(ad(original).metrics.purchase_roas.current)
    expect(entity.metrics.purchase_roas.current.value).toBe(4)
    expect(entity.metrics.purchase_roas.previous?.value).toBeNull()
    expect(entity.metrics.purchase_roas.previous?.availability.blockerCodes).toContain('meta_outcome_hierarchy_unreconciled')
    expect(entity.metrics.purchase_value.previous?.value).toBe(value)
    expect(entity.metrics.purchase_count.previous?.value).toBe(count)
    expect(entity.series![0].metrics.purchase_roas.current.value).toBe(4)
    expect(entity.series![0].metrics.purchase_roas.previous?.value).toBeNull()
    expect(entity.comparisonSeries![0].metrics.purchase_roas.current.value).toBeNull()
    expect(entity.breakdowns![0].metrics.purchase_roas.current.value).toBe(4)
    expect(entity.breakdowns![0].metrics.purchase_roas.previous?.value).toBeNull()
    expect(entity.metrics.appointment_roas.previous?.value).toBe(4)
  })
  it('preserves a different campaign with incomplete evidence when the first campaign actually contradicts', () => {
    const input = period(row('301', 3, 300))
    const other = (value: MetaRow): MetaRow => ({ ...value, campaign_id: '102', adset_id: String(value.adset_id) + '0', ad_id: String(value.ad_id) + '0' })
    const second = period(row('301', 2, 200), row('302', null, null))
    const { report } = reconcile({ ...input, campaign: [...input.campaign!, ...second.campaign!.map(other)],
      adset: [...input.adset!, ...second.adset!.map(other)], ad: [...input.ad!, ...second.ad!.map(other)] })
    expect(ad(report).metrics.purchase_roas.current.value).toBeNull()
    expect(ad(report, '3010').metrics.purchase_roas.current.value).toBe(4)
  })
})

describe('native account is the parent of campaign Purchase observations', () => {
  it('does not add unrelated account Purchase count gating when native value agrees', () => {
    const { report, original } = reconcile({ ...period(), account: [row('101', 9, 200, 100)] })
    expect(report.metrics.purchase_roas).toEqual(original.metrics.purchase_roas)
    expect(report.metrics.purchase_roas.current.value).toBe(2)
    expect(report.metrics.purchase_count.current.value).toBe(9)
  })
  it.each(['missing_campaign_field', 'missing_campaign_read', 'empty_campaign_read'] as const)('retains own account ROAS for %s', mode => {
    const base = period()
    const campaign = mode === 'missing_campaign_field' ? [row('101', null, null, 100)] : mode === 'empty_campaign_read' ? [] : undefined
    const { report, original } = reconcile({ ...base, campaign })
    expect(report.metrics.purchase_roas.current).toEqual(original.metrics.purchase_roas.current)
    expect(report.metrics.purchase_roas.current.value).toBe(2)
    expect(report.series[0].metrics.purchase_roas.current.value).toBe(2)
    expect(qualifier(report, `account ${context.account.id}`)).toHaveLength(1)
  })
  it.each([100, 200, 300])('compares the known campaign subtotal %s against complete native account 200 in the correct direction', knownValue => {
    const base = period(row('301', 2, knownValue), row('302', 0, 0), row('101', 2, knownValue, 100))
    const unknown = { ...row('102', null, null, 10, 0), campaign_id: '102' }
    const { report, original } = reconcile({ ...base, account: [row('101', 2, 200, 100)], campaign: [...base.campaign!, unknown] })
    expect(report.metrics.purchase_roas.current.value).toBe(knownValue > 200 ? null : 2)
    expect(report.metrics.purchase_value.current.value).toBe(200)
    expect(report.metrics.purchase_roas.previous).toEqual(original.metrics.purchase_roas.previous)
    if (knownValue <= 200) expect(qualifier(report, `account ${context.account.id}`)).toHaveLength(1)
    else expect(report.metrics.purchase_roas.current.availability.blockerCodes).toContain('meta_outcome_hierarchy_unreconciled')
  })
  it.each([100, 300])('keeps complete account/campaign value disagreement (%s vs 200) blocked', nativeValue => {
    const { report } = reconcile({ ...period(), account: [row('101', 2, nativeValue, 100)] })
    expect(report.metrics.purchase_roas.current.value).toBeNull()
    expect(report.metrics.purchase_value.current.value).toBe(nativeValue)
    expect(report.series[0].metrics.purchase_roas.current.value).toBeNull()
    expect(report.breakdowns[0].metrics.purchase_roas.current.value).toBeNull()
    expect(report.metrics.purchase_roas.previous?.value).toBe(2)
  })
})
