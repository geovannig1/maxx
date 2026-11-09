import { createMetricClaim, type MetricClaim } from '@/lib/cockpit/contracts'
import { reconcileMetaOutcomeHierarchy } from '@/lib/sync/insight-outcomes'
import type { MetaInsightRow } from '@/types/meta-api'
import type { MetaReport, ReportMetricMap, ReportBreakdown, ReportSeriesPoint, ReportingContext, ReportingRange } from './contracts'
import { projectCampaignAuthority } from './meta-campaign-authority'
import { buildMetaMetrics, readMetaOutcomeValues, type MetaRow } from './meta-metrics'
import { META_NATIVE_METRIC_DEFINITIONS, META_RATIO_METRIC_DEFINITIONS } from './meta-metric-definitions'

export const META_DIMENSION_KEYS = ['placement', 'age', 'gender', 'region'] as const
export type MetaDimension = typeof META_DIMENSION_KEYS[number]
export const META_DIMENSIONS: Record<MetaDimension, readonly string[]> = {
  placement: ['publisher_platform', 'platform_position'], age: ['age'], gender: ['gender'], region: ['region'],
}
export const dayOffset = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10)

const RESPONSE_METRICS = ['spend', 'impressions', 'video_2s', 'cost_per_2s_view', 'thruplays', 'cost_per_thruplay',
  'action_video_views', 'cost_per_action_video_view', 'engagements', 'engagement_rate', 'cost_per_engagement',
  'reactions', 'comments', 'shares', 'share_rate', 'cost_per_share', 'saves',
  'messaging_conversations_started', 'cost_per_messaging_conversation_started', 'messaging_conversations_replied',
  'messaging_first_replies', 'instagram_profile_visits', 'cost_per_instagram_profile_visit',
  'instagram_profile_follows', 'cost_per_instagram_profile_follow', 'outbound_clicks', 'outbound_ctr',
  'landing_page_views', 'bookings', 'cost_per_booking', 'appointment_value', 'appointment_roas']
const BREAKDOWN_METRICS = ['spend', 'impressions', 'reach', 'frequency', 'cpm', 'bookings', 'cost_per_booking', 'purchase_count', 'purchase_value', 'purchase_roas', 'cost_per_purchase', 'outbound_clicks', 'landing_page_views', ...RESPONSE_METRICS]
export const META_DAILY_METRIC_KEYS = [...META_NATIVE_METRIC_DEFINITIONS.map(metric => metric.key), ...META_RATIO_METRIC_DEFINITIONS.map(([key]) => key)]
export const CAMPAIGN_DAILY_INPUT_KEYS = ['bookings', 'appointment_value', 'bookings_click', 'bookings_view']

/** A time-increment query is an independent observation even for a one-day report. */
export function dailyMetaMetrics(metrics: ReportMetricMap): ReportMetricMap {
  const ids = new Map(Object.values(metrics).flatMap(metric => [metric.current, metric.previous].flatMap(claim => claim ? [[claim.claimId, `${claim.claimId}:daily`] as const] : [])))
  const claim = (value: MetricClaim) => createMetricClaim({ ...value, claimId: ids.get(value.claimId)!, inputClaimIds: value.inputClaimIds.map(id => ids.get(id) ?? id) })
  return Object.fromEntries(Object.entries(metrics).map(([key, metric]) => [key, { ...metric, current: claim(metric.current), previous: metric.previous ? claim(metric.previous) : null }]))
}

/** Keep the selected measures and every current/prior input needed to inspect their lineage. */
export function selectMetaMetrics(metrics: ReportMetricMap, keys: string[]): ReportMetricMap {
  const byClaim = new Map(Object.entries(metrics).flatMap(([key, metric]) => [metric.current, metric.previous].flatMap(claim => claim ? [[claim.claimId, key] as const] : [])))
  const selected = new Set(keys.filter(key => key in metrics))
  for (const key of selected) {
    for (const claim of [metrics[key].current, metrics[key].previous]) {
      for (const id of claim?.inputClaimIds ?? []) {
        const input = byClaim.get(id)
        if (input) selected.add(input)
      }
    }
  }
  return Object.fromEntries(Object.entries(metrics).filter(([key]) => selected.has(key)))
}

/** Inventory-only entities need no full unavailable map; cross-entity canonical inputs stay visible. */
export function omitUnavailableEntityMetrics(report: MetaReport): MetaReport {
  const referenced = new Set(Object.values(report.metrics).flatMap(metric => [metric.current, metric.previous].flatMap(claim => claim?.inputClaimIds ?? [])))
  return { ...report, entities: report.entities.map(entity => {
    if (Object.values(entity.metrics).some(metric => metric.current.value !== null || metric.previous?.value != null)) return entity
    const required = Object.entries(entity.metrics).filter(([, metric]) => referenced.has(metric.current.claimId) || Boolean(metric.previous && referenced.has(metric.previous.claimId))).map(([key]) => key)
    return { ...entity, metrics: selectMetaMetrics(entity.metrics, required) }
  }) }
}

