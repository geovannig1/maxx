import { ReportingContextSchema, type ReportingContext } from './contracts'
import { buildCreativeGroups, type CreativeGroup, type CreativeGroupMember, type CreativeGroupingResult } from './creative-groups'
import type { CreativeGroupInput, CreativeGroupMetric } from './creative-group-metrics'
import { META_NATIVE_METRIC_DEFINITIONS, META_RATIO_METRIC_DEFINITIONS } from './meta-metric-definitions'
import { reportCsvCell } from './export'

const COLUMNS = [
  'record_type', 'population_state', 'account_id', 'meta_account_id', 'account_name',
  'returned_ad_count', 'selected_ad_count', 'assigned_ad_count', 'unassigned_ad_count', 'filtered', 'requested_ad_ids', 'unmatched_ad_ids',
  'group_id', 'creative_id', 'group_name', 'ad_id', 'ad_name', 'current_creative_id', 'period', 'metric_key', 'metric_label',
  'calculation', 'input_role', 'input_path', 'value', 'unit', 'event', 'from', 'to', 'comparison_from', 'comparison_to',
  'timezone', 'currency', 'source', 'source_head', 'source_as_of', 'claim_as_of', 'date_basis', 'attribution_scope',
  'availability', 'coverage', 'maturity', 'freshness', 'reason', 'definition', 'limitations',
  'assignment_json', 'preview_json', 'metric_json', 'claim_json', 'evidence_json',
] as const
type CountColumn = 'returned_ad_count' | 'selected_ad_count' | 'assigned_ad_count' | 'unassigned_ad_count'
export type CreativeGroupExportRow = Record<Exclude<(typeof COLUMNS)[number], CountColumn | 'value'>, string | null>
  & Record<CountColumn, number | null> & { value: string | number | null }
