import { ReportingContextSchema, type ReportingData, type ReportingSectionName } from '../contracts'
import { compareCreativeEvidenceInstants as compareInstants } from '../creative-assignment-contract'
import { validateReportingPacket } from '../validation'
import { PLAYBOOK_VERSION, REVIEW_VERSION, type ExpertReportReview, type ReviewFinding } from './contracts'
import { evidenceLimitations, reportLink, statement, unavailableFinding, verifyFindingReferences } from './evidence'
import { deriveBusinessReview } from './business'
import { deriveAdvertisingReview } from './advertising'
import { deriveAudienceReview } from './audience'
import { reportAudienceMemberState } from '../audience-evidence'
import { deriveCreativePopulationReview, deriveCreativeReview } from './creative'
import { deriveCreativeResponseReview } from './creative-response'
import { deriveJourneyReview } from './journey'
import { derivePerformanceReview } from './performance'
import { websitePopulationReview } from './website-population'

const SOURCES: ReportingSectionName[] = ['meta', 'business', 'website', 'measurement']
const NAMES = { meta: 'Meta', business: 'Outcomes', website: 'GA4', measurement: 'Paid association and CAPI' }
const AREAS: ReviewFinding['area'][] = ['business', 'advertising', 'audience', 'creative', 'website', 'measurement', 'coverage']

function validatedView(input: ReportingData): { data: ReportingData; rejected: ReportingSectionName[] } {
  const context = ReportingContextSchema.parse(input.context)
  const rejected: ReportingSectionName[] = []
  const sections = Object.fromEntries(SOURCES.flatMap<[ReportingSectionName, ReportingData[ReportingSectionName]]>(source => {
    if (!input[source]) return []
    try {
      const observedAt = input[source]!.asOf
      if (observedAt && compareInstants(observedAt, context.asOf) > 0) throw new Error('Source observation exceeds the report cutoff.')
      // Meta assignment history is bound to the unchanged Meta retrieval observation,
      // while independently prepared sources can advance the assembled view cutoff.
      const sourceContext = source === 'meta' && observedAt ? { ...context, asOf: observedAt } : context
      const packet = validateReportingPacket({ context: sourceContext, section: source, result: input[source], notes: [] })
      return [[source, packet.result]]
    } catch {
      rejected.push(source)
      return [[source, { state: 'unavailable' as const, data: null, asOf: null,
        notes: ['Expert review withheld: this source does not satisfy the report identity and evidence contract.'] }]]
    }
  }))
  return { data: { context, ...sections } as ReportingData, rejected }
}

function coverageReview(data: ReportingData, rejected: ReportingSectionName[]): ReviewFinding {
  const issues = SOURCES.flatMap(source => {
    const section = data[source]
    if (!section) return [`${NAMES[source]} was not supplied.`]
    const notes = [...new Set(section.notes.map(note => note.trim()).filter(Boolean))]
    if (section.state === 'available' && notes.length === 0) return []
    const state = `${NAMES[source]}: ${section.state}.`
    if (section.state === 'unavailable' && notes.length > 0) {
      const additional = notes.length > 1
        ? ` ${notes.length - 1} additional source qualification${notes.length === 2 ? '' : 's'} are available in ${NAMES[source]} source details.`
        : ''
      return [`${state} ${notes[0]}${additional}`]
    }
    if (notes.length > 0) {
      return [`${state} ${notes.length} source qualification${notes.length === 1 ? '' : 's'} are available in ${NAMES[source]} source details.`]
    }
    return [`${state} Review individual metric availability in ${NAMES[source]} source details.`]
  })
  return {
    id: 'review.coverage', area: 'coverage', title: 'Which evidence can support this review?', status: issues.length ? 'mixed' : 'unchanged',
    observation: statement(issues.length ? issues.join(' ') : 'All four source sections supplied data. Individual metric coverage and comparison eligibility remain separate checks.'),
    materiality: { ...statement(rejected.length ? `The ${rejected.map(source => NAMES[source]).join(', ')} interpretation is withheld; independent valid sources remain usable.`
      : 'A valid count can remain useful while an efficiency comparison is unavailable.'), priorityReason: 'Source limits qualify affected observations instead of replacing every result with a warning.' },
    explanations: [], counterEvidence: statement('A successful source response does not establish complete individual measures, matched populations or an approved business target.'),
    nextInspection: { question: 'Which missing field, time window or source limits the decision?', href: reportLink(data, '/reports'), outcomes: [
      { result: 'The required metric and matching population validate.', interpretation: 'Reopen that comparison using its source definition.' },
      { result: 'Only a raw count validates.', interpretation: 'Retain the count while withholding the unsupported efficiency conclusion.' },
    ] }, limitations: ['No owner-approved business targets or economics are applied in this review.'], exposure: null,
    authority: { state: 'diagnostic', executable: false },
  }
}

