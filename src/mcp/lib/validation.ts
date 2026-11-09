import { z } from 'zod'
import { nyDaysAgo } from '@/lib/utils/date-utils'

export const DateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD format')

export const DateRangeSchema = z
  .object({
    start_date: DateSchema.optional(),
    end_date: DateSchema.optional(),
  })
  .refine(
    (data) => {
      if (data.start_date && data.end_date) {
        return new Date(data.start_date) <= new Date(data.end_date)
      }
      return true
    },
    { message: 'start_date must be before or equal to end_date' }
  )

export const AccountSummarySchema = z.object({
  start_date: DateSchema.optional(),
  end_date: DateSchema.optional(),
})

export const DailyReportSchema = z.object({
  date: DateSchema.optional(),
})

export const CampaignPerformanceSchema = z.object({
  campaign_id: z.string().max(50).optional(),
  start_date: DateSchema.optional(),
  end_date: DateSchema.optional(),
})

export const AdSetPerformanceSchema = z.object({
  adset_id: z.string().max(50).optional(),
  campaign_id: z.string().max(50).optional(),
  start_date: DateSchema.optional(),
  end_date: DateSchema.optional(),
})

export const AdPerformanceSchema = z.object({
  ad_id: z.string().max(50).optional(),
  adset_id: z.string().max(50).optional(),
  start_date: DateSchema.optional(),
  end_date: DateSchema.optional(),
})

export const CreativePerformanceSchema = z.object({
  start_date: DateSchema.optional(),
  end_date: DateSchema.optional(),
  min_spend: z.number().nonnegative().finite().optional(),
})

export const GetAlertsSchema = z.object({
  severity: z.enum(['critical', 'warning', 'info']).optional(),
  is_resolved: z.boolean().optional().default(false),
  limit: z.number().min(1).max(100).optional().default(20),
})

export const GetAuditTasksSchema = z.object({
  status: z.enum(['open', 'in_progress', 'done', 'dismissed']).optional().default('open'),
  priority: z.enum(['urgent', 'high', 'medium', 'low']).optional(),
  limit: z.number().min(1).max(100).optional().default(20),
})

export const CompareDateRangesSchema = z.object({
  period_a_start: DateSchema,
  period_a_end: DateSchema,
  period_b_start: DateSchema,
  period_b_end: DateSchema,
  entity_level: z
    .enum(['account', 'campaign', 'adset', 'ad'])
    .optional()
    .default('account'),
})

export const AskMetaAdsPilotSchema = z.object({
  question: z.string().min(1).max(500),
})

// Validates that a date is not in the future and not older than 90 days
export function validateDateRange(
  startDate?: string,
  endDate?: string
): { start: string; end: string } {
  const now = new Date()
  const yesterday = new Date(nyDaysAgo(1) + 'T00:00:00Z')
  const ninetyDaysAgo = new Date(nyDaysAgo(90) + 'T00:00:00Z')

  const end = endDate ? new Date(endDate) : yesterday
  const start = startDate ? new Date(startDate) : end

  if (end > now) throw new Error('end_date cannot be in the future')
  if (start < ninetyDaysAgo) throw new Error('start_date cannot be older than 90 days')
  if (start > end) throw new Error('start_date must be before or equal to end_date')

  const fmt = (d: Date) => d.toISOString().split('T')[0]
  return { start: fmt(start), end: fmt(end) }
}
