import { z } from 'zod'
import { ReportingContextSchema, ReportingRangeSchema } from './contracts'
import { ReportingSnapshotScopeSchema } from './snapshot-scope'
import type { ReportingData } from './contracts'
import type { ExpertReportReview } from './review/contracts'
import { META_DIMENSION_KEYS } from './meta-breakdowns'

export const SAVED_REPORT_VERSION = 'saved_report.v1' as const
export const SAVED_REPORT_EXPORT_VERSION = 'report_export.v1' as const
export const SAVED_SOURCES = ['meta', 'business', 'website', 'measurement'] as const
export const SavedFingerprintSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/)
const timestamp = z.string().datetime({ offset: true })
export const SavedReceiptSchema = z.object({
  id: z.string().uuid(), fingerprint: SavedFingerprintSchema, scope: ReportingSnapshotScopeSchema,
  retrievalStartedAt: timestamp, retrievalCompletedAt: timestamp, sourceAsOf: timestamp.nullable(),
}).strict()
export type SavedReportReceipt = z.infer<typeof SavedReceiptSchema>
export function savedSnapshotNotes(notes: readonly string[], scope: SavedReportReceipt['scope']): string[] {
  return [...new Set([...notes, ...(scope.requestedRange.to === scope.range.to ? [] : [
    'The requested end date included an open or future account day. Reporting ends yesterday in the account timezone.',
  ])])]
}
export const SavedSourceBindingSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('snapshot'), receipt: SavedReceiptSchema }).strict(),
  z.object({ state: z.literal('retained_snapshot'), receipt: SavedReceiptSchema,
    code: z.enum(['refresh_failed', 'refreshing']) }).strict(),
  z.object({ state: z.literal('unavailable'), code: z.enum(['source_unavailable', 'invalid_report']),
    context: ReportingContextSchema.nullable() }).strict(),
  z.object({ state: z.literal('missing'), code: z.literal('not_supplied'), context: ReportingContextSchema.nullable() }).strict(),
])
export type SavedSourceBinding = z.infer<typeof SavedSourceBindingSchema>
export const SavedSourcesSchema = z.object({ meta: SavedSourceBindingSchema, business: SavedSourceBindingSchema,
  website: SavedSourceBindingSchema, measurement: SavedSourceBindingSchema }).strict()
export type SavedReportSources = z.infer<typeof SavedSourcesSchema>
export const SAVED_VIEW_KEYS = ['from', 'to', 'range', 'source', 'report', 'ad', 'view', 'group', 'level', 'compare', 'q',
  'campaign', 'adset', 'status', 'audience', 'format', 'sort', 'direction', 'grouping', 'website_q', 'website_page',
  'website_device', 'website_channel', 'website_event', 'overview_level', 'overview_group', 'overview_sort',
  'overview_direction', 'overview_q', 'overview_signal', 'overview_compare', 'review_area', 'review_level',
  'review_filter', 'review_q', 'review_page', 'review_signal', 'review_entity', 'business_q', 'audience_q',
  'overview_creative_q', 'overview_creative_sort', 'overview_creative_page', 'overview_creative_size',
  'overview_creative_view', 'overview_creative_focus',
  'overview_event', 'meta_trend', 'business_trend', 'ad_trend', 'ad_trend_period', 'entity_trend', 'entity_trend_period', 'breakdown'] as const
export const SavedViewSchema = z.object({
  pathname: z.enum(['/dashboard', '/performance', '/creative', '/reports']),
  hash: z.string().max(512).regex(/^#[^\u0000-\u001f\u007f]*$/).optional(),
  query: z.record(z.string().max(40), z.string().max(512)).refine(query => Object.keys(query).every(key =>
    (SAVED_VIEW_KEYS as readonly string[]).includes(key)), 'Unsupported report selection.'),
}).strict().superRefine((view, check) => {
  const breakdown = view.query.breakdown
  if (breakdown !== undefined && (view.pathname !== '/performance' || view.query.view !== 'detail'
    || !['campaign', 'adset'].includes(view.query.level ?? '')
    || !(META_DIMENSION_KEYS as readonly string[]).includes(breakdown))) {
    check.addIssue({ code: 'custom', path: ['query', 'breakdown'], message: 'Unsupported parent breakdown selection.' })
  }
})
export type SavedReportView = z.infer<typeof SavedViewSchema>
export const SaveReportingReportInputSchema = z.object({
  requestId: z.string().uuid(), title: z.string().trim().min(1).max(120), view: SavedViewSchema,
  sources: SavedSourcesSchema, reviewIdentity: SavedFingerprintSchema,
}).strict()
export type SaveReportingReportInput = z.infer<typeof SaveReportingReportInputSchema>
export const SavedVersionsSchema = z.object({ manifest: z.literal(SAVED_REPORT_VERSION),
  review: z.literal('report_review.v1'), playbook: z.string().min(1).max(100),
  export: z.literal(SAVED_REPORT_EXPORT_VERSION) }).strict()
export const SavedReportSummarySchema = z.object({
  id: z.string().uuid(), title: z.string().min(1).max(120), createdAt: timestamp,
  view: SavedViewSchema, range: ReportingRangeSchema, sourceSummary: SavedSourcesSchema,
  // Discovery survives a format upgrade; exact open separately requires supported versions.
  versions: z.object({ manifest: z.string().min(1).max(100), review: z.string().min(1).max(100),
    playbook: z.string().min(1).max(100), export: z.string().min(1).max(100) }).strict(),
}).strict()
export type SavedReportSummary = z.infer<typeof SavedReportSummarySchema>
export interface OpenSavedReportingReportReply {
  saved: SavedReportSummary & { sources: SavedReportSources; reviewIdentity: string; dataIdentity: string; notesIdentity: string }
  data: ReportingData
  review: ExpertReportReview
  notes: string[]
}
export interface ListSavedReportingReportsReply { reports: SavedReportSummary[]; nextCursor: string | null }
export type SaveReportingReportReply = OpenSavedReportingReportReply

export const SAVED_SOURCE_MESSAGES = {
  source_unavailable: 'This source was unavailable in this report.',
  invalid_report: 'This source could not be validated for this report.',
  not_supplied: 'This source was not supplied in this report.',
  refresh_failed: 'The refresh failed. The previous report remains visible with its original evidence time.',
  refreshing: 'The previous report was retained while a refresh was running.',
} as const
export class SavedReportError extends Error {
  constructor(readonly code: 'invalid' | 'unavailable' | 'not_found' | 'incompatible' | 'changed') {
    super({ invalid: 'The saved report could not be validated.', unavailable: 'Saved reports are temporarily unavailable. Please retry.',
      not_found: 'This saved report is unavailable for the selected account.', incompatible: 'This saved report uses an unsupported format. It has not been replaced with current data.',
      changed: 'The visible report changed or its assessment was updated. Review the current report before saving again.' }[code])
    this.name = 'SavedReportError'
  }
}
