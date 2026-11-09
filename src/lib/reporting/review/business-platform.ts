import type { ReportingData } from '../contracts'
import type { ReviewEvidence, ReviewFinding, ReviewObservationSection } from './contracts'
import { observationSectionText } from './observation'
import { businessPlatformFields, BUSINESS_PLATFORM_KEYS, META_PLATFORM_KEYS, platformPeriod, platformValue, type PlatformField } from './business-platform-evidence'
import { reportLink, statement } from './evidence'
import { outcomeWords } from '@/config/outcome-nouns'

// What this business calls its outcomes (NEXT_PUBLIC_OUTCOME_NOUN).
const OW = outcomeWords()

type Fields = Record<string, PlatformField>
const sign = (field: PlatformField) => field.change === null ? null : Math.sign(field.change)
const movement = (field: PlatformField, label = field.label) => field.change === null ? `${label} comparison is unavailable`
  : `${label} ${field.change > 0 ? 'rose' : field.change < 0 ? 'fell' : [`Active ${OW.many}`, `Paid ${OW.many}`].includes(label) ? 'were unchanged' : 'was unchanged'}`
const outcomeKeys = ['bookings', 'appointment_value', 'appointment_roas', 'purchase_count', 'purchase_value', 'purchase_roas', 'cost_per_purchase']
const outcomeSign = (field: PlatformField) => sign(field) === null ? null : sign(field)! * (field.label === 'Purchase CPA' ? -1 : 1)

function primaryOutcomes(fields: Fields): PlatformField[] {
  return [['bookings', 'appointment_value', 'appointment_roas'], ['purchase_count', 'purchase_value', 'purchase_roas']]
    .flatMap(keys => {
      const field = keys.map(key => fields[key]).find(field => field.current) ?? keys.map(key => fields[key]).find(field => field.prior)
      return field ? [field] : []
    })
}
function conclusion(fields: Fields): { text: string; mixed: boolean; stable: boolean } {
  const booked = fields.booked_value, active = fields.active_appointments
  const core = [booked, active].filter(field => field.change !== null)
  const outcomes = outcomeKeys.map(key => fields[key]).filter(field => field.change !== null)
  const primary = primaryOutcomes(fields).filter(field => field.change !== null)
  const moving = core.filter(field => field.change !== 0)
  const relations = moving.filter((field, index) => index === 0 || sign(field) !== sign(moving[0])).map(field => {
    const aligned = primary.filter(outcome => sign(field)! * sign(outcome)! > 0).map(outcome => outcome.label)
    const opposed = primary.filter(outcome => sign(field)! * sign(outcome)! < 0).map(outcome => outcome.label)
    return `${field.label}${aligned.length ? ` aligned with Meta ${aligned.join(' and ')}` : ''}${opposed.length ? `${aligned.length ? ' but' : ''} moved opposite to Meta ${opposed.join(' and ')}` : ''}${!aligned.length && !opposed.length ? '; matched Meta outcomes were unchanged or unavailable' : ''}`
  })
  const businessMixed = core.length > 1 && sign(booked)! * sign(active)! < 0
  const outcomeSigns = outcomes.map(field => outcomeSign(field)!)
  const metaMixed = outcomeSigns.some(value => value > 0) && outcomeSigns.some(value => value < 0)
  const opposed = core.some(field => outcomes.some(outcome => sign(field)! * outcomeSign(outcome)! < 0))
  const paymentContrary = [fields.amount_paid, fields.paid_bookings].some(field => [...core, ...outcomes].some(other => sign(field) !== null && outcomeSign(other)! * sign(field)! < 0))
  const considered = [...core, ...outcomes, fields.amount_paid, fields.paid_bookings, fields.spend]
  const stable = core.length === 2 && outcomes.length > 0 && considered.every(field => field.change === 0)
  const limited = !core.length || !outcomes.length || [booked, active, fields.amount_paid, fields.paid_bookings, fields.spend].some(field => field.change === null)
  const relationship = !outcomes.length ? 'A compatible Meta outcome comparison is unavailable'
    : relations.length ? relations.join('; ') : !core.length ? 'Booked-demand comparison is unavailable; supported Meta observations remain separate'
      : outcomes.every(field => field.change === 0) ? `${core.map(field => field.label).join(' and ')} and the supported Meta outcomes were unchanged`
        : `${core.map(field => field.label).join(' and ')} ${core.length > 1 || core[0].label === 'Active appointments' ? 'were' : 'was'} unchanged while supported Meta outcomes changed`
  return { text: `${relationship}.`, mixed: businessMixed || paymentContrary || opposed || metaMixed || limited, stable }
}

function compact(field: PlatformField): string {
  return field.change === null ? platformPeriod(field) : `${movement(field)} (${platformValue(field.current)}; prior ${platformValue(field.prior)})`
}
function opening(fields: Fields, relationship: string): ReviewObservationSection[] {
  const business = [fields.booked_value, fields.active_appointments].map(compact).join('; ')
  const meta = primaryOutcomes(fields).map(primary => {
    const prefix = primary.label.startsWith('AppointmentConfirmed') ? 'appointment_' : 'purchase_'
    const contrary = [`${prefix}value`, `${prefix}roas`].map(key => fields[key])
      .filter(field => field !== primary && field.change !== null && (primary.change === null || sign(primary) !== sign(field)))
    return [compact(primary), ...contrary.map(compact), ...(prefix === 'purchase_' ? [compact(fields.cost_per_purchase)] : [])].join('; ')
  }).join('; ')
  const payments = [fields.amount_paid, ...[fields.paid_bookings].filter(field => field.ref && (fields.amount_paid.change === null
    || sign(field) !== sign(fields.amount_paid) || sign(field) !== sign(fields.active_appointments)))].map(compact).join('; ')
  return [
    { heading: 'Outcome source booked demand', paragraphs: [`Outcomes, all sources: ${business}.`] },
    { heading: 'Relationship between sources', paragraphs: [relationship] },
    { heading: 'Meta outcomes', paragraphs: [meta ? `Meta: ${meta}.` : 'Meta observations are unavailable.'] },
    { heading: 'Recorded payments', paragraphs: [`${payments}.`] },
    { heading: 'Meta spend', paragraphs: [`${compact(fields.spend)}.`] },
  ]
}

