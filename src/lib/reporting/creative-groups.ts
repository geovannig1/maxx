import type { CreativeAssignmentResolution } from '@/lib/creative/assignment-stability'
import { ReportingContextSchema, type ReportCreative, type ReportEntity, type ReportingContext, type ReportingData, type ReportingPacket } from './contracts'
import { calculateCreativeGroupMetrics, type CreativeGroupMetric } from './creative-group-metrics'
import { createReportCreativeAssignmentResolver, compareCreativeEvidenceInstants } from './creative-assignment-contract'
import { validateReportingPacket } from './validation'

export type MetaReportingPacket = Extract<ReportingPacket, { section: 'meta' }>
export interface CreativeGroupMember {
  adId: string
  adName: string
  currentCreativeId: string | null
  sourceIndex: number
  entity: ReportEntity
  assignments: { current: CreativeAssignmentResolution; previous: CreativeAssignmentResolution }
}
export interface CreativeUnassignedExecution extends CreativeGroupMember { reason: string }
export interface CreativeGroup {
  id: string
  accountId: string
  metaCreativeId: string
  name: string
  members: CreativeGroupMember[]
  preview: { state: 'available' | 'unavailable'; adId: string | null; creative: ReportCreative | null; observedAt: string | null; reason: string | null }
  comparison: { state: 'available' | 'unavailable'; reason: string | null }
  metrics: Record<string, CreativeGroupMetric>
  limitations: string[]
}
export interface CreativeGroupPopulation {
  returnedAdCount: number | null
  selectedAdCount: number | null
  assignedAdCount: number | null
  unassignedAdCount: number | null
  filtered: boolean
  requestedAdIds: string[] | null
  unmatchedAdIds: string[] | null
}
export interface CreativeGroupingResult {
  version: 1
  state: 'ready' | 'unavailable' | 'invalid'
  reason: string | null
  context: ReportingContext | null
  sourcePacket: MetaReportingPacket | null
  population: CreativeGroupPopulation
  groups: CreativeGroup[]
  unassigned: CreativeUnassignedExecution[]
  limitations: string[]
}
const LIMITATIONS = [
  'Membership covers selected executions within the returned Meta ad population; it does not prove every use of this creative in the account.',
  'A stable creative-object assignment does not prove historical media-content stability or delivered dynamic combinations.',
  'Current media previews retain their observation time. Ad performance is never allocated to individual media members.',
]
function stopped(state: 'invalid' | 'unavailable', reason: string, adIds?: readonly string[]): CreativeGroupingResult {
  return { version: 1, state, reason, context: null, sourcePacket: null, groups: [], unassigned: [],
    limitations: [reason, 'Returned and selected ad populations could not be established.'], population: { returnedAdCount: null, selectedAdCount: null,
      assignedAdCount: null, unassignedAdCount: null, filtered: adIds !== undefined, requestedAdIds: adIds ? [...adIds] : null, unmatchedAdIds: null } }
}
function previewFor(members: CreativeGroupMember[], creativeId: string, context: ReportingContext): CreativeGroup['preview'] {
  const matching = members.find(member => member.currentCreativeId === creativeId && member.entity.creative && member.entity.configurationAsOf
    && Number.isFinite(Date.parse(member.entity.configurationAsOf)) && compareCreativeEvidenceInstants(member.entity.configurationAsOf, context.asOf) <= 0)
  return matching ? { state: 'available', adId: matching.adId, creative: structuredClone(matching.entity.creative),
    observedAt: matching.entity.configurationAsOf, reason: null }
    : { state: 'unavailable', adId: null, creative: null, observedAt: null, reason: 'matching_current_preview_unavailable' }
}
function groupFrom(members: CreativeGroupMember[], creativeId: string, context: ReportingContext): CreativeGroup {
  const previous = members.map(member => member.assignments.previous)
  const reason = previous.some(assignment => assignment.state !== 'observed_stable') ? 'prior_membership_unproven'
    : previous.some(assignment => assignment.state === 'observed_stable' && assignment.metaCreativeId !== creativeId) ? 'prior_creative_differs' : null
  const preview = previewFor(members, creativeId, context)
  return { id: `creative:${encodeURIComponent(context.account.id)}:${creativeId}`, accountId: context.account.id, metaCreativeId: creativeId,
    name: preview.creative?.name ?? `Creative ${creativeId}`, members, preview,
    comparison: { state: reason ? 'unavailable' : 'available', reason },
    metrics: calculateCreativeGroupMetrics(members, context, reason), limitations: [...LIMITATIONS, ...(reason ? [reason] : [])] }
}

/** Validate the complete Meta packet before selecting ads; no invalid subset is rescued. */
export function buildCreativeGroups<Data extends Pick<ReportingData, 'meta' | 'context'>>(data: Data, adIds?: readonly string[]): CreativeGroupingResult {
  try {
    if (!data.meta?.asOf || !['available', 'partial'].includes(data.meta.state)) {
      if (data.meta?.data) return stopped('invalid', 'invalid_meta_packet', adIds)
      return stopped('unavailable', 'meta_source_unavailable', adIds)
    }
    const context = ReportingContextSchema.parse({ ...data.context, asOf: data.meta.asOf })
    const packet = validateReportingPacket({ section: 'meta', context, result: data.meta, notes: [] }) as MetaReportingPacket
    if (!packet.result.data) return stopped('unavailable', 'meta_source_unavailable', adIds)
    const returned = packet.result.data.entities.flatMap((entity, sourceIndex) => entity.level === 'ad' ? [{ entity, sourceIndex }] : [])
    if (adIds && (new Set(adIds).size !== adIds.length || adIds.some(id => !returned.some(row => row.entity.id === id)))) return stopped('invalid', 'invalid_ad_selection', adIds)
    const selected = returned.filter(row => !adIds || adIds.includes(row.entity.id)).sort((a, b) => a.entity.id.localeCompare(b.entity.id))
    const resolve = createReportCreativeAssignmentResolver(context, packet.result.data.creativeAssignmentEvidence)
    const members = selected.map(({ entity, sourceIndex }): CreativeGroupMember => ({ adId: entity.id, adName: entity.name,
      currentCreativeId: entity.creative?.id ?? null, sourceIndex, entity,
      assignments: { current: resolve(entity.id, 'current'), previous: resolve(entity.id, 'previous') } }))
    const grouped = new Map<string, CreativeGroupMember[]>()
    const unassigned: CreativeUnassignedExecution[] = []
    for (const member of members) {
      const assignment = member.assignments.current
      if (assignment.state === 'blocked') unassigned.push({ ...member, reason: assignment.blockerCode })
      else grouped.set(assignment.metaCreativeId, [...(grouped.get(assignment.metaCreativeId) ?? []), member])
    }
    const groups = [...grouped].sort(([a], [b]) => a.localeCompare(b)).map(([id, group]) => groupFrom(group, id, context))
    return { version: 1, state: 'ready', reason: null, context, sourcePacket: structuredClone(packet), groups, unassigned,
      population: { returnedAdCount: returned.length, selectedAdCount: selected.length, assignedAdCount: selected.length - unassigned.length,
        unassignedAdCount: unassigned.length, filtered: adIds !== undefined, requestedAdIds: adIds ? [...adIds] : null, unmatchedAdIds: [] },
      limitations: [...LIMITATIONS, ...packet.result.notes, ...(packet.result.data.creativeAssignmentEvidence?.notes ?? [])] }
  } catch { return stopped('invalid', 'invalid_meta_packet', adIds) }
}
