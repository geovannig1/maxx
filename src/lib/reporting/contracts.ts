import { z } from 'zod'
import { DocumentMetricClaimSchema } from '@/lib/cockpit/contracts'
import { ReportCreativeIdentitySchema } from './creative-identity'
import { ReportCreativeAssignmentEvidenceSchema } from './creative-assignment-contract'
import { ReportAudienceEvidenceSchema } from './audience-evidence'
import { ReportBudgetEvidenceSchema } from './budget-evidence'
import { isIanaTimeZone, isIsoCurrency } from '@/config/business-config'
import { isSampleMediaPath } from './sample-media'

export const ReportingDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const time = Date.parse(`${value}T00:00:00Z`)
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value
}, 'Use a real calendar date.')

export const ReportingRangeSchema = z.object({
  from: ReportingDateSchema,
  to: ReportingDateSchema,
}).strict().refine(range => range.from <= range.to, 'Start must precede end.')
export type ReportingRange = z.infer<typeof ReportingRangeSchema>

export const ReportingContextSchema = z.object({
  account: z.object({ id: z.string().min(1), metaAccountId: z.string().min(1), name: z.string().nullable() }).strict(),
  range: ReportingRangeSchema,
  comparison: ReportingRangeSchema,
  timezone: z.string().refine(isIanaTimeZone),
  currency: z.string().refine(isIsoCurrency),
  asOf: z.string().datetime({ offset: true }),
}).strict().superRefine((context, check) => {
  const duration = (range: ReportingRange) => Date.parse(range.to) - Date.parse(range.from)
  if (duration(context.range) !== duration(context.comparison)
      || Date.parse(context.range.from) - Date.parse(context.comparison.to) !== 86_400_000) {
    check.addIssue({ code: 'custom', message: 'Comparison must be the preceding equal period.' })
  }
})
export type ReportingContext = z.infer<typeof ReportingContextSchema>

export const ReportMetricSchema = z.object({
  key: z.string().min(1), label: z.string().min(1), definition: z.string().min(1),
  // Each distinct frozen claim (an expanded compact packet shares them) is validated once.
  event: z.string().nullable(), current: DocumentMetricClaimSchema, previous: DocumentMetricClaimSchema.nullable(),
}).strict()
export const ReportMetricMapSchema = z.record(z.string(), ReportMetricSchema).superRefine((metrics, check) => {
  for (const [key, metric] of Object.entries(metrics)) {
    if (key !== metric.key) check.addIssue({ code: 'custom', path: [key], message: 'Metric key must match its map identity.' })
  }
})
export type ReportMetric = z.infer<typeof ReportMetricSchema>
export type ReportMetricMap = z.infer<typeof ReportMetricMapSchema>

const httpsUrl = z.string().url().refine(value => {
  // zod still runs this refinement after .url() rejects the value, and `new URL` would then throw.
  if (!URL.canParse(value)) return false
  const url = new URL(value)
  return url.protocol === 'https:' && !url.username && !url.password
}).nullable()
// An image may also be a demo sample served from the page's own origin (./sample-media.ts).
const creativeImageUrl = z.union([httpsUrl, z.string().refine(isSampleMediaPath)])

export const ReportCreativeSchema = z.object({
  id: z.string(), name: z.string().nullable(), format: z.enum(['image', 'video', 'carousel', 'unknown']),
  thumbnailUrl: creativeImageUrl, imageUrl: creativeImageUrl, videoUrl: httpsUrl,
  durationSeconds: z.number().finite().nonnegative().nullable(),
  body: z.string().nullable(), headline: z.string().nullable(), destination: httpsUrl,
  identity: ReportCreativeIdentitySchema.optional(),
  videoPreviewEvidence: z.object({
    videoId: z.string().min(1).max(256).regex(/^[A-Za-z0-9_-]+$/),
    basis: z.literal('object_story_spec_video_id'),
  }).strict().optional(),
}).strict().superRefine((creative, check) => {
  const preview = creative.videoPreviewEvidence
  if (!preview) return
  if (!creative.videoUrl) {
    check.addIssue({ code: 'custom', path: ['videoPreviewEvidence'], message: 'A configured video preview requires an exact playable URL.' })
  }
  const member = creative.identity?.members.some(item => item.kind === 'video' && item.role === 'media'
    && item.id === preview.videoId && item.sourcePaths.includes('/object_story_spec/video_data/video_id'))
  if (!member) {
    check.addIssue({ code: 'custom', path: ['videoPreviewEvidence', 'videoId'], message: 'Preview ID must match the observed object-story video member.' })
  }
})
export type ReportCreative = z.infer<typeof ReportCreativeSchema>

export const ReportSeriesPointSchema = z.object({ date: ReportingDateSchema, metrics: ReportMetricMapSchema }).strict()
export type ReportSeriesPoint = z.infer<typeof ReportSeriesPointSchema>