export function buildMetaSeries(
  context: ReportingContext, rows: MetaRow[], previousRows: MetaRow[] | null,
  entity: MetricClaim['entity'] = { level: 'account', id: context.account.id },
  metricKeys = entity.level === 'campaign' ? CAMPAIGN_DAILY_INPUT_KEYS : META_DAILY_METRIC_KEYS,
): ReportSeriesPoint[] {
  const previousByDate = new Map((previousRows ?? []).map(row => [row.date_start, row]))
  const distance = (Date.parse(context.range.from) - Date.parse(context.comparison.from)) / 86_400_000
  return [...rows].sort((a, b) => String(a.date_start).localeCompare(String(b.date_start))).map(row => {
    const date = String(row.date_start)
    const previousDate = dayOffset(date, -distance)
    const dayContext = { ...context, range: { from: date, to: date }, comparison: { from: previousDate, to: previousDate } }
    // Selection keeps every input of a selected claim, so re-identifying only the selection is exact.
    return { date, metrics: dailyMetaMetrics(selectMetaMetrics(buildMetaMetrics(dayContext, row, previousRows === null ? undefined : previousByDate.get(previousDate) ?? null, entity, metricKeys), metricKeys)) }
  })
}

export function previousContext(context: ReportingContext): ReportingContext {
  const days = (Date.parse(context.range.to) - Date.parse(context.range.from)) / 86_400_000 + 1
  return { ...context, range: context.comparison, comparison: { from: dayOffset(context.comparison.from, -days), to: dayOffset(context.comparison.to, -days) } }
}

export function dimensionKey(row: MetaRow, dimension: MetaDimension): string {
  return META_DIMENSIONS[dimension].map(field => String(row[field])).join(' / ')
}

export function buildMetaBreakdowns(
  context: ReportingContext, dimension: MetaDimension, current: MetaRow[], previous: MetaRow[] | null,
  entity: MetricClaim['entity'] = { level: 'account', id: context.account.id },
): ReportBreakdown[] {
  const currentByKey = new Map(current.map(row => [dimensionKey(row, dimension), row]))
  const previousByKey = new Map((previous ?? []).map(row => [dimensionKey(row, dimension), row]))
  const labels = [...new Set([...currentByKey.keys(), ...previousByKey.keys()])].sort()
  return labels.map(label => ({
    id: `${entity.level}:${entity.id}:${dimension}:${label}`, dimension, label,
    metrics: selectMetaMetrics(buildMetaMetrics(context, currentByKey.get(label) ?? null, previousByKey.get(label) ?? null,
      { ...entity, id: `${entity.id}:${dimension}:${label}` }, BREAKDOWN_METRICS), BREAKDOWN_METRICS),
  }))
}

/** Reject another population/window or duplicate native rows before any claim is created. */
export function validateMetaReportRows(rows: MetaRow[], range: ReportingRange, level: string, daily: boolean, dimension?: MetaDimension): MetaRow[] {
  const keys = rows.map(row => {
    const start = row.date_start
    const stop = row.date_stop
    if (typeof start !== 'string' || typeof stop !== 'string'
      || !/^\d{4}-\d{2}-\d{2}$/.test(start) || !Number.isFinite(Date.parse(start))
      || new Date(`${start}T00:00:00Z`).toISOString().slice(0, 10) !== start
      || (daily ? start !== stop || start < range.from || start > range.to : start !== range.from || stop !== range.to)) {
      throw new Error('Meta reporting window mismatch')
    }
    const id = level === 'account' ? 'account' : row[`${level}_id`]
    if (typeof id !== 'string' || !id.trim()) throw new Error('Meta entity identity unavailable')
    if (dimension && META_DIMENSIONS[dimension].some(field => typeof row[field] !== 'string' || !(row[field] as string).trim())) throw new Error('Meta breakdown identity unavailable')
    return `${id}:${start}:${dimension ? dimensionKey(row, dimension) : ''}`
  })
  if (new Set(keys).size !== keys.length) throw new Error('Duplicate Meta report population')
  return rows
}


function groupByCampaign(rows: MetaRow[] | undefined): Map<unknown, MetaRow[]> {
  const groups = new Map<unknown, MetaRow[]>()
  for (const row of rows ?? []) {
    const group = groups.get(row.campaign_id)
    if (group) group.push(row)
    else groups.set(row.campaign_id, [row])
  }
  return groups
}