function nativeFacts(fields: Fields): string {
  const business = BUSINESS_PLATFORM_KEYS.filter(key => fields[key].ref).map(key => platformPeriod(fields[key]))
  const meta = META_PLATFORM_KEYS.filter(key => fields[key].ref).map(key => platformPeriod(fields[key]))
  return `${business.length ? `Outcomes, all sources: ${business.join('; ')}.` : 'outcome business observations are unavailable.'} ${meta.length
    ? `Meta: ${meta.join('; ')}.` : 'Meta observations are unavailable.'}`
}

/** One account comparison; every retained native measure keeps its own approved periods. */
export function deriveBusinessPlatformReview(data: ReportingData): ReviewFinding {
  const fields = businessPlatformFields(data), result = conclusion(fields)
  const entries = Object.values(fields), refs = entries.map(field => field.ref).filter((ref): ref is ReviewEvidence => !!ref)
  const available = refs.length > 0
  const evidencePeriods = Object.fromEntries(entries.flatMap(field => field.ref ? [[field.ref.id,
    [...(field.current ? ['current' as const] : []), ...(field.prior ? ['prior' as const] : [])]]] : []))
  const book = fields.booked_value, paid = fields.amount_paid, spend = fields.spend
  const exposed = [book, fields.active_appointments, paid, spend].find(field => field.current && field.current.value >= 0)
  const exposure = exposed?.ref && exposed.current ? { value: exposed.current.value,
    unit: exposed.current.claim.unit as 'money' | 'count', evidence: [exposed.ref] } : null
  const details = nativeFacts(fields), sections = opening(fields, result.text)
  return {
    id: 'business_platform_trend', area: 'business', title: 'Business and Meta period review',
    status: !available ? 'unavailable' : result.mixed ? 'mixed' : result.stable ? 'unchanged' : 'observed',
    observation: { ...statement(observationSectionText(sections), ...refs), sections }, evidencePeriods,
    materiality: { ...statement(`Booked value ${platformValue(book.current)}, recorded amount paid ${platformValue(paid.current)} and Meta spend ${platformValue(spend.current)} describe separate populations; they are not added or divided across sources.`, book.ref, paid.ref, spend.ref),
      priorityReason: 'Explain booked demand, recorded payments and platform-reported outcomes independently before investigating their differences.' },
    explanations: [{ hypothesis: `Different ${OW.one}-creation and impression-date populations, or their composition, may explain a different period pattern.`,
      evidence: refs, missing: [`Matched ${OW.one} records and verified historical attribution and delivery conditions.`] }],
    counterEvidence: statement(`${details} the outcome source uses all-source ${OW.one}-creation dates; Meta uses impression-date attributed estimates. ${result.stable
      ? 'Unchanged supported account totals alone do not justify changing this comparison, and do not clear a lower-ad or service-level problem.'
      : 'A gain in one measure does not erase a decline in another or a lower-ad problem.'} Unknown business targets cannot establish healthy performance.`, ...refs),
    nextInspection: { question: result.stable ? 'Optional: inspect the exact native evidence behind the unchanged supported account measures.'
      : result.mixed ? 'Which native coverage, timing or composition evidence explains the specific differences above?'
        : 'Do service and ad-level observations support these account-level movements?',
      href: `${reportLink(data, '/reports', { report: 'business' })}#business-results`, outcomes: [
        { result: 'The separate movements remain after native coverage and dates are checked.', interpretation: 'Retain the observed relationship; any explanation still needs matched timing or composition evidence.' },
        { result: 'A field has missing, unsettled or incompatible evidence.', interpretation: 'Withhold only that comparison and retain the independent valid observations.' },
      ] },
    limitations: [...entries.flatMap(field => field.limits),
      `Booked value and active ${OW.many} cover all-source active ${OW.one}-created records; active ${OW.many} also include zero-price records. Paid ${OW.many} require a positive recorded payment.`,
      `Recorded amount paid describes current outcome ledger fields for the ${OW.one}-created cohort, without payment-event history or processor settlement reconciliation.`,
      'Meta AppointmentConfirmed and Purchase are separately named platform estimates, not outcome business truth. Their event counts and values are never combined; native ROAS uses only the matching event value and Meta spend. Purchase CPA uses matching Meta spend and Purchase count, independently of Purchase value; it is not cost per verified recorded customer.',
      `${OW.One}-creation and impression-date observations do not establish causal lift, cross-source CPA or ROAS, profit, or authorization for a buying action.`,
      'A matching native column does not verify historical attribution-setting stability or an account-specific 2026 attribution-definition transition.',
      'Outcome source freshness is an exact retrieval observation, not verified historical ledger immutability. Small or zero counts alone do not establish a reliable trend or an approved target.',
    ], exposure, authority: { state: 'diagnostic', executable: false },
  }
}
