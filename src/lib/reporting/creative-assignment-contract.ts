import { z } from 'zod'
import { resolveCreativeAssignment, type CreativeAssignmentResolution } from '@/lib/creative/assignment-stability'
import type { ReportingContext } from './contracts'

const instant = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/).datetime({ offset: true })
const metaId = z.string().regex(/^\d{1,32}$/)
export const ReportCreativeAssignmentEvidenceSchema = z.object({
  accountId: z.string().min(1), asOf: instant, state: z.enum(['available', 'unavailable']),
  observations: z.array(z.object({
    id: z.string().uuid(), metaAdId: metaId, metaCreativeId: metaId.nullable(),
    observedAt: instant, metaUpdatedTime: instant.nullable(),
  }).strict()), notes: z.array(z.string()),
}).strict().refine(value => value.state === 'available' || value.observations.length === 0,
  'Unavailable assignment evidence cannot contain observations')
export type ReportCreativeAssignmentEvidence = z.infer<typeof ReportCreativeAssignmentEvidenceSchema>

/** Compare ISO instants without discarding sub-millisecond native observation precision. */
export function compareCreativeEvidenceInstants(left: string, right: string): number {
  const precision = (value: string) => Number((/\.(\d+)/.exec(value)?.[1] ?? '').padEnd(9, '0').slice(3))
  const leftMs = Date.parse(instant.parse(left)), rightMs = Date.parse(instant.parse(right))
  if (!Number.isFinite(leftMs) || !Number.isFinite(rightMs)) throw new Error('Invalid creative evidence instant')
  return leftMs - rightMs || precision(left) - precision(right)
}

function validatedObservationIndex(
  context: ReportingContext, evidence: ReportCreativeAssignmentEvidence, adIds?: readonly string[],
) {
  const parsed = ReportCreativeAssignmentEvidenceSchema.parse(evidence)
  if (parsed.accountId !== context.account.id || compareCreativeEvidenceInstants(parsed.asOf, context.asOf) !== 0) throw new Error('Assignment evidence scope mismatch')
  const index = new Map<string, ReportCreativeAssignmentEvidence['observations']>()
  if (parsed.state === 'unavailable') return { parsed, index }
  z.string().uuid().parse(parsed.accountId)
  const seen = new Set<string>()
  for (const row of parsed.observations) {
    if (seen.has(row.id.toLowerCase()) || adIds && !adIds.includes(row.metaAdId)) throw new Error('Duplicate or foreign assignment observation')
    seen.add(row.id.toLowerCase())
    if (compareCreativeEvidenceInstants(row.observedAt, parsed.asOf) > 0
      || row.metaUpdatedTime && compareCreativeEvidenceInstants(row.metaUpdatedTime, row.observedAt) > 0) throw new Error('Future assignment observation')
    const observations = index.get(row.metaAdId) ?? []
    observations.push(row)
    index.set(row.metaAdId, observations)
  }
  // The existing resolver also rejects malformed dates, duplicate instants and invalid native identities.
  for (const [ad, observations] of index) {
    const resolution = resolveCreativeAssignment({ timezone: context.timezone, metaAdId: ad,
      windowStart: context.range.from, windowEnd: context.range.to, observations })
    if (resolution.state === 'blocked' && resolution.blockerCode === 'assignment_evidence_invalid') throw new Error('Invalid assignment observation')
  }
  return { parsed, index }
}

export function validateReportCreativeAssignmentEvidence(
  context: ReportingContext, evidence: ReportCreativeAssignmentEvidence, adIds?: readonly string[],
): void {
  validatedObservationIndex(context, evidence, adIds)
}

/** Validate and index one immutable snapshot for a report's repeated ad/window resolutions. */
export function createReportCreativeAssignmentResolver(
  context: ReportingContext, evidence: ReportCreativeAssignmentEvidence | undefined,
): (adId: string, period: 'current' | 'previous') => CreativeAssignmentResolution {
  if (!evidence) return () => ({ state: 'blocked', blockerCode: 'assignment_history_missing' })
  try {
    const { parsed, index } = validatedObservationIndex(context, evidence)
    if (parsed.state === 'unavailable') return () => ({ state: 'blocked', blockerCode: 'assignment_history_missing' })
    const timezone = context.timezone
    const windows = { current: { ...context.range }, previous: { ...context.comparison } }
    return (adId, period) => resolveCreativeAssignment({ timezone, metaAdId: adId,
      windowStart: windows[period].from, windowEnd: windows[period].to, observations: index.get(adId) ?? [] })
  } catch { return () => ({ state: 'blocked', blockerCode: 'assignment_evidence_invalid' }) }
}

export function resolveReportCreativeAssignment(
  context: ReportingContext, evidence: ReportCreativeAssignmentEvidence | undefined,
  adId: string, period: 'current' | 'previous',
): CreativeAssignmentResolution {
  return createReportCreativeAssignmentResolver(context, evidence)(adId, period)
}
