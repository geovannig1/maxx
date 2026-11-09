import type { ReportingData } from '../contracts'
import { AUDIENCE_EVIDENCE_LIMIT, audienceConfigurationState, reportAudienceMemberState } from '../audience-evidence'
import type { ReviewFinding, ReviewPopulationCoverage } from './contracts'
import { audienceConfigurationEvidence, display, metricEvidence, numeric, reportLink, statement } from './evidence'

export function deriveAudienceReview(data: ReportingData): { findings: ReviewFinding[]; coverage: ReviewPopulationCoverage } {
  let evaluated = 0
  const entities = data.meta?.data?.entities ?? []
  const findings = entities.flatMap<ReviewFinding>((entity, index) => {
    if (entity.level !== 'adset') return []
    const ref = audienceConfigurationEvidence(data, index)
    if (!ref) return []
    const evidence = ref.value, configuration = audienceConfigurationState(evidence, data.context.asOf)
    const members = evidence.members.map(member => ({ member, state: reportAudienceMemberState(member, evidence, data.context.asOf) }))
    const unhealthy = members.filter(item => item.state === 'unhealthy')
    const unknown = members.filter(item => !['resolved', 'unhealthy'].includes(item.state))
    const bothRoles = evidence.members.filter(member => member.role === 'included' && evidence.members.some(other => other.id === member.id && other.role === 'excluded'))
    if (configuration === 'observed' && !unknown.length) evaluated++
    const limited = configuration !== 'observed' || unknown.length > 0
    const issue = unhealthy.length > 0 || bothRoles.length > 0
    const spendRef = metricEvidence(data, 'meta', ['entities', index, 'metrics', 'spend'])
    const spend = spendRef?.metric.current.unit === 'money' && numeric(spendRef.metric) !== null && numeric(spendRef.metric)! >= 0 ? spendRef : null
    const status = entity.status.toUpperCase()
    const active = ['ACTIVE', 'LEARNING', 'LEARNING_LIMITED'].includes(status)
    const statusText = members.length ? members.map(({ member }) => `${member.role} ${member.name ?? member.id} (${member.id}): operation ${member.operationCode ?? 'unavailable'}, delivery ${member.deliveryCode ?? 'unavailable'}`).join('; ')
      : evidence.targetingAvailable ? 'No explicit custom-audience references were supplied. Other targeting restrictions may apply.' : 'Targeting references were not supplied.'
    return [{
      id: `audience_readiness:${entity.id}`, area: 'audience', title: `Audience readiness: ${entity.name}`,
      entity: { id: entity.id, name: entity.name, level: 'adset' }, status: issue || limited ? 'mixed' : 'observed',
      priority: active && configuration === 'observed' && issue ? 'investigate' : 'context', configurationEvidence: [ref],
      observation: statement(`Current ad-set status ${entity.status}; audience configuration ${configuration}, observed ${evidence.observedAt}. ${statusText}. Advantage audience expansion: ${evidence.expansion}.`
        + (bothRoles.length ? ` The same audience is included and excluded: ${bothRoles.map(member => member.id).join(', ')}.` : '')),
      materiality: { ...statement(issue ? `${unhealthy.length} referenced audience(s) have a non-ready native status; ${bothRoles.length} appear in both roles. Review intended inclusion or suppression before interpreting this setup.`
        : limited ? 'Missing or stale audience evidence limits this setup assessment; valid historical delivery remains available.'
          : 'The supplied references passed the readiness check. This does not establish audience effectiveness, customer identity or saturation.', spend),
        priorityReason: active && configuration === 'observed' && issue ? 'A referenced current setup concern deserves inspection regardless of spend rank.' : 'Current readiness is separate from historical performance.' },
      explanations: [],
      counterEvidence: statement(`${spend ? `Selected-period spend is ${display(spend.metric)}. ` : ''}Past delivery can coexist with a current readiness problem. Status codes do not prove who saw the ads, exclusion effectiveness or the cause of historical results.`, spend),
      nextInspection: { question: issue ? 'Inspect the affected audience roles and native statuses' : 'Inspect audience membership, readiness and limits',
        href: `${reportLink(data, '/reports', { report: 'audience' })}#audience-adset-${encodeURIComponent(entity.id)}`,
        outcomes: [
          { result: 'The referenced operation or delivery concern remains present.', interpretation: 'Review the intended audience definition and source status; do not infer that a creative change would repair it.' },
          { result: 'The references are ready on a fresh observation.', interpretation: 'Continue performance diagnosis using matching periods; ready status alone does not establish effectiveness.' },
        ] },
      limitations: [AUDIENCE_EVIDENCE_LIMIT, ...(limited ? ['Readiness coverage is incomplete; unknown status is not a failure or a measured zero.'] : [])],
      exposure: spend && numeric(spend.metric) !== null ? { value: numeric(spend.metric)!, unit: 'money', evidence: [spend] } : null,
      authority: { state: 'diagnostic', executable: false },
    }]
  })
  const supplied = entities.filter(entity => entity.level === 'adset').length
  return { findings, coverage: { family: 'Audience', level: 'adset', supplied, evaluated, limited: supplied - evaluated } }
}