type EfficiencyKey = 'cost_per_booking' | 'appointment_roas' | 'purchase_roas' | 'cost_per_purchase'
type BlockedEfficiency = { current: Set<EfficiencyKey>; previous: Set<EfficiencyKey> }

function purchaseTotal(rows: MetaRow[] | undefined, key: 'purchase_count' | 'purchase_value') {
  const values = (rows ?? []).map(row => readMetaOutcomeValues(row)[key])
  const known = values.filter((value): value is number => value !== null && value !== undefined)
  const subtotal = known.length ? known.reduce((sum, value) => sum + value, 0) : null
  return { complete: values.length > 0 && known.length === values.length ? subtotal : null, known: subtotal }
}

function purchaseComparison(parentRows: MetaRow[] | undefined, childRows: MetaRow[] | undefined, key: 'purchase_count' | 'purchase_value') {
  const parent = purchaseTotal(parentRows, key)
  const children = purchaseTotal(childRows, key)
  const tolerance = key === 'purchase_value' ? 0.01 : 0.5
  // Missing nonnegative children cannot repair a known subtotal already above a complete parent.
  const contradiction = parent.complete !== null && (children.complete !== null
    ? Math.abs(parent.complete - children.complete) > tolerance
    : children.known !== null && children.known - parent.complete > tolerance)
  return { state: contradiction ? 'contradicted' : parent.complete !== null && children.complete !== null ? 'agreed' : 'incomplete',
    observed: parent.known !== null || children.known !== null }
}

function withheldMetrics(metrics: ReportMetricMap, blocked: BlockedEfficiency): ReportMetricMap {
  return Object.fromEntries(Object.entries(metrics).map(([key, metric]) => {
    const withhold = (claim: MetricClaim | null, prior: boolean) => claim && blocked[prior ? 'previous' : 'current'].has(key as EfficiencyKey)
      ? createMetricClaim({ ...claim, value: null, availability: { state: 'unavailable', blockerCodes: ['meta_outcome_hierarchy_unreconciled'] }, coverage: { state: 'unknown', numerator: null, denominator: null } }) : claim
    return [key, { ...metric, current: withhold(metric.current, false)!, previous: withhold(metric.previous, true) }]
  }))
}

