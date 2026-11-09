import type { ReportEntity, ReportMetric, ReportingContext } from './contracts'
import { comparable } from './review/evidence'
import { compareCreativeEvidenceInstants } from './creative-assignment-contract'
import { META_NATIVE_METRIC_DEFINITIONS, META_RATIO_METRIC_DEFINITIONS, metaNativeMetricDescription } from './meta-metric-definitions'

export const RETENTION_MILESTONES = [25, 50, 75, 100] as const
export interface RetentionPoint {
  milestone: number
  value: number | null
  count: number | null
  starts: number | null
  reason: string | null
}
const nativeDefinitions = new Map(META_NATIVE_METRIC_DEFINITIONS.map(item => [item.key, item]))
function expectedDefinition(key: string): { label: string; definition: string } | null {
  const native = nativeDefinitions.get(key)
  if (native) return { label: native.label, definition: metaNativeMetricDescription(native) }
  const ratio = META_RATIO_METRIC_DEFINITIONS.find(item => item[0] === key)
  if (!ratio) return null
  const [, label, numerator, denominator, scale] = ratio
  return { label, definition: `${nativeDefinitions.get(numerator)!.label} / ${nativeDefinitions.get(denominator)!.label}${scale !== 1 ? ` × ${scale}` : ''}; matching Meta population and period with complete input coverage.` }
}

function native(entity: ReportEntity, key: string, context: ReportingContext): ReportMetric | null {
  const metric = entity.metrics[key], claim = metric?.current
  const rate = key.startsWith('retention_')
  const expected = expectedDefinition(key)
  if (!metric || !claim || !expected || metric.key !== key || metric.event !== null
    || metric.label !== expected.label || claim.label !== expected.label
    || metric.definition !== expected.definition || claim.formula !== expected.definition
    || claim.metricKey !== `meta.${key}` || claim.unit !== (rate ? 'percent' : 'count')
    || claim.source.system !== 'meta' || claim.source.role !== 'delivery_truth' || claim.source.evidencePlane !== 'meta_delivery'
    || claim.entity.level !== 'ad' || claim.entity.id !== entity.id || claim.definitionVersion !== 1
    || claim.attributionScope !== 'meta_platform_modelled' || claim.measurementKind !== (rate ? 'derived' : 'modelled')
    || claim.window.basis !== 'impression_date_et' || claim.window.timezone !== context.timezone
    || claim.window.start !== context.range.from || claim.window.end !== context.range.to
    || claim.availability.state !== 'available' || claim.coverage.state !== 'complete'
    || claim.freshness.state === 'stale' || claim.maturity.state === 'partial'
    || typeof claim.value !== 'number' || !Number.isFinite(claim.value) || claim.value < 0
    || claim.authority.state !== 'diagnostic' || claim.authority.policyVersion !== 'reporting-v1'
    || (!rate && (!Number.isSafeInteger(claim.value)
      || claim.source.head !== `meta-live:${context.account.metaAccountId}:${claim.asOf}`))) return null
  try {
    if (compareCreativeEvidenceInstants(claim.asOf, context.asOf) > 0) return null
  } catch { return null }
  return metric
}

/** Plot supplied native ratios only when their exact native inputs support them. */
export function creativeRetention(entities: ReportEntity[], context: ReportingContext) {
  const rows = entities.filter(entity => entity.level === 'ad').map(entity => {
    const startsMetric = native(entity, 'video_plays', context)
    const starts = startsMetric?.current.value as number | undefined
    const points: RetentionPoint[] = RETENTION_MILESTONES.map(milestone => {
      const countMetric = native(entity, `watch_p${milestone}`, context)
      const rate = native(entity, `retention_p${milestone}`, context)
      const count = countMetric?.current.value as number | undefined
      const value = rate?.current.value as number | undefined
      const expected = count !== undefined && starts !== undefined && starts > 0 ? count / starts * 100 : null
      const inputs = [countMetric?.current.claimId, startsMetric?.current.claimId]
      const consistent = rate && countMetric && startsMetric && value !== undefined && expected !== null && count! <= starts!
        && rate.current.inputClaimIds.length === 2 && inputs.every(id => id && rate.current.inputClaimIds.includes(id))
        && [countMetric, startsMetric].every(input => input.current.asOf === rate.current.asOf)
        && countMetric.current.source.head === startsMetric.current.source.head
        && Math.abs(value - expected) <= Number.EPSILON * Math.max(1, value, expected) * 8
      return { milestone, count: count ?? null, starts: starts ?? null, value: consistent ? value : null,
        reason: consistent ? null : count === undefined || starts === undefined
          ? `${milestone}% milestone unavailable: compatible count or starts were not supplied.`
          : 'Milestone comparison unavailable: the supplied rate or its input evidence is incomplete or inconsistent.' }
    })
    return { entity, points }
  })
  return rows.map(row => ({ ...row, points: row.points.map(point => {
    if (point.value === null) return point
    const anchor = rows.find(candidate => candidate.points.some(item => item.milestone === point.milestone && item.value !== null))!
    const key = `retention_p${point.milestone}`
    return comparable(anchor.entity.metrics[key], row.entity.metrics[key]) ? point
      : { ...point, value: null, reason: 'Milestone comparison unavailable: native definitions or populations differ between executions.' }
  }) }))
}