export const ReportBreakdownSchema = z.object({
  id: z.string(), dimension: z.enum(['placement', 'age', 'gender', 'region']), label: z.string(),
  metrics: ReportMetricMapSchema,
}).strict()
export type ReportBreakdown = z.infer<typeof ReportBreakdownSchema>

export const ReportEntitySchema = z.object({
  id: z.string().min(1), level: z.enum(['campaign', 'adset', 'ad']), name: z.string().min(1),
  campaignId: z.string().nullable(), campaignName: z.string().nullable(),
  adsetId: z.string().nullable(), adsetName: z.string().nullable(),
  status: z.string(), configurationAsOf: z.string().nullable(),
  audience: z.enum(['warm', 'cold', 'mixed', 'unknown']), audienceLabel: z.string(),
  audienceEvidence: ReportAudienceEvidenceSchema.optional(),
  budgetEvidence: ReportBudgetEvidenceSchema.optional(),
  creative: ReportCreativeSchema.nullable(), metrics: ReportMetricMapSchema,
  series: z.array(ReportSeriesPointSchema).optional(),
  comparisonSeries: z.array(ReportSeriesPointSchema).optional(),
  breakdowns: z.array(ReportBreakdownSchema).optional(),
}).strict()
export type ReportEntity = z.infer<typeof ReportEntitySchema>

export const ReportObservationSchema = z.object({
  id: z.string(), title: z.string(), detail: z.string(),
  kind: z.enum(['delivery', 'audience', 'creative', 'quality']),
  entityId: z.string().nullable(), observedAt: z.string().nullable(),
}).strict()
export type ReportObservation = z.infer<typeof ReportObservationSchema>

export const META_DETAILS_LOADING_NOTE = 'Optional Meta details, configuration and trends are loading.'
export const MetaReportSchema = z.object({
  metrics: ReportMetricMapSchema, entities: z.array(ReportEntitySchema),
  series: z.array(ReportSeriesPointSchema), comparisonSeries: z.array(ReportSeriesPointSchema),
  breakdowns: z.array(ReportBreakdownSchema), observations: z.array(ReportObservationSchema),
  attributionWindow: z.string(), reportingTime: z.string(), sourceDescription: z.string(),
  detailState: z.enum(['loading', 'complete', 'unavailable']).optional(),
  creativeAssignmentEvidence: ReportCreativeAssignmentEvidenceSchema.optional(),
}).strict()
export type MetaReport = z.infer<typeof MetaReportSchema>

export const BusinessTypeRowSchema = z.object({
  id: z.string(), name: z.string(), category: z.enum(['rental', 'photography', 'unknown']),
  metrics: ReportMetricMapSchema,
}).strict()
export type BusinessTypeRow = z.infer<typeof BusinessTypeRowSchema>
export const BusinessGroupSchema = z.object({ id: z.string().min(1), name: z.string().min(1), metrics: ReportMetricMapSchema }).strict()
export type BusinessGroup = z.infer<typeof BusinessGroupSchema>
const businessFollowupHorizonSchema = (id: '7_day' | '14_day' | '30_day', name: string) => z.object({
  id: z.literal(id), name: z.literal(name), metrics: ReportMetricMapSchema,
}).strict()
export const BusinessCustomerFollowupSchema = z.object({
  observedThrough: ReportingDateSchema,
  horizons: z.tuple([
    businessFollowupHorizonSchema('7_day', '7-day follow-up'),
    businessFollowupHorizonSchema('14_day', '14-day follow-up'),
    businessFollowupHorizonSchema('30_day', '30-day follow-up'),
  ]),
}).strict()
export type BusinessCustomerFollowup = z.infer<typeof BusinessCustomerFollowupSchema>
export const BusinessCustomersSchema = z.object({
  metrics: ReportMetricMapSchema, groups: z.array(BusinessGroupSchema),
  historyFrom: ReportingDateSchema.nullable(), historyTo: ReportingDateSchema,
  identityBasis: z.literal('normalized_email'), historyCoverage: z.literal('retained_ledger'),
  followup: BusinessCustomerFollowupSchema.optional(),
}).strict()
export type BusinessCustomers = z.infer<typeof BusinessCustomersSchema>
export const BusinessLeadTimeSchema = z.object({ metrics: ReportMetricMapSchema, buckets: z.array(BusinessGroupSchema) }).strict()
export type BusinessLeadTime = z.infer<typeof BusinessLeadTimeSchema>
export const BusinessUpcomingSchema = z.object({
  range: ReportingRangeSchema, metrics: ReportMetricMapSchema,
  days: z.array(ReportSeriesPointSchema), types: z.array(BusinessGroupSchema),
}).strict()
export type BusinessUpcoming = z.infer<typeof BusinessUpcomingSchema>
export const BusinessIntelligenceSchema = z.object({
  customers: reportSectionSchema(BusinessCustomersSchema),
  leadTime: reportSectionSchema(BusinessLeadTimeSchema),
  upcoming: reportSectionSchema(BusinessUpcomingSchema),
}).strict()
export type BusinessIntelligence = z.infer<typeof BusinessIntelligenceSchema>
export const BusinessReportSchema = z.object({
  metrics: ReportMetricMapSchema, series: z.array(ReportSeriesPointSchema),
  comparisonSeries: z.array(ReportSeriesPointSchema), types: z.array(BusinessTypeRowSchema),
  sourceDescription: z.string(),
  intelligence: BusinessIntelligenceSchema.optional(),
}).strict()
export type BusinessReport = z.infer<typeof BusinessReportSchema>

