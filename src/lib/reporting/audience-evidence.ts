import { z } from 'zod'
import { resolveAudienceReference, type AudienceRef } from '@/lib/audience/reference-readiness'
import { TARGETING_STALE_HOURS } from '@/lib/audience/resolver'
import type { ReportingContext } from './contracts'
import { compareCreativeEvidenceInstants } from './creative-assignment-contract'

const timestamp = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/).datetime({ offset: true })
const count = z.number().int().nonnegative().safe().nullable()
export const ReportAudienceMemberSchema = z.object({
  id: z.string().min(1), role: z.enum(['included', 'excluded']), name: z.string().nullable(), subtype: z.string().nullable(),
  ownership: z.enum(['matched', 'unconfirmed', 'mismatch']),
  operationCode: count, deliveryCode: count, lowerBound: count, upperBound: count, retentionDays: count,
  operationDescription: z.string().nullable(), deliveryDescription: z.string().nullable(),
  seeds: z.array(z.object({ id: z.string().min(1), name: z.string().nullable() }).strict()),
  inventoryObservedAt: timestamp.nullable(), metaUpdatedAt: timestamp.nullable(),
}).strict()
export type ReportAudienceMember = z.infer<typeof ReportAudienceMemberSchema>
export const ReportAudienceEvidenceSchema = z.object({
  accountId: z.string().min(1), adsetId: z.string().min(1), observedAt: timestamp,
  targetingAvailable: z.boolean(), unparsedReferences: z.number().int().nonnegative().safe(),
  expansion: z.enum(['enabled', 'disabled', 'unknown']), members: z.array(ReportAudienceMemberSchema),
}).strict()
export type ReportAudienceEvidence = z.infer<typeof ReportAudienceEvidenceSchema>
export interface ReportingAudienceRef extends AudienceRef {
  seeds?: ReportAudienceMember['seeds']
  metaUpdatedAt?: string | null
}

export const AUDIENCE_EVIDENCE_LIMIT = 'Current configuration does not establish targeting in the selected historical period. Approximate size bounds are not exact members, deduplicated reach, overlap or a saturation denominator. Meta update time is not proof of a membership refresh.'

export function audienceConfigurationState(evidence: ReportAudienceEvidence, asOf: string): 'observed' | 'unavailable' | 'stale' {
  if (!evidence.targetingAvailable || evidence.unparsedReferences) return 'unavailable'
  const age = (Date.parse(asOf) - Date.parse(evidence.observedAt)) / 3_600_000
  return !Number.isFinite(age) || compareCreativeEvidenceInstants(evidence.observedAt, asOf) > 0 || age > TARGETING_STALE_HOURS ? 'stale' : 'observed'
}

/** Reuse readiness rules, but never project the resolver's unproven reach/causation prose. */
export function reportAudienceMemberState(member: ReportAudienceMember, evidence: ReportAudienceEvidence, asOf: string) {
  if (member.ownership === 'mismatch') return 'rejected' as const
  if (audienceConfigurationState(evidence, asOf) !== 'observed') return 'unresolved' as const
  const ref: AudienceRef = {
    id: member.id, name: member.name, subtype: member.subtype,
    accountId: member.ownership === 'matched' ? evidence.accountId : null,
    lastSyncedAt: member.inventoryObservedAt, operationStatus: member.operationCode, deliveryStatus: member.deliveryCode,
  }
  return resolveAudienceReference({ id: member.id }, { [member.id]: ref }, evidence.accountId, [], Date.parse(asOf), TARGETING_STALE_HOURS).kind
}

export function validateReportAudienceEvidence(evidence: ReportAudienceEvidence, context: ReportingContext, adsetId: string, configurationAsOf: string | null) {
  if (evidence.accountId !== context.account.id || evidence.adsetId !== adsetId
    || !configurationAsOf || compareCreativeEvidenceInstants(evidence.observedAt, configurationAsOf) !== 0
    || compareCreativeEvidenceInstants(evidence.observedAt, context.asOf) > 0
    || new Set(evidence.members.map(member => `${member.role}:${member.id}`)).size !== evidence.members.length
    || evidence.members.some(member => [member.inventoryObservedAt, member.metaUpdatedAt].some(date => date !== null && compareCreativeEvidenceInstants(date, evidence.observedAt) > 0)
      || new Set(member.seeds.map(seed => seed.id)).size !== member.seeds.length
      || (member.lowerBound !== null && member.upperBound !== null && member.lowerBound > member.upperBound)
      || (member.ownership !== 'matched' && [member.subtype, member.operationCode, member.deliveryCode, member.lowerBound,
        member.upperBound, member.retentionDays, member.operationDescription, member.deliveryDescription, member.inventoryObservedAt, member.metaUpdatedAt, ...member.seeds].some(value => value !== null)))) {
    throw new Error('Invalid report audience identity or observation scope.')
  }
}
