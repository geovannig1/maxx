import { buildMetaMetrics, type MetaRow } from '../../src/lib/reporting/meta-metrics'
import { projectCampaignAuthority } from '../../src/lib/reporting/meta-campaign-authority'
import type { ReportEntity, ReportingContext, ReportingData } from '../../src/lib/reporting/contracts'
import { previousReportingRange } from '../../src/lib/reporting/range'

type Values = readonly [spend: number, count: number | null, value: number | null, purchases: number, purchaseValue: number]
const entries: Array<{ id: string; name: string; current: Values; prior: Values }> = [
  { id: 'large', name: 'Larger campaign', current: [900, 12, 1200, 3, 300], prior: [900, 10, 1000, 5, 500] },
  { id: 'small', name: 'Smaller loss', current: [30, 1, 100, 2, 200], prior: [30, 3, 300, 1, 100] },
  { id: 'lower', name: 'Lower spend and value', current: [20, 2, 200, 1, 100], prior: [100, 3, 300, 1, 100] },
]
function raw(values: Values): MetaRow {
  const [spend, count, value, purchases, purchaseValue] = values
  return { spend: String(spend), impressions: '1000',
    ...(count === null ? {} : { results: [{ indicator: 'AppointmentConfirmed', values: [{ value: String(count), attribution_windows: ['default'] }] }] }),
    ...(value === null ? {} : { conversion_values: [{ action_type: 'AppointmentConfirmed', value: String(value) }] }),
    actions: [{ action_type: 'purchase', value: String(purchases) }], action_values: [{ action_type: 'purchase', value: String(purchaseValue) }] }
}
export function mediaMovementFixture(from = '2026-08-20', to = '2026-08-22', account: ReportingContext['account'] = {
  id: 'fixture-account', metaAccountId: '123', name: 'Fictional media movement' }, asOf = '2026-09-20T16:00:00Z'): ReportingData {
  const context: ReportingContext = { account, range: { from, to }, comparison: previousReportingRange({ from, to }),
    timezone: 'America/New_York', currency: 'USD', asOf }
  const entities = (['campaign', 'adset', 'ad'] as const).flatMap(level => entries.map(entry => {
    const id = level === 'campaign' ? entry.id : `${level}-${entry.id}`
    return { id, level, name: `${entry.name}${level === 'campaign' ? '' : ` ${level}`}`, campaignId: entry.id, campaignName: entry.name,
      adsetId: level === 'campaign' ? null : `adset-${entry.id}`, adsetName: level === 'campaign' ? null : `${entry.name} adset`,
      status: 'ACTIVE', configurationAsOf: asOf, audience: 'unknown', audienceLabel: 'Unknown', creative: null,
      metrics: buildMetaMetrics(context, raw(entry.current), raw(entry.prior), { level, id }) } satisfies ReportEntity
  }))
  const sum = (period: 'current' | 'prior') => entries.reduce<number[]>((total, entry) => total.map((value, i) => value + entry[period][i]!), [0, 0, 0, 0, 0]) as unknown as Values
  const report = projectCampaignAuthority(context, {
    metrics: buildMetaMetrics(context, raw(sum('current')), raw(sum('prior')), { id: account.id, level: 'account' }),
    entities, series: [], comparisonSeries: [], breakdowns: [], observations: [], detailState: 'complete',
    attributionWindow: 'Native entity attribution settings', reportingTime: 'Impression date', sourceDescription: 'Fictional native rows; campaign-authority adapter applied.',
  }, new Map(['current', 'previous'].map(period => [`${period}:campaign`, entries.map(entry => ({ campaign_id: entry.id }))]))).report
  const unavailable = { state: 'unavailable' as const, data: null, asOf: null, notes: ['This fictional scenario supplies Meta only.'] }
  return { context, meta: { state: 'available', data: report, asOf, notes: ['Fictional data, no connected studio evidence.'] },
    business: unavailable, website: unavailable, measurement: unavailable }
}
