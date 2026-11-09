import { resolveRange, type ResolvedRangeFull } from '@/lib/date-range'
import { ReportingDateSchema, ReportingRangeSchema, type ReportingRange } from './contracts'

export function previousReportingRange(range: ReportingRange): ReportingRange {
  ReportingRangeSchema.parse(range)
  const first = Date.parse(`${range.from}T00:00:00Z`)
  const duration = Date.parse(`${range.to}T00:00:00Z`) - first + 86_400_000
  return {
    from: new Date(first - duration).toISOString().slice(0, 10),
    to: new Date(first - 86_400_000).toISOString().slice(0, 10),
  }
}

export function resolveReportingRange(
  params: { range?: string; from?: string; to?: string },
  now: Date = new Date(),
): ResolvedRangeFull {
  if (params.from !== undefined || params.to !== undefined) {
    if (!params.from || !params.to) throw new Error('Choose both a start and an end date.')
    ReportingDateSchema.parse(params.from)
    ReportingDateSchema.parse(params.to)
    ReportingRangeSchema.parse({ from: params.from, to: params.to })
  }
  const resolved = resolveRange(params, '1m', now)
  if (resolved.invalidCustom) throw new Error('Choose a period that includes a completed account day.')
  return resolved
}
