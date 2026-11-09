import type { ReportEntity, ReportingData } from '../contracts'
import type { ReviewFinding, ReviewPopulationCoverage } from './contracts'
import { mediaEntityFields, platformEvidencePeriods, platformPeriod, platformValue, type PlatformField } from './business-platform-evidence'
import { reportLink, statement } from './evidence'
import { budgetConfigurationEvidence } from './evidence'
import { BUDGET_EVIDENCE_LIMIT } from '../budget-evidence'
import { budgetContext } from '../budget-presentation'
import { outcomeWords } from '@/config/outcome-nouns'

// What this business calls its outcomes (NEXT_PUBLIC_OUTCOME_NOUN).
const OW = outcomeWords()

const EVENTS = [
  { name: 'AppointmentConfirmed', count: 'bookings', value: 'appointment_value', roas: 'appointment_roas' },
  { name: 'Purchase', count: 'purchase_count', value: 'purchase_value', roas: 'purchase_roas' },
] as const
type Row = { entity: ReportEntity; index: number; data: ReportingData }

function href(row: Row): string {
  const entity = row.entity
  return reportLink(row.data, '/performance', { group: 'results', ...(entity.level === 'ad' ? { ad: entity.id }
    : entity.level === 'adset' ? { view: 'detail', level: 'adset', adset: entity.id, ...(entity.campaignId ? { campaign: entity.campaignId } : {}) }
      : { view: 'detail', level: 'campaign', campaign: entity.id }) }) + (entity.level === 'ad' ? '' : '#entity-metrics')
}
function movement(field: PlatformField, label = field.label): string {
  if (field.change === null || field.change === 0) return platformPeriod({ ...field, label })
  return `${label} ${field.change > 0 ? label.includes('ROAS') ? 'increased' : 'rose' : 'fell'} from ${platformValue(field.prior && { ...field.prior, qualifications: [] })} to ${platformValue(field.current && { ...field.current, qualifications: [] })}`
}
function arithmetic(spend: PlatformField, count: PlatformField, value: PlatformField, roas: PlatformField, name: string): string[] {
  const facts: string[] = []
  if (roas.change !== null && spend.change !== null && value.change !== null) {
    if (roas.change > 0 && spend.change < 0 && value.change <= 0) facts.push(`${name} ROAS rose with lower spend ${value.change < 0 ? 'despite lower' : 'and unchanged'} reported value; it does not mean more booked business.`)
    if (roas.change < 0 && spend.change > 0 && value.change >= 0) facts.push(`${name} ROAS fell because spend grew faster than reported value; this is ratio arithmetic, not a causal explanation.`)
  }
  if (count.change !== null && value.change !== null && count.change * value.change < 0) facts.push(`${name} count and value moved in opposite directions; event volume alone would reverse the value conclusion.`)
  return facts
}
function assessment(row: Row): { finding: ReviewFinding; evaluated: boolean } {
  const fields = mediaEntityFields(row.data, row.index), spend = fields.spend, entries = Object.values(fields)
  const refs = entries.map(field => field.ref), alerts: string[] = [], declines: string[] = [], improvements: string[] = []
  const observations = [movement(spend, 'Meta spend')], reasons: string[] = []
  for (const event of EVENTS) {
    const count = fields[event.count], value = fields[event.value], roas = fields[event.roas]
    const cost = event.name === 'Purchase' ? fields.cost_per_purchase : null
    observations.push(...[count, value, roas, ...(cost ? [cost] : [])].map(field => `${movement(field)}.`))
    if (cost?.change !== null && cost?.change !== undefined) {
      if (cost.change > 0) declines.push('Purchase CPA increased.')
      if (cost.change < 0) improvements.push('Purchase CPA decreased.')
      if (cost.change > 0 && spend.change !== null && spend.change < 0 && count.change !== null && count.change < 0) {
        reasons.push('Purchase CPA rose despite lower spend: Purchase count fell proportionally faster. This is ratio arithmetic, not a causal explanation.')
      }
      if (cost.change < 0 && count.change !== null && count.change < 0) reasons.push('Lower Purchase CPA accompanies fewer reported purchases; lower average cost does not establish business growth.')
    }
    if (spend.current && spend.current.value > 0 && count.current?.claim.coverage.state === 'complete' && count.current.value === 0) alerts.push(`Spend accompanies an explicit zero ${event.name} count.`)
    if (spend.change !== null && count.change !== null) {
      if (spend.change > 0 && count.change < 0) declines.push(`${event.name} count fell with increased spend.`)
      if (count.current!.value > 0 && spend.change <= 0 && count.change >= 0 && (spend.change < 0 || count.change > 0)) improvements.push(`${event.name} count was maintained or increased with no additional spend.`)
    }
    if (roas.change !== null && roas.change < 0) declines.push(`${event.name} ROAS fell.`)
    if (roas.change !== null && roas.change > 0) improvements.push(`${event.name} ROAS increased.`)
    if ([count, value].some(field => field.change !== null && field.change < 0)) declines.push(`${event.name} reported count or value fell.`)
    if ([count, value].some(field => field.change !== null && field.change > 0)) improvements.push(`${event.name} reported count or value rose.`)
    reasons.push(...arithmetic(spend, count, value, roas, event.name))
  }
  const provisional = entries.some(field => field.change !== null && (field.current?.qualifications.length || field.prior?.qualifications.length))
  const budgetRefs = row.entity.level === 'ad' ? [] : [budgetConfigurationEvidence(row.data, row.index),
    ...row.entity.level === 'adset' ? [budgetConfigurationEvidence(row.data,
      row.data.meta.data?.entities.findIndex(entity => entity.level === 'campaign' && entity.id === row.entity.campaignId) ?? -1)] : []]
    .filter((ref): ref is NonNullable<typeof ref> => !!ref)
  const budget = budgetRefs.length ? budgetContext(row.entity, row.data.meta.data?.entities ?? []) : null
  if (budget) observations.push(`${budget.label} · ${budget.amount}.`)
  const signals = [...alerts, ...declines, ...improvements], available = refs.some(Boolean)
  const direction = declines.length ? improvements.length ? 'mixed' : 'declined' : improvements.length ? 'improved' : undefined
  const currentSpend = spend.current, spendRef = currentSpend ? spend.ref : null
  return { evaluated: !!currentSpend && EVENTS.some(event => fields[event.count].current?.claim.coverage.state === 'complete'), finding: {
    id: `performance:${row.entity.level}:${row.entity.id}`, area: 'advertising',
    entity: { id: row.entity.id, level: row.entity.level, name: row.entity.name },
    title: `${row.entity.name} · ${signals.length ? 'results to investigate' : 'performance assessment'}`,
    priority: signals.length ? 'investigate' : 'context', status: !available ? 'unavailable' : signals.length ? 'mixed' : 'observed',
    direction, zeroOutcomeSpend: alerts.length > 0,
    observation: statement(`${row.entity.name}: ${provisional ? 'Observed changes are provisional; outcomes are still settling and may be revised. ' : ''}${alerts.join(' ')} ${observations.join(' ')} ${reasons.join(' ')}`, ...refs),
    evidencePeriods: platformEvidencePeriods(entries),
    budgetEvidence: budgetRefs.length ? budgetRefs : undefined,
    materiality: { ...statement(currentSpend ? `${platformValue(currentSpend)} observed spend in this ${row.entity.level === 'adset' ? 'ad set' : row.entity.level}. Event count, value and spend remain visible beside return.`
      : 'Current spend is unavailable; independent prior and outcome observations remain inspectable.', spendRef),
      priorityReason: 'Supported signals precede descriptive assessments; measured spend orders cases within priority, without estimating economic impact.' },
    explanations: reasons.length ? [{ hypothesis: reasons.join(' '), evidence: statement('', ...refs).evidence,
      missing: [`Observed arithmetic does not identify the business cause; historical delivery and matched ${OW.one} evidence are still required for that claim.`] }] : [],
    counterEvidence: statement(`AppointmentConfirmed and Purchase are separate Meta estimates. Neither substitutes for the other or proves recorded ${OW.many}. A change in average return or cost does not establish the effect of moving budget. Stable observed ratios alone do not require intervention.`, ...refs),
    nextInspection: { question: `Inspect ${row.entity.name}'s exact delivery, budget context and named-event evidence behind the observed answer.`, href: href(row), outcomes: [
      { result: 'The observed movement persists with mature outcomes and compatible historical conditions.', interpretation: 'Frame an owner-reviewed investigation or test; the effect of a spend change remains unknown.' },
      { result: 'Later outcomes or different delivery conditions change the comparison.', interpretation: 'Revise the current interpretation while retaining the original saved observation.' },
    ] }, limitations: [...entries.flatMap(field => field.limits), ...(budgetRefs.length ? [BUDGET_EVIDENCE_LIMIT] : []),
      'Unequal optimizer delivery is not a randomized allocation experiment; these observations do not predict marginal return.',
      'Campaigns, ad sets and ads overlap hierarchically. Their spend is never added together as account exposure.',
      'Unavailable event counts, values, prior periods and adapter-withheld ROAS remain unavailable independently. Purchase CPA uses matching Meta spend and Purchase count; missing Purchase value alone does not invalidate this cost.',
      'Matching current columns do not establish historical attribution-definition continuity. Partial periods have no signed comparison; settling differences are provisional.',
      'Small event counts and unknown business targets do not establish a winner or an intervention threshold.'],
    exposure: spendRef && currentSpend ? { value: currentSpend.value, unit: 'money', evidence: [spendRef] } : null,
    authority: { state: 'diagnostic', executable: false },
  } }
}
export function derivePerformanceReview(data: ReportingData): { findings: ReviewFinding[]; coverage: ReviewPopulationCoverage[] } {
  const entities = ['available', 'partial'].includes(data.meta.state) ? data.meta.data?.entities ?? [] : []
  const rows = entities.map((entity, index) => ({ entity, result: assessment({ entity, index, data }) }))
  return { findings: rows.map(row => row.result.finding), coverage: (['campaign', 'adset', 'ad'] as const).map(level => {
    const population = rows.filter(row => row.entity.level === level), evaluated = population.filter(row => row.result.evaluated).length
    return { family: 'Performance', level, supplied: population.length, evaluated, limited: population.length - evaluated }
  }) }
}
