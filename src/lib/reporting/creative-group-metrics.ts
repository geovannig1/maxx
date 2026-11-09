import type { MetricClaim } from '@/lib/cockpit/contracts'
import type { ReportMetric, ReportingContext } from './contracts'
import type { CreativeGroupMember } from './creative-groups'
import { compareCreativeEvidenceInstants } from './creative-assignment-contract'
import { META_NATIVE_METRIC_DEFINITIONS, META_RATIO_METRIC_DEFINITIONS, metaNativeMetricDescription, type MetaNativeDefinition, type MetaRatioDefinition } from './meta-metric-definitions'

export interface CreativeGroupInput {
  adId: string
  metricKey: string
  path: string
  role: 'native' | 'numerator' | 'denominator' | 'guard'
  metric: ReportMetric | null
  claim: MetricClaim | null
  sourceAsOf: string
  reason: string | null
}
export interface CreativeGroupMetricPeriod {
  value: number | null
  unavailableReason: string | null
  inputs: CreativeGroupInput[]
  coverage: 'complete' | 'partial' | 'unknown'
  limitations: string[]
}
export interface CreativeGroupMetric {
  key: string
  label: string
  unit: MetricClaim['unit']
  event: string | null
  definition: string
  calculation: 'sum' | 'ratio_of_sums' | 'native_single_population'
  current: CreativeGroupMetricPeriod
  previous: CreativeGroupMetricPeriod
}
const nativeDefinitions = new Map(META_NATIVE_METRIC_DEFINITIONS.map(definition => [definition.key, definition]))
const combinedPopulation = new Set(['reach', 'frequency', 'average_watch_seconds'])
type Period = 'current' | 'previous'

function contribution(member: CreativeGroupMember, key: string, role: CreativeGroupInput['role'], period: Period, context: ReportingContext): CreativeGroupInput {
  const metric = member.entity.metrics[key] ?? null
  const claim = metric?.[period] ?? null
  return { adId: member.adId, metricKey: key, role, metric,
    claim, sourceAsOf: context.asOf,
    path: `/meta/data/entities/${member.sourceIndex}/metrics/${key}`, reason: !metric || !claim ? 'missing_input' : null }
}

function nativeReason(input: CreativeGroupInput, definition: MetaNativeDefinition, context: ReportingContext, period: Period): string | null {
  const { metric, claim } = input
  if (!metric || !claim) return 'missing_input'
  const range = period === 'current' ? context.range : context.comparison
  const attributed = !!(definition.event || definition.action)
  if (metric.key !== definition.key || metric.event !== (definition.event ?? null)
    || metric.label !== definition.label || metric.definition !== metaNativeMetricDescription(definition)
    || claim.metricKey !== `meta.${definition.key}` || claim.label !== definition.label || claim.formula !== metric.definition
    || claim.unit !== definition.unit || claim.entity.level !== 'ad' || claim.entity.id !== input.adId
    || claim.source.system !== 'meta' || claim.source.role !== 'delivery_truth' || claim.source.evidencePlane !== 'meta_delivery'
    || claim.attributionScope !== (attributed ? 'meta_platform_modelled' : 'none')
    || claim.measurementKind !== (attributed || ['reach', 'frequency'].includes(definition.key) ? 'modelled' : 'measured')
    || claim.window.start !== range.from || claim.window.end !== range.to || claim.window.basis !== 'impression_date_et'
    || claim.window.timezone !== context.timezone || claim.definitionVersion !== 1
    || claim.authority.state !== 'diagnostic' || claim.authority.policyVersion !== 'reporting-v1'
    || compareCreativeEvidenceInstants(claim.asOf, context.asOf) > 0) return 'incompatible_native_input'
  if (claim.availability.state !== 'available' || typeof claim.value !== 'number') return 'missing_input'
  if (!Number.isFinite(claim.value) || claim.value < 0 || definition.unit === 'count' && !Number.isSafeInteger(claim.value)) return 'invalid_native_value'
  if (claim.coverage.state !== 'complete') return 'incomplete_input_coverage'
  return claim.maturity.state === 'partial' ? 'partial_input_period' : null
}

function observations(inputs: CreativeGroupInput[]): Pick<CreativeGroupMetricPeriod, 'coverage' | 'limitations'> {
  const measured = inputs.filter(input => input.role !== 'guard')
  const coverage = measured.some(input => !input.claim || input.claim.coverage.state === 'unknown') ? 'unknown'
    : measured.some(input => input.claim?.coverage.state === 'partial') ? 'partial' : 'complete'
  return { coverage, limitations: [
    'Calculation covers the explicit selected ad executions, not all uses of a creative or individual media assets.',
    ...(measured.some(input => input.claim?.maturity.state === 'settling') ? ['Attributed outcomes are settling and may be revised.'] : []),
    ...(measured.some(input => input.claim?.freshness.state === 'stale') ? ['Some native source evidence is stale.'] : []),
    ...(measured.some(input => input.claim?.freshness.state === 'unknown') ? ['Some native source freshness is unverified.'] : []),
    ...(coverage !== 'complete' ? ['The full selected cohort does not have complete input coverage; available native values remain inspectable.'] : []),
  ] }
}

function sharedClock(inputs: CreativeGroupInput[]): boolean {
  const first = inputs[0]?.claim
  return !!first && inputs.every(input => input.claim && input.claim.source.head === first.source.head
    && compareCreativeEvidenceInstants(input.claim.asOf, first.asOf) === 0)
}
function result(inputs: CreativeGroupInput[], value: number | null, reason: string | null): CreativeGroupMetricPeriod {
  return { value: reason ? null : value, unavailableReason: reason, inputs, ...observations(inputs) }
}

