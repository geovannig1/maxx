import type { ReportEntity, ReportMetric, ReportingData } from './contracts'
import { OVERVIEW_EVENTS, overviewNumber, type OverviewEvent } from './overview-model'
import { audienceConfigurationEvidence } from './review/evidence'
import { audienceConfigurationState, reportAudienceMemberState } from './audience-evidence'

export type HierarchyLevel = 'adset' | 'campaign'
type MetricEntity = Pick<ReportEntity, 'id' | 'metrics'> & { level: ReportEntity['level'] | 'account' }

/** Keep each displayed number bound to its entity, selected period and named Meta event. */
export function hierarchyMetric(data: ReportingData, entity: MetricEntity, key: string, event: OverviewEvent): ReportMetric | undefined {
  const metric = entity.metrics[key], claim = metric?.current, value = overviewNumber(metric)
  const isEvent = [event.count, event.cpa, event.value, event.roas].some(value => value === key)
  const unit = key === event.count ? 'count' : key === event.roas || key === 'frequency' ? 'ratio' : 'money'
  if (!['available', 'partial'].includes(data.meta.state) || !claim
    || entity.level === 'account' && entity.id !== data.context.account.id
    || metric.key !== key || metric.event !== (isEvent ? event.label : null) || claim.unit !== unit
    || claim.metricKey !== `meta.${key}` || claim.entity.id !== entity.id || claim.entity.level !== entity.level
    || claim.source.system !== 'meta' || claim.source.role !== 'delivery_truth' || claim.source.evidencePlane !== 'meta_delivery'
    || claim.window.start !== data.context.range.from || claim.window.end !== data.context.range.to
    || claim.window.timezone !== data.context.timezone || claim.window.basis !== 'impression_date_et'
    || !data.meta.asOf || Date.parse(claim.asOf) !== Date.parse(data.meta.asOf)
    || Date.parse(claim.asOf) > Date.parse(data.context.asOf)) return undefined
  if ((key === event.cpa || key === event.roas) && claim.availability.state === 'unavailable'
    && claim.availability.blockerCodes.includes('meta_outcome_hierarchy_unreconciled')) return metric
  if (value === null || value < 0 || key === event.count && !Number.isSafeInteger(value)) return undefined
  if (key === event.cpa || key === event.roas) {
    const a = hierarchyMetric(data, entity, key === event.cpa ? 'spend' : event.value, event)
    const b = hierarchyMetric(data, entity, key === event.cpa ? event.count : 'spend', event)
    const numerator = overviewNumber(a), denominator = overviewNumber(b)
    if (!a || !b || numerator === null || denominator === null || denominator <= 0
      || [claim, a.current, b.current].some(input => input.coverage.state !== 'complete')
      || a.current.source.head !== b.current.source.head
      || claim.inputClaimIds.length !== 2 || claim.inputClaimIds[0] !== a.current.claimId || claim.inputClaimIds[1] !== b.current.claimId
      || Math.abs(value - numerator / denominator) > Number.EPSILON * Math.max(1, value) * 8) return undefined
  }
  return metric
}

export function hierarchyHasNoResults(data: ReportingData, entity: MetricEntity, event: OverviewEvent): boolean {
  const count = hierarchyMetric(data, entity, event.count, event)
  return overviewNumber(count) === 0 && count?.current.coverage.state === 'complete'
}

export function hierarchyPopulation(data: ReportingData, level: HierarchyLevel, query: string) {
  const population = ['available', 'partial'].includes(data.meta.state) ? (data.meta.data?.entities ?? []).filter(entity => entity.level === level) : []
  const spend = (entity: ReportEntity) => overviewNumber(hierarchyMetric(data, entity, 'spend', OVERVIEW_EVENTS.purchase))
  const needle = query.trim().toLowerCase()
  const rows = population.filter(entity => [entity.name, entity.id, entity.campaignName, entity.campaignId, entity.audienceLabel, entity.status]
    .some(value => value?.toLowerCase().includes(needle))).sort((a, b) => {
      const first = spend(a), second = spend(b)
      if (first === null && second !== null) return 1
      if (second === null && first !== null) return -1
      return (second ?? 0) - (first ?? 0) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id)
    })
  return { population, rows, maxSpend: population.reduce((max, entity) => Math.max(max, spend(entity) ?? 0), 0) }
}

export function hierarchyAudience(data: ReportingData, entity: ReportEntity) {
  const index = data.meta.data?.entities.findIndex(row => row.level === 'adset' && row.id === entity.id) ?? -1
  return entity.level === 'adset' ? audienceConfigurationEvidence(data, index)?.value : undefined
}

export function hierarchyAudienceConcerns(data: ReportingData) {
  return (data.meta.data?.entities ?? []).flatMap(entity => {
    const evidence = hierarchyAudience(data, entity)
    if (!evidence) return []
    const configuration = audienceConfigurationState(evidence, data.context.asOf)
    const members = evidence.members.filter(member => reportAudienceMemberState(member, evidence, data.context.asOf) !== 'resolved')
    const conflict = evidence.members.filter(member => member.role === 'included' && evidence.members.some(other => other.id === member.id && other.role === 'excluded'))
    if (configuration === 'observed' && !members.length && !conflict.length) return []
    return [{ entity, evidence, configuration, members, conflict }]
  })
}