export const WebsiteRowSchema = z.object({
  id: z.string(), landingPage: z.string(), device: z.string(), channel: z.string(),
  metrics: ReportMetricMapSchema,
}).strict()
export type WebsiteRow = z.infer<typeof WebsiteRowSchema>
export const WebsiteEventRowSchema = z.object({
  name: z.string(), device: z.string(), channel: z.string(), metrics: ReportMetricMapSchema,
}).strict()
export type WebsiteEventRow = z.infer<typeof WebsiteEventRowSchema>
export const WebsiteMetadataSchema = z.object({
  timezone: z.string().nullable(), currency: z.string().nullable(),
  subjectToThresholding: z.boolean().nullable(), dataLossFromOtherRow: z.boolean().nullable(),
  sampled: z.boolean().nullable(), returnedRows: z.number().int().nonnegative(),
  totalRows: z.number().int().nonnegative().nullable(),
}).strict()
export type WebsiteMetadata = z.infer<typeof WebsiteMetadataSchema>
export const WebsiteReportSchema = z.object({
  metrics: ReportMetricMapSchema, rows: z.array(WebsiteRowSchema), events: z.array(WebsiteEventRowSchema),
  metadata: WebsiteMetadataSchema, sourceDescription: z.string(),
}).strict()
export type WebsiteReport = z.infer<typeof WebsiteReportSchema>

export function reportSectionSchema<T extends z.ZodType>(schema: T) {
  return z.object({
    state: z.enum(['loading', 'available', 'partial', 'unavailable']),
    data: schema.nullable(), asOf: z.string().datetime({ offset: true }).nullable(), notes: z.array(z.string()),
  }).strict().superRefine((section, check) => {
    const data = (section as unknown as { data: z.output<T> | null }).data
    const shouldHaveData = section.state === 'available' || section.state === 'partial'
    if (shouldHaveData !== (data !== null)) {
      check.addIssue({ code: 'custom', message: 'Source state must agree with data availability.' })
    }
  })
}
export interface ReportSection<T> {
  state: 'loading' | 'available' | 'partial' | 'unavailable'
  data: T | null
  asOf: string | null
  notes: string[]
}

export const MeasurementReportSchema = z.object({
  paidAssociation: ReportMetricMapSchema, capi: ReportMetricMapSchema,
  paidAssociationNotes: z.array(z.string()), capiNotes: z.array(z.string()), sourceDescription: z.string(),
}).strict()
export type MeasurementReport = z.infer<typeof MeasurementReportSchema>

export const ReportingDataSchema = z.object({
  context: ReportingContextSchema,
  meta: reportSectionSchema(MetaReportSchema),
  business: reportSectionSchema(BusinessReportSchema),
  website: reportSectionSchema(WebsiteReportSchema),
  measurement: reportSectionSchema(MeasurementReportSchema).optional(),
}).strict()
export type ReportingData = z.infer<typeof ReportingDataSchema>
export type ReportingSectionName = 'meta' | 'business' | 'website' | 'measurement'

export const ReportingPacketSchema = z.discriminatedUnion('section', [
  z.object({ context: ReportingContextSchema, section: z.literal('meta'), result: reportSectionSchema(MetaReportSchema), notes: z.array(z.string()) }).strict(),
  z.object({ context: ReportingContextSchema, section: z.literal('business'), result: reportSectionSchema(BusinessReportSchema), notes: z.array(z.string()) }).strict(),
  z.object({ context: ReportingContextSchema, section: z.literal('website'), result: reportSectionSchema(WebsiteReportSchema), notes: z.array(z.string()) }).strict(),
  z.object({ context: ReportingContextSchema, section: z.literal('measurement'), result: reportSectionSchema(MeasurementReportSchema), notes: z.array(z.string()) }).strict(),
])
export type ReportingPacket = z.infer<typeof ReportingPacketSchema>

export interface ReportFinding {
  id: string
  area: 'results' | 'attention' | 'click_quality' | 'audience' | 'delivery' | 'journey' | 'coverage'
  title: string
  summary?: string
  detail: string
  status: 'observed' | 'no_notable_difference' | 'unavailable'
  importance: number
  href: string
  metrics: ReportMetric[]
}