function nativePeriod(members: readonly CreativeGroupMember[], definition: MetaNativeDefinition, context: ReportingContext, period: Period, priorReason: string | null): CreativeGroupMetricPeriod {
  const inputs = members.map(member => {
    const input = contribution(member, definition.key, 'native', period, context)
    return { ...input, reason: nativeReason(input, definition, context, period) }
  })
  const reason = period === 'previous' && priorReason ? priorReason
    : combinedPopulation.has(definition.key) && members.length !== 1 ? 'native_combined_population_required'
      : inputs.find(input => input.reason)?.reason ?? (!sharedClock(inputs) ? 'incompatible_source_observations' : null)
  if (reason) return result(inputs, null, reason)
  const value = inputs.reduce((sum, input) => sum + (input.claim!.value as number), 0)
  return result(inputs, value, !Number.isFinite(value) ? 'nonfinite_result'
    : definition.unit === 'count' && !Number.isSafeInteger(value) ? 'unsafe_aggregate_value' : null)
}

function ratioGuard(input: CreativeGroupInput): string | null {
  // Older saved reports did not retain this metric; do not introduce a new historical result.
  if (!input.claim) return input.metricKey === 'cost_per_purchase' ? 'missing_source_ratio' : null
  return input.claim.availability.state === 'unavailable' && input.claim.availability.blockerCodes.some(code =>
    !['report_metric_not_supplied', 'report_metric_coverage_incomplete'].includes(code)) ? 'source_ratio_withheld' : null
}
function ratioPeriod(members: readonly CreativeGroupMember[], formula: MetaRatioDefinition, context: ReportingContext, period: Period, priorReason: string | null): CreativeGroupMetricPeriod {
  const [key, , numerator, denominator, scale] = formula
  const inputs = members.flatMap(member => ([['numerator', numerator], ['denominator', denominator], ['guard', key]] as const).map(([role, nativeKey]) => {
    const input = contribution(member, nativeKey, role, period, context)
    return { ...input, reason: role === 'guard' ? ratioGuard(input) : nativeReason(input, nativeDefinitions.get(nativeKey)!, context, period) }
  }))
  const contributing = inputs.filter(input => input.role !== 'guard')
  const reason = period === 'previous' && priorReason ? priorReason
    : inputs.find(input => input.reason)?.reason ?? (!sharedClock(contributing) ? 'incompatible_source_observations' : null)
  if (reason) return result(inputs, null, reason)
  const sum = (role: CreativeGroupInput['role']) => inputs.filter(input => input.role === role).reduce((total, input) => total + (input.claim!.value as number), 0)
  const a = sum('numerator'), b = sum('denominator')
  if (nativeDefinitions.get(numerator)!.unit === 'count' && !Number.isSafeInteger(a)
    || nativeDefinitions.get(denominator)!.unit === 'count' && !Number.isSafeInteger(b)) return result(inputs, null, 'unsafe_aggregate_value')
  if (b <= 0) return result(inputs, null, 'zero_denominator')
  if (key.startsWith('retention_') && (a > b || members.some(member => {
    const n = member.entity.metrics[numerator]?.[period]?.value, d = member.entity.metrics[denominator]?.[period]?.value
    return typeof n === 'number' && typeof d === 'number' && n > d
  }))) return result(inputs, null, 'invalid_retention_inputs')
  const value = a / b * scale
  return result(inputs, value, Number.isFinite(a) && Number.isFinite(b) && Number.isFinite(value) ? null : 'nonfinite_result')
}

/** A presentation calculation retains native ad claims; it creates no group MetricClaim. */
export function calculateCreativeGroupMetrics(
  members: readonly CreativeGroupMember[], context: ReportingContext, priorMembershipReason: string | null,
): Record<string, CreativeGroupMetric> {
  const native = META_NATIVE_METRIC_DEFINITIONS.map((definition): [string, CreativeGroupMetric] => [definition.key, {
    key: definition.key, label: definition.label, unit: definition.unit, event: definition.event ?? null,
    definition: combinedPopulation.has(definition.key) ? metaNativeMetricDescription(definition)
      : `SUM of ${definition.label} from the same explicit selected ad cohort; ${metaNativeMetricDescription(definition)}`,
    calculation: combinedPopulation.has(definition.key) ? 'native_single_population' : 'sum',
    current: nativePeriod(members, definition, context, 'current', null), previous: nativePeriod(members, definition, context, 'previous', priorMembershipReason),
  }])
  const ratios = META_RATIO_METRIC_DEFINITIONS.map((formula): [string, CreativeGroupMetric] => {
    const [key, label, numerator, denominator, scale, unit] = formula
    return [key, { key, label, unit, event: nativeDefinitions.get(numerator)?.event ?? nativeDefinitions.get(denominator)?.event ?? null,
      definition: `SUM(${nativeDefinitions.get(numerator)!.label}) / SUM(${nativeDefinitions.get(denominator)!.label})${scale !== 1 ? ` × ${scale}` : ''}; matching selected ad cohort and complete compatible native inputs.`,
      calculation: 'ratio_of_sums', current: ratioPeriod(members, formula, context, 'current', null),
      previous: ratioPeriod(members, formula, context, 'previous', priorMembershipReason) }]
  })
  return Object.fromEntries([...native, ...ratios])
}
