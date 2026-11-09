import type { ReportEntity, ReportingContext, ReportingPacket } from '@/lib/reporting/contracts'
import { buildMetaMetrics, type MetaRow } from '@/lib/reporting/meta-metrics'
import { reconcileReportOutcomes } from '@/lib/reporting/meta-breakdowns'
import { createMetricClaim } from '@/lib/cockpit/contracts'
import { snapshotContext } from './reporting-snapshot'

/** Fictional native observations: an eligible ad and another ad with omitted Purchase fields. */
export function purchasePacket(context: ReportingContext = snapshotContext, legacy = false): Extract<ReportingPacket, { section: 'meta' }> {
  const native = (level: ReportEntity['level'] | 'account', id: string, prior: boolean, missing = false): MetaRow => {
    const range = prior ? context.comparison : context.range
    const purchaseValue = prior ? 100 : 200
    return { account_id: '123', campaign_id: '101', adset_id: '201', ad_id: id,
      date_start: range.from, date_stop: range.to,
      spend: level === 'ad' ? (id === '301' && prior ? '80' : '50') : prior ? '130' : '100',
      impressions: level === 'ad' ? '1000' : '2000',
      results: [{ indicator: 'AppointmentConfirmed', values: [
        { value: '0', attribution_windows: ['default'] }, { value: '0', attribution_windows: ['7d_click'] },
        { value: '0', attribution_windows: ['1d_view'] },
      ] }],
      conversion_values: [{ action_type: 'AppointmentConfirmed', value: '0' }],
      ...(missing ? {} : { actions: [{ action_type: 'purchase', value: prior ? '1' : '2' }],
        action_values: [{ action_type: 'purchase', value: String(purchaseValue) }] }),
    }
  }
  const groups = [['campaign', '101'], ['adset', '201'], ['ad', '301'], ['ad', '302']] as const
  const rows = new Map(groups.map(([level, id]) => [`${level}:${id}`, [native(level, id, false, id === '302'), native(level, id, true, id === '302')]]))
  const entities: ReportEntity[] = groups.map(([level, id]) => {
    const [current, previous] = rows.get(`${level}:${id}`)!
    return { level, id, name: id === '301' ? 'Fictional observed ad' : id === '302' ? 'Fictional missing Purchase ad' : `Fictional ${level}`,
      campaignId: '101', campaignName: 'Fictional campaign', adsetId: level === 'campaign' ? null : '201',
      adsetName: level === 'campaign' ? null : 'Fictional adset', status: 'ACTIVE', configurationAsOf: context.asOf,
      audience: 'unknown', audienceLabel: 'Fictional audience unknown', creative: null,
      metrics: buildMetaMetrics(context, current, previous, { level, id }),
    }
  })
  const currentAccount = native('account', '123', false), priorAccount = native('account', '123', true)
  const reads = new Map<string, MetaRow[]>()
  for (const [index, period] of ['current', 'previous'].entries()) {
    reads.set(`${period}:account`, [index ? priorAccount : currentAccount])
    for (const level of ['campaign', 'adset', 'ad']) reads.set(`${period}:${level}`,
      groups.filter(([candidate]) => candidate === level).map(([candidate, id]) => rows.get(`${candidate}:${id}`)![index]))
  }
  const result = reconcileReportOutcomes(context, {
    metrics: buildMetaMetrics(context, currentAccount, priorAccount), entities,
    series: [], comparisonSeries: [], breakdowns: [], observations: [], detailState: 'complete',
    attributionWindow: '7-day click / 1-day view', reportingTime: 'Impression date in America/New_York',
    sourceDescription: 'Fictional native evidence for Purchase reporting continuity.',
  }, reads)
  const oldClaim = (claim: ReturnType<typeof createMetricClaim>) => createMetricClaim({ ...claim, value: null,
    availability: { state: 'unavailable', blockerCodes: ['meta_outcome_hierarchy_unreconciled'] },
    coverage: { state: 'unknown', numerator: null, denominator: null } })
  const data = legacy ? { ...result.report, observations: [], entities: result.report.entities.map(entity => {
    if (entity.level === 'campaign') return entity
    const metric = entity.metrics.purchase_roas
    return { ...entity, metrics: { ...entity.metrics, purchase_roas: { ...metric,
      current: oldClaim(metric.current), previous: metric.previous ? oldClaim(metric.previous) : null } } }
  }) } : result.report
  return { context, section: 'meta', notes: ['Fictional Purchase continuity fixture.'], result: {
    state: 'partial', asOf: context.asOf, data,
    notes: legacy ? ['Original fictional report withheld lower-level Purchase ROAS for incomplete hierarchy.'] : result.notes,
  } }
}