type Period = 'current' | 'previous'
const periods: Period[] = ['current', 'previous']
const empty = { state: 'unavailable' as const, data: null, asOf: null, notes: [] }
const allowedKeys = new Set([...META_NATIVE_METRIC_DEFINITIONS.map(metric => metric.key), ...META_RATIO_METRIC_DEFINITIONS.map(metric => metric[0])])
const json = (value: unknown): string | null => value == null ? null : JSON.stringify(value)
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(',')}}`
  return JSON.stringify(value)
}
function scope(context: ReportingContext) {
  return { accountId: context.account.id, metaAccountId: context.account.metaAccountId, range: context.range,
    comparison: context.comparison, timezone: context.timezone, currency: context.currency }
}
function checked(result: CreativeGroupingResult, context: ReportingContext, keys: readonly string[]): CreativeGroupingResult {
  ReportingContextSchema.parse(context)
  if (new Set(keys).size !== keys.length || keys.some(key => !allowedKeys.has(key))) throw new Error('Unknown or duplicate creative metric selection.')
  if (result.version !== 1) throw new Error('Invalid creative evidence version.')
  if (result.state !== 'ready') {
    const population = result.population
    if (!['unavailable', 'invalid'].includes(result.state) || !result.reason || result.context !== null || result.sourcePacket !== null
      || result.groups.length || result.unassigned.length || !population || population.returnedAdCount !== null || population.selectedAdCount !== null
      || population.assignedAdCount !== null || population.unassignedAdCount !== null || population.unmatchedAdIds !== null) {
      throw new Error('Unavailable creative evidence cannot establish a measured population.')
    }
    return result
  }
  const packet = result.sourcePacket
  if (!packet || !result.context || canonical(scope(context)) !== canonical(scope(packet.context))) throw new Error('Creative evidence does not match the export account and window.')
  const expected = buildCreativeGroups({ context: packet.context, meta: packet.result, business: empty, website: empty },
    result.population.requestedAdIds ?? undefined)
  if (expected.state !== 'ready' || canonical(result) !== canonical(expected)) throw new Error('Materialized creative calculations do not match their complete source evidence.')
  return expected
}
function base(context: ReportingContext, result: CreativeGroupingResult): CreativeGroupExportRow {
  return { ...Object.fromEntries(COLUMNS.map(column => [column, null])) as CreativeGroupExportRow,
    account_id: context.account.id, meta_account_id: context.account.metaAccountId, account_name: context.account.name,
    from: context.range.from, to: context.range.to, comparison_from: context.comparison.from, comparison_to: context.comparison.to,
    timezone: context.timezone, currency: context.currency, source: 'meta', source_as_of: result.context?.asOf ?? null,
    limitations: result.limitations.join('; ') }
}
function groupFields(group: CreativeGroup): Partial<CreativeGroupExportRow> {
  return { group_id: group.id, creative_id: group.metaCreativeId, group_name: group.name }
}
function memberFields(member: CreativeGroupMember): Partial<CreativeGroupExportRow> {
  return { ad_id: member.adId, ad_name: member.adName, current_creative_id: member.currentCreativeId,
    assignment_json: json(member.assignments) }
}
function nativeFields(input: CreativeGroupInput, period: Period, context: ReportingContext): Partial<CreativeGroupExportRow> {
  const claim = input.claim, range = period === 'current' ? context.range : context.comparison
  return { metric_key: input.metricKey, metric_label: input.metric?.label ?? input.metricKey,
    input_role: input.role, input_path: input.path, value: claim?.availability.state === 'available' ? claim.value : null,
    unit: claim?.unit ?? null, event: input.metric?.event ?? null,
    from: claim?.window.start ?? range.from, to: claim?.window.end ?? range.to, timezone: claim?.window.timezone ?? context.timezone,
    source: claim?.source.system ?? 'meta', source_head: claim?.source.head ?? null, source_as_of: input.sourceAsOf,
    claim_as_of: claim?.asOf ?? null, date_basis: claim?.window.basis ?? null, attribution_scope: claim?.attributionScope ?? null,
    availability: claim?.availability.state ?? 'unavailable', coverage: claim?.coverage.state ?? 'unknown', maturity: claim?.maturity.state ?? 'unknown',
    freshness: claim?.freshness.state ?? 'unknown', reason: input.reason ?? (!claim ? 'missing_input' : claim.availability.blockerCodes.join('; ') || null),
    definition: input.metric?.definition ?? null, metric_json: json(input.metric), claim_json: json(claim) }
}
function metricRows(common: CreativeGroupExportRow, group: CreativeGroup, metric: CreativeGroupMetric, context: ReportingContext): CreativeGroupExportRow[] {
  return periods.flatMap(period => {
    const value = metric[period], range = period === 'current' ? context.range : context.comparison
    const row = { ...common, ...groupFields(group), period, metric_key: metric.key, metric_label: metric.label,
      calculation: metric.calculation, definition: metric.definition, value: value.value, unit: metric.unit, event: metric.event,
      from: range.from, to: range.to, availability: value.unavailableReason ? 'unavailable' : 'available', coverage: value.coverage,
      reason: value.unavailableReason, limitations: [...group.limitations, ...value.limitations].join('; ') }
    return [{ ...row, record_type: 'calculation' }, ...value.inputs.map(input => ({ ...common, ...groupFields(group),
      ...memberFields(group.members.find(member => member.adId === input.adId)!), ...nativeFields(input, period, context),
      record_type: 'input', period, calculation: metric.key, limitations: value.limitations.join('; ') }))]
  })
}

/** Recompute against the captured packet before exporting any materialized result or contribution. */
export function creativeGroupExportRows(result: CreativeGroupingResult, context: ReportingContext, keys: readonly string[]): CreativeGroupExportRow[] {
  const verified = checked(result, context, keys), common = base(context, verified), population = verified.population
  const rows: CreativeGroupExportRow[] = [{ ...common, record_type: 'population', population_state: verified.state === 'ready' ? 'known' : 'unknown',
    returned_ad_count: population.returnedAdCount, selected_ad_count: population.selectedAdCount, assigned_ad_count: population.assignedAdCount,
    unassigned_ad_count: population.unassignedAdCount, filtered: String(population.filtered), requested_ad_ids: json(population.requestedAdIds),
    unmatched_ad_ids: json(population.unmatchedAdIds), reason: verified.reason }]
  if (verified.state !== 'ready') return rows
  const sourceContext = verified.context!
  rows.push({ ...common, record_type: 'assignment_evidence', evidence_json: json(verified.sourcePacket!.result.data?.creativeAssignmentEvidence),
    availability: verified.sourcePacket!.result.data?.creativeAssignmentEvidence?.state ?? 'unavailable',
    reason: verified.sourcePacket!.result.data?.creativeAssignmentEvidence ? null : 'assignment_history_missing' })
  for (const group of verified.groups) {
    rows.push({ ...common, ...groupFields(group), record_type: 'group', preview_json: json(group.preview),
      availability: group.comparison.state, reason: group.comparison.reason, limitations: group.limitations.join('; ') })
    rows.push(...group.members.map(member => ({ ...common, ...groupFields(group), ...memberFields(member), record_type: 'membership' })))
    rows.push(...keys.flatMap(key => metricRows(common, group, group.metrics[key], sourceContext)))
  }
  for (const member of verified.unassigned) {
    rows.push({ ...common, ...memberFields(member), record_type: 'membership', reason: member.reason })
    rows.push(...keys.flatMap(key => periods.map(period => {
      const metric = member.entity.metrics[key] ?? null
      return { ...common, ...memberFields(member), ...nativeFields({ adId: member.adId, metricKey: key, role: 'native',
        path: `/meta/data/entities/${member.sourceIndex}/metrics/${key}`, metric, claim: metric?.[period] ?? null,
        sourceAsOf: sourceContext.asOf, reason: metric?.[period] ? null : 'missing_input' }, period, sourceContext),
      record_type: 'unassigned_input', period, limitations: `${common.limitations}; Ungrouped execution: ${member.reason}` }
    })))
  }
  return rows
}

export function buildCreativeGroupCsv(result: CreativeGroupingResult, context: ReportingContext, keys: readonly string[]): string {
  return [COLUMNS.join(','), ...creativeGroupExportRows(result, context, keys)
    .map(row => COLUMNS.map(column => reportCsvCell(row[column])).join(','))].join('\r\n')
}