/** Stable editorial areas; measured exposure orders only comparable units within an area. */
function orderFindings(findings: ReviewFinding[]): ReviewFinding[] {
  return [...findings].sort((a, b) => {
    const availability = Number(a.status === 'unavailable') - Number(b.status === 'unavailable')
    if (availability) return availability
    const priority = Number(b.priority === 'investigate') - Number(a.priority === 'investigate')
    if (priority) return priority
    const area = AREAS.indexOf(a.area) - AREAS.indexOf(b.area)
    if (area) return area
    if (a.exposure && b.exposure && a.exposure.unit === b.exposure.unit && a.exposure.value !== b.exposure.value) return b.exposure.value - a.exposure.value
    return 0
  })
}

export function deriveExpertReview(input: ReportingData): ExpertReportReview {
  const { data, rejected } = validatedView(input)
  const performance = derivePerformanceReview(data)
  const creative = deriveCreativePopulationReview(data)
  const response = deriveCreativeResponseReview(data)
  const audience = deriveAudienceReview(data)
  const findings = [...deriveBusinessReview(data), ...deriveAdvertisingReview(data), ...audience.findings, ...deriveCreativeReview(data), ...deriveJourneyReview(data), ...performance.findings, ...creative.findings, ...response.findings, coverageReview(data, rejected)]
    .map(finding => {
      try {
        verifyFindingReferences(data, finding)
        return { ...finding, limitations: [...new Set([...finding.limitations, ...evidenceLimitations(finding)])] }
      } catch {
        return { ...unavailableFinding(data, { id: finding.id, area: finding.area, title: finding.title,
          reason: 'This interpretation was withheld because its evidence references or inspection scope could not be validated.', href: '/reports' }),
        entity: finding.entity, priority: 'context' as const }
      }
    })
  return { contractVersion: REVIEW_VERSION, playbookVersion: PLAYBOOK_VERSION, context: data.context,
    input: { kind: 'validated-report-view', snapshotBinding: 'not_attached', rejectedSources: rejected },
    businessContext: { status: 'not_loaded', versionId: null, approvalId: null }, findings: orderFindings(findings),
    populationCoverage: [...performance.coverage, { family: 'Creative', ...creative.coverage }, response.coverage, audience.coverage, ...websitePopulationReview(data).coverage] }
}

/** Surface complementary questions so business checks cannot crowd out ad and web response. */
export function overviewFindings(review: ExpertReportReview): ReviewFinding[] {
  const usable = review.findings.filter(finding => finding.status !== 'unavailable' && finding.area !== 'coverage')
  const slots: ReviewFinding['area'][][] = [['business'], ['advertising'], ['audience'], ['creative'], ['website'], ['measurement']]
  const selected = slots.flatMap(areas => {
    const candidates = usable.filter(item => areas.includes(item.area))
    const finding = areas.includes('audience')
      ? candidates.find(item => item.priority === 'investigate' && item.configurationEvidence?.some(ref => ref.value.members.some(member => reportAudienceMemberState(member, ref.value, review.context.asOf) === 'unhealthy')))
        ?? candidates.find(item => item.priority === 'investigate') ?? candidates[0]
      : areas.includes('website')
      ? candidates.find(item => item.id.startsWith('journey.mix:')) ?? candidates.find(item => item.direction === 'declined')
        ?? candidates.find(item => item.priority === 'investigate') ?? candidates[0]
      : areas.includes('measurement') ? candidates.find(item => item.direction === 'declined') ?? candidates.find(item => item.priority === 'investigate') ?? candidates[0]
      : areas.includes('creative') ? candidates.find(item => item.id.startsWith('creative_response:') && item.direction === 'mixed')
        ?? candidates.find(item => item.zeroOutcomeSpend) ?? candidates.find(item => item.direction === 'declined' || item.direction === 'mixed') ?? candidates[0]
      : areas.includes('business') || areas.includes('advertising')
      ? candidates.find(item => item.zeroOutcomeSpend) ?? candidates.find(item => item.direction === 'declined' || item.direction === 'mixed') ?? candidates[0]
      : candidates[0]
    return finding ? [finding] : []
  })
  const opportunities = (['business', 'advertising', 'creative', 'website'] as const).flatMap(area => {
    if (selected.some(finding => finding.area === area && finding.direction === 'improved')) return []
    const finding = usable.find(item => item.area === area && item.direction === 'improved' && !selected.some(selectedFinding => selectedFinding.id === item.id))
    return finding ? [finding] : []
  })
  const timing = usable.filter(item => item.id === 'journey.measurement.booking_lag' && item.priority === 'investigate'
    && !selected.some(selectedFinding => selectedFinding.id === item.id))
  const campaignAnswer = usable.filter(item => item.id === 'advertising.allocation' && !selected.some(finding => finding.id === item.id))
  return selected.length ? [...campaignAnswer, ...selected, ...opportunities, ...timing] : review.findings.filter(finding => finding.area === 'coverage')
}
