import { z } from 'zod'
import { ReportMetricSchema, ReportingContextSchema, type ReportingData } from './contracts'
import { ReportAudienceEvidenceSchema } from './audience-evidence'
import { ReportBudgetEvidenceSchema } from './budget-evidence'
import { verifyFindingReferences } from './review/evidence'
import { OBSERVATION_HEADINGS, type ExpertReportReview } from './review/contracts'
import { matchingObservationSections } from './review/observation'
import { SavedReportError, SAVED_SOURCES } from './saved-contract'
import { savedCanonicalJson } from './saved-identity'

const text = z.string().max(200_000)
const source = z.enum(SAVED_SOURCES)
const level = z.enum(['campaign', 'adset', 'ad'])
const evidence = z.object({ id: text, source, path: text, sourceAsOf: z.string().datetime({ offset: true }).nullable(),
  populationLabel: text, metric: ReportMetricSchema }).strict()
const refs = z.array(evidence).max(100_000)
const statement = z.object({ text, evidence: refs }).strict()
const finding = z.object({
  id: text, area: z.enum(['business', 'advertising', 'audience', 'creative', 'website', 'measurement', 'coverage']),
  title: text, status: z.enum(['observed', 'mixed', 'unchanged', 'unavailable']),
  entity: z.object({ id: text, level, name: text }).strict().optional(),
  priority: z.enum(['investigate', 'context']).optional(), direction: z.enum(['improved', 'declined', 'mixed']).optional(),
  zeroOutcomeSpend: z.boolean().optional(), observation: statement.extend({ sections: z.array(z.object({
    heading: z.enum(OBSERVATION_HEADINGS).optional(), paragraphs: z.array(text.min(1)).min(1).max(20),
  }).strict()).min(1).max(20).optional() }).refine(value => value.sections === undefined || matchingObservationSections(value) !== null),
  evidencePeriods: z.record(z.string(), z.array(z.enum(['current', 'prior'])).max(2)).optional(),
  configurationEvidence: z.array(z.object({ source: z.literal('meta'), path: text,
    sourceAsOf: z.string().datetime({ offset: true }).nullable(), populationLabel: text, value: ReportAudienceEvidenceSchema }).strict()).optional(),
  budgetEvidence: z.array(z.object({ source: z.literal('meta'), path: text,
    sourceAsOf: z.string().datetime({ offset: true }).nullable(), populationLabel: text, value: ReportBudgetEvidenceSchema }).strict()).max(2).optional(),
  materiality: statement.extend({ priorityReason: text }),
  explanations: z.array(z.object({ hypothesis: text, evidence: refs, missing: z.array(text) }).strict()),
  counterEvidence: statement, nextInspection: z.object({ question: text, href: text,
    outcomes: z.array(z.object({ result: text, interpretation: text }).strict()) }).strict(),
  limitations: z.array(text), exposure: z.object({ value: z.number().finite().nonnegative(),
    unit: z.enum(['money', 'sessions', 'count']), evidence: refs }).strict().nullable(),
  authority: z.object({ state: z.literal('diagnostic'), executable: z.literal(false) }).strict(),
}).strict()
export const SavedReviewSchema = z.object({
  contractVersion: z.literal('report_review.v1'), playbookVersion: z.string().min(1).max(100), context: ReportingContextSchema,
  input: z.object({ kind: z.literal('validated-report-view'), snapshotBinding: z.literal('not_attached'), rejectedSources: z.array(source) }).strict(),
  businessContext: z.object({ status: z.literal('not_loaded'), versionId: z.null(), approvalId: z.null() }).strict(),
  findings: z.array(finding).max(100_000),
  populationCoverage: z.array(z.object({ family: z.enum(['Performance', 'Creative', 'Creative response', 'Audience', 'Website']),
    level: z.enum(['campaign', 'adset', 'ad', 'page', 'event']), supplied: z.number().int().nonnegative(),
    evaluated: z.number().int().nonnegative(), limited: z.number().int().nonnegative() }).strict()).optional(),
}).strict()

/** Old playbook text stays intact; only its presentation contract and native refs are checked. */
export function validateSavedReview(raw: unknown, data: ReportingData): ExpertReportReview {
  try {
    const review = SavedReviewSchema.parse(raw)
    if (savedCanonicalJson(review.context) !== savedCanonicalJson(data.context)
      || review.input.rejectedSources.length || new Set(review.findings.map(item => item.id)).size !== review.findings.length) throw new Error()
    for (const item of review.findings) verifyFindingReferences(data, item)
    return review as ExpertReportReview
  } catch { throw new SavedReportError('invalid') }
}
