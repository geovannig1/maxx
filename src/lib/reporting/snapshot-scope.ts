import { z } from 'zod'
import { ReportingContextSchema, ReportingRangeSchema, type ReportingContext, type ReportingRange, type ReportingSectionName } from './contracts'
import { META_DIMENSION_KEYS } from './meta-breakdowns'
import { isIanaTimeZone, isIsoCurrency } from '@/config/business-config'

// Bump the scope policy/version when changing source or metric semantics. Old
// observations must not silently acquire new event, time-basis or formula meaning.
export const ReportingHistoryEntitySchema = z.object({
  level: z.enum(['campaign', 'adset']), id: z.string().regex(/^[A-Za-z0-9_-]{1,160}$/),
  breakdown: z.enum(META_DIMENSION_KEYS).optional(),
}).strict()
export type ReportingHistoryEntity = z.infer<typeof ReportingHistoryEntitySchema>

/** One strict selector on the wire; ad detail IDs keep their existing meaning. */
export function readReportingHistoryEntity(params: Pick<URLSearchParams, 'getAll'>, source: ReportingSectionName, detailIds: readonly string[] = []): ReportingHistoryEntity | undefined {
  const values = params.getAll('historyEntity')
  if (!values.length) return undefined
  if (values.length !== 1 || source !== 'meta' || detailIds.length) throw new Error('Invalid reporting history selection')
  return ReportingHistoryEntitySchema.parse(JSON.parse(values[0]))
}

export const ReportingSnapshotScopeSchema = z.object({
  version: z.literal(1), policyVersion: z.literal('reporting-v1'),
  source: z.enum(['meta', 'business', 'website', 'measurement']),
  accountId: z.string().uuid(), metaAccountId: z.string().regex(/^(act_)?\d+$/),
  requestedRange: ReportingRangeSchema, range: ReportingRangeSchema, comparison: ReportingRangeSchema,
  timezone: z.string().refine(isIanaTimeZone), currency: z.string().refine(isIsoCurrency),
  detailIds: z.array(z.string().regex(/^[A-Za-z0-9_-]{1,160}$/)).max(2),
  historyEntity: ReportingHistoryEntitySchema.optional(),
}).strict().superRefine((scope, check) => {
  const previousDays = Date.parse(scope.comparison.to) - Date.parse(scope.comparison.from)
  const currentDays = Date.parse(scope.range.to) - Date.parse(scope.range.from)
  if (currentDays !== previousDays || Date.parse(scope.range.from) - Date.parse(scope.comparison.to) !== 86_400_000
    || scope.requestedRange.from !== scope.range.from || scope.requestedRange.to < scope.range.to
    || (scope.source !== 'meta' && scope.detailIds.length > 0)
    || (scope.historyEntity !== undefined && (scope.source !== 'meta' || scope.detailIds.length > 0))
    || JSON.stringify(scope.detailIds) !== JSON.stringify([...new Set(scope.detailIds)].sort())) {
    check.addIssue({ code: 'custom', message: 'Reporting snapshot scope is inconsistent.' })
  }
})
export type ReportingSnapshotScope = z.infer<typeof ReportingSnapshotScopeSchema>

export function makeReportingSnapshotScope(
  source: ReportingSectionName, rawContext: ReportingContext,
  options: { requestedRange?: ReportingRange; detailIds?: readonly string[]; historyEntity?: ReportingHistoryEntity } = {},
): ReportingSnapshotScope {
  const context = ReportingContextSchema.parse(rawContext)
  return ReportingSnapshotScopeSchema.parse({
    version: 1, policyVersion: 'reporting-v1', source,
    accountId: context.account.id, metaAccountId: context.account.metaAccountId,
    requestedRange: options.requestedRange ?? context.range, range: context.range, comparison: context.comparison,
    timezone: context.timezone, currency: context.currency, detailIds: [...new Set(options.detailIds ?? [])].sort(),
    ...(options.historyEntity !== undefined ? { historyEntity: options.historyEntity } : {}),
  })
}
