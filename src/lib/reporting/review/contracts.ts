import type { ReportEntity, ReportMetric, ReportingContext, ReportingSectionName } from '../contracts'
import type { ReportAudienceEvidence } from '../audience-evidence'
import type { ReportBudgetEvidence } from '../budget-evidence'

export const REVIEW_VERSION = 'report_review.v1' as const
export const PLAYBOOK_VERSION = 'maxx-diagnostic-2026-09-08.v16' as const

/** Full claim content binds a reference to this view, not merely a reused claim ID. */
export interface ReviewEvidence {
  id: string
  source: ReportingSectionName
  /** JSON pointer into ReportingData, e.g. /meta/data/entities/0/metrics/spend. */
  path: string
  sourceAsOf: string | null
  populationLabel: string
  metric: ReportMetric
}
export interface ReviewStatement { text: string; evidence: ReviewEvidence[] }
export const OBSERVATION_HEADINGS = ['Outcome source booked demand', 'Relationship between sources', 'Meta outcomes', 'Recorded payments',
  'Meta spend', 'AppointmentConfirmed count', 'AppointmentConfirmed value', 'Purchase count', 'Purchase value', 'Account efficiency'] as const
export interface ReviewObservationSection { heading?: typeof OBSERVATION_HEADINGS[number]; paragraphs: string[] }
export interface ReviewObservation extends ReviewStatement { sections?: ReviewObservationSection[] }
export interface ReviewAudienceEvidence {
  source: 'meta'; path: string; sourceAsOf: string | null; populationLabel: string; value: ReportAudienceEvidence
}
export interface ReviewBudgetEvidence {
  source: 'meta'; path: string; sourceAsOf: string | null; populationLabel: string; value: ReportBudgetEvidence
}
export interface ReviewFinding {
  id: string
  area: 'business' | 'advertising' | 'audience' | 'creative' | 'website' | 'measurement' | 'coverage'
  title: string
  status: 'observed' | 'mixed' | 'unchanged' | 'unavailable'
  entity?: Pick<ReportEntity, 'id' | 'level' | 'name'>
  priority?: 'investigate' | 'context'
  direction?: 'improved' | 'declined' | 'mixed'
  zeroOutcomeSpend?: boolean
  observation: ReviewObservation
  /** Internal presentation eligibility by exact evidence id; native references stay unchanged. */
  evidencePeriods?: Record<string, Array<'current' | 'prior'>>
  configurationEvidence?: ReviewAudienceEvidence[]
  budgetEvidence?: ReviewBudgetEvidence[]
  materiality: ReviewStatement & { priorityReason: string }
  explanations: Array<{ hypothesis: string; evidence: ReviewEvidence[]; missing: string[] }>
  counterEvidence: ReviewStatement
  nextInspection: {
    question: string
    href: string
    outcomes: Array<{ result: string; interpretation: string }>
  }
  limitations: string[]
  /** Comparison only within an area and matching unit; never an economic impact estimate. */
  exposure: { value: number; unit: 'money' | 'sessions' | 'count'; evidence: ReviewEvidence[] } | null
  authority: { state: 'diagnostic'; executable: false }
}
export interface ReviewPopulationCoverage {
  family: 'Performance' | 'Creative' | 'Creative response' | 'Audience' | 'Website'
  level: ReportEntity['level'] | 'page' | 'event'
  supplied: number
  evaluated: number
  limited: number
}
export interface ExpertReportReview {
  contractVersion: typeof REVIEW_VERSION
  playbookVersion: typeof PLAYBOOK_VERSION
  context: ReportingContext
  input: { kind: 'validated-report-view'; snapshotBinding: 'not_attached'; rejectedSources: ReportingSectionName[] }
  businessContext: { status: 'not_loaded'; versionId: null; approvalId: null }
  findings: ReviewFinding[]
  populationCoverage?: ReviewPopulationCoverage[]
}
