import { createMetricClaim } from '@/lib/cockpit/contracts'
import type { MetaReport, ReportMetricMap, ReportSeriesPoint, ReportingContext } from './contracts'
import { CAMPAIGN_DAILY_INPUT_KEYS, dailyMetaMetrics, dayOffset, META_DAILY_METRIC_KEYS, previousContext, selectMetaMetrics } from './meta-breakdowns'
import { projectCampaignAuthority } from './meta-campaign-authority'
import { buildMetaMetrics, type MetaRow } from './meta-metrics'

const CANONICAL_KEYS = [...CAMPAIGN_DAILY_INPUT_KEYS, 'cost_per_booking', 'appointment_roas']

function byDate(rows: MetaRow[]): Map<string, MetaRow[]> {
  const dates = new Map<string, MetaRow[]>()
  for (const row of rows) {
    const date = String(row.date_start)
    const group = dates.get(date)
    if (group) group.push(row)
    else dates.set(date, [row])
  }
  return dates
}

function canonicalDayIdentity(metrics: ReportMetricMap, context: ReportingContext, priorSeries: boolean): ReportMetricMap {
  const ids = new Map(CANONICAL_KEYS.flatMap(key => [metrics[key].current, metrics[key].previous]
    .flatMap(claim => claim ? [[claim.claimId, claim.claimId.replace(/:campaign-canonical$/, ':campaign-daily-canonical')] as const] : [])))
  return Object.fromEntries(Object.entries(metrics).map(([key, metric]) => {
    if (!CANONICAL_KEYS.includes(key)) return [key, metric]
    const definition = `Daily campaign authority. ${metric.definition}`
    const claim = (value: typeof metric.current) => createMetricClaim({ ...value,
      claimId: ids.get(value.claimId)!, formula: definition.slice(0, 500),
      source: { ...value.source, head: `meta-campaign-daily-authority:${context.account.metaAccountId}:${context.asOf}` },
      inputClaimIds: value.inputClaimIds.map(id => ids.get(id) ?? id),
    })
    return [key, { ...metric, definition, current: claim(metric.current), previous: !priorSeries && metric.previous ? claim(metric.previous) : null }]
  }))
}

/** Project each observed day independently; omitted campaign days are never inferred zero.
 * The existing entity series retain the exact campaign inputs used by every derived day. */
export function projectMetaDailyAuthority(context: ReportingContext, report: MetaReport, reads: Map<string, MetaRow[]>): MetaReport {
  const campaignRows = { current: byDate(reads.get('current:campaign:daily') ?? []), previous: byDate(reads.get('previous:campaign:daily') ?? []) }
  const accountRows = { current: byDate(reads.get('current:account:daily') ?? []), previous: byDate(reads.get('previous:account:daily') ?? []) }
  const campaigns = report.entities.filter(entity => entity.level === 'campaign')
  const campaignInputs = new Map(campaigns.map(entity => [entity.id, {
    current: new Map((entity.series ?? []).map(point => [point.date, point.metrics])),
    previous: new Map((entity.comparisonSeries ?? []).map(point => [point.date, point.metrics])),
  }]))
  const series = (prior: boolean): ReportSeriesPoint[] => {
    const period = prior ? 'previous' : 'current'
    const scope = prior ? previousContext(context) : context
    const distance = (Date.parse(scope.range.from) - Date.parse(scope.comparison.from)) / 86_400_000
    const native = new Map((prior ? report.comparisonSeries : report.series).map(point => [point.date, point.metrics]))
    const dates = [...new Set([...accountRows[period].keys(), ...campaignRows[period].keys()])].sort()
    return dates.map(date => {
      const previousDate = dayOffset(date, -distance)
      const dayContext = { ...scope, range: { from: date, to: date }, comparison: { from: previousDate, to: previousDate } }
      const currentRows = campaignRows[period].get(date) ?? []
      const previousRows = prior ? [] : campaignRows.previous.get(previousDate) ?? []
      const ids = new Set([...currentRows, ...previousRows].map(row => String(row.campaign_id)))
      const inputs = campaigns.filter(entity => ids.has(entity.id)).map(entity => {
        const byPeriod = campaignInputs.get(entity.id)!
        const current = byPeriod[period].get(date)
        const previous = prior ? undefined : byPeriod.previous.get(previousDate)
        // The raw period row lists below determine which side can be an input.
        const metrics = Object.fromEntries(CAMPAIGN_DAILY_INPUT_KEYS.map(key => [key, {
          ...(current ?? previous)![key], previous: previous?.[key].current ?? null,
        }]))
        return { ...entity, metrics }
      })
      const nativeMetrics = native.get(date) ?? dailyMetaMetrics(buildMetaMetrics(dayContext,
        accountRows[period].get(date)?.[0] ?? null, prior ? undefined : accountRows.previous.get(previousDate)?.[0] ?? null))
      const projected = projectCampaignAuthority(dayContext, { ...report, metrics: nativeMetrics, entities: inputs },
        new Map([['current:campaign', currentRows], ['previous:campaign', previousRows]])).report.metrics
      return { date, metrics: selectMetaMetrics(canonicalDayIdentity(projected, context, prior), META_DAILY_METRIC_KEYS) }
    })
  }
  return { ...report, series: series(false), comparisonSeries: series(true),
    sourceDescription: `${report.sourceDescription} Daily AppointmentConfirmed claims use independently read campaign-day inputs. Native account delivery and Purchase observations retain their own authority; omitted campaign dates are unknown.` }
}