/** Native values stay inspectable; incomplete Purchase siblings do not contradict an entity's own ratio. */
export function reconcileReportOutcomes(context: ReportingContext, report: MetaReport, reads: Map<string, MetaRow[]>): { report: MetaReport; notes: string[] } {
  const blocked = new Map<string, BlockedEfficiency>()
  const notes: string[] = []
  const observations: MetaReport['observations'] = []
  const block = (identity: string, period: 'current' | 'previous', keys: EfficiencyKey[]) => {
    const value = blocked.get(identity) ?? { current: new Set<EfficiencyKey>(), previous: new Set<EfficiencyKey>() }
    blocked.set(identity, { ...value, [period]: new Set([...value[period], ...keys]) })
  }
  const qualifyPurchase = (period: 'current' | 'previous', level: 'account' | 'campaign', id: string, fields: string[]) => {
    if (!fields.length) return
    const detail = `${period} ${level} ${id} Purchase hierarchy comparison is incomplete (${fields.join(', ')}). Missing fields are unknown, not zero. Native ROAS uses own value/spend; cost per reported Purchase uses own spend/count. Valid own-input calculations are retained unless their applicable hierarchy comparison has a supported contradiction.`
    notes.push(detail)
    observations.push({ id: `purchase-coverage:${period}:${level}:${id}`, title: 'Purchase hierarchy coverage is incomplete', detail,
      kind: 'quality', entityId: level === 'account' ? null : id, observedAt: context.asOf })
  }
  for (const period of ['current', 'previous'] as const) {
    const range = period === 'current' ? context.range : context.comparison
    const campaigns = reads.get(`${period}:campaign`)
    const adsets = reads.get(`${period}:adset`)
    const ads = reads.get(`${period}:ad`)
    const ids = [...new Set([...(campaigns ?? []), ...(adsets ?? []), ...(ads ?? [])].map(row => String(row.campaign_id ?? 'unknown')))]
    // One grouping pass per level; a filter per campaign made this campaigns x rows.
    const [campaignsBy, adsetsBy, adsBy] = [campaigns, adsets, ads].map(groupByCampaign)
    for (const id of ids) {
      const selected = { campaign: campaigns && (campaignsBy.get(id) ?? []), adset: adsets && (adsetsBy.get(id) ?? []), ad: ads && (adsBy.get(id) ?? []) }
      let appointmentIssues: string[]
      try {
        const check = reconcileMetaOutcomeHierarchy({ campaign: (selected.campaign ?? []) as unknown as MetaInsightRow[], adset: (selected.adset ?? []) as unknown as MetaInsightRow[], ad: (selected.ad ?? []) as unknown as MetaInsightRow[], since: range.from, until: range.to })
        appointmentIssues = check.blockerCodes.filter(code => !code.includes('_leads_'))
      } catch { appointmentIssues = ['meta_outcome_payload_invalid'] }
      if (!selected.campaign?.length && ((selected.adset?.length ?? 0) + (selected.ad?.length ?? 0) > 0)) appointmentIssues.push('campaign_authority_unavailable')
      const purchaseChecks = (['purchase_count', 'purchase_value'] as const).flatMap(key =>
        (['adset', 'ad'] as const).map(level => ({ key, level, ...purchaseComparison(selected.campaign, selected[level], key) })))
      const purchaseIssues = purchaseChecks.filter(check => check.state === 'contradicted').map(check => `${check.level}_${check.key}_unreconciled`)
      const purchaseCountConflict = purchaseChecks.some(check => check.key === 'purchase_count' && check.state === 'contradicted')
      qualifyPurchase(period, 'campaign', id, purchaseChecks.filter(check => check.state === 'incomplete' && check.observed)
        .map(check => `${check.level} Purchase ${check.key === 'purchase_count' ? 'count' : 'value'}`))
      if (!appointmentIssues.length && !purchaseIssues.length) continue
      const keys: EfficiencyKey[] = [...(appointmentIssues.length ? ['cost_per_booking', 'appointment_roas'] as const : []),
        ...(purchaseIssues.length ? ['purchase_roas'] as const : []), ...(purchaseCountConflict ? ['cost_per_purchase'] as const : [])]
      for (const level of ['adset', 'ad'] as const) for (const row of selected[level] ?? []) block(`${level}:${row[`${level}_id`]}`, period, keys)
      const detail = `${period} campaign ${id} outcome hierarchy could not be reconciled (${[...appointmentIssues, ...purchaseIssues].join(', ')}). Native counts and values remain diagnostic observations; affected lower-level efficiency is withheld.`
      notes.push(detail)
      observations.push({ id: `hierarchy:${period}:${id}`, title: 'Outcome hierarchy needs reconciliation', detail, kind: 'quality', entityId: id, observedAt: context.asOf })
    }
    // Native account is the parent, campaigns its children; unknown campaigns cannot be treated as zero.
    const account = reads.get(`${period}:account`)
    const accountChecks = ([['purchase_value', 'purchase_roas'], ['purchase_count', 'cost_per_purchase']] as const)
      .map(([key, efficiency]) => ({ key, efficiency, ...purchaseComparison(account, campaigns, key) }))
    qualifyPurchase(period, 'account', context.account.id, accountChecks.filter(check => check.state === 'incomplete' && check.observed)
      .map(check => `campaign Purchase ${check.key === 'purchase_count' ? 'count' : 'value'}`))
    for (const { key, efficiency, ...check } of accountChecks) {
      if (check.state === 'contradicted') {
        block(`account:${context.account.id}`, period, [efficiency])
        notes.push(`${period} account ${key} is not reconciled to campaign authority; its native observation is retained and ${efficiency} is withheld.`)
      }
    }
  }
  const adjusted = report.entities.map(entity => {
    const issue = blocked.get(`${entity.level}:${entity.id}`)
    if (!issue) return entity
    return { ...entity, metrics: withheldMetrics(entity.metrics, issue),
      series: entity.series?.map(point => ({ ...point, metrics: withheldMetrics(point.metrics, issue) })),
      comparisonSeries: entity.comparisonSeries?.map(point => ({ ...point, metrics: withheldMetrics(point.metrics, { current: issue.previous, previous: new Set() }) })),
      breakdowns: entity.breakdowns?.map(row => ({ ...row, metrics: withheldMetrics(row.metrics, issue) })),
    }
  })
  const accountIssue = blocked.get(`account:${context.account.id}`)
  const native = { ...report, metrics: accountIssue ? withheldMetrics(report.metrics, accountIssue) : report.metrics,
    series: accountIssue ? report.series.map(point => ({ ...point, metrics: withheldMetrics(point.metrics, accountIssue) })) : report.series,
    comparisonSeries: accountIssue ? report.comparisonSeries.map(point => ({ ...point, metrics: withheldMetrics(point.metrics, { current: accountIssue.previous, previous: new Set() }) })) : report.comparisonSeries,
    breakdowns: accountIssue ? report.breakdowns.map(row => ({ ...row, metrics: withheldMetrics(row.metrics, accountIssue) })) : report.breakdowns,
    entities: adjusted, observations: [...report.observations, ...observations] }
  const projected = projectCampaignAuthority(context, native, reads)
  return { report: projected.report, notes: [...projected.notes, ...notes] }
}
