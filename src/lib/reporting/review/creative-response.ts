import { formatMoney, currencyFractionDigits } from '@/lib/utils/format-currency'
import type { MetricClaim } from '@/lib/cockpit/contracts'
import type { ReportEntity, ReportingData } from '../contracts'
import { compareCreativeEvidenceInstants } from '../creative-assignment-contract'
import { META_NATIVE_METRIC_DEFINITIONS, META_RATIO_METRIC_DEFINITIONS, metaNativeMetricDescription } from '../meta-metric-definitions'
import type { ReviewEvidence, ReviewFinding, ReviewPopulationCoverage } from './contracts'
import { metricEvidence, reportLink, statement } from './evidence'
import { mediaEntityFields, platformPeriod, type PlatformField } from './business-platform-evidence'
import { observationSectionText } from './observation'
import { outcomeWords } from '@/config/outcome-nouns'

// What this business calls its outcomes (NEXT_PUBLIC_OUTCOME_NOUN).
const OW = outcomeWords()

type Period = 'current' | 'previous'
type Observation = { value: number; claim: MetricClaim; complete: boolean; qualifications?: string[] }
type Field = { ref: ReviewEvidence | null; current: Observation | null; previous: Observation | null; comparable: boolean }
const nativeDefinitions = new Map(META_NATIVE_METRIC_DEFINITIONS.map(definition => [definition.key, definition]))
const ratioDefinitions = new Map(META_RATIO_METRIC_DEFINITIONS.map(definition => [definition[0], definition]))
const OUTCOMES = ['bookings', 'appointment_value', 'appointment_roas', 'purchase_count', 'purchase_value', 'purchase_roas']
const SHARED = ['spend', ...OUTCOMES, 'cost_per_purchase']
const INQUIRY = ['messaging_conversations_started', 'messaging_conversations_replied', 'messaging_first_replies',
  'instagram_profile_visits', 'instagram_profile_follows', 'action_video_views'] as const
const INQUIRY_COSTS = ['cost_per_messaging_conversation_started', 'cost_per_instagram_profile_visit',
  'cost_per_instagram_profile_follow', 'cost_per_action_video_view'] as const
const KEYS = ['spend', 'impressions', 'engagements', 'engagement_rate', 'reactions', 'comments', 'shares', 'share_rate', 'saves',
  'outbound_clicks', 'outbound_ctr', 'landing_page_views', ...INQUIRY, 'cost_per_engagement', 'cost_per_share',
  'outbound_cpc', 'cost_per_lpv', ...INQUIRY_COSTS, 'cost_per_booking', 'cost_per_purchase', ...OUTCOMES]
const CORE = ['engagements', 'engagement_rate', 'outbound_clicks', 'outbound_ctr', 'landing_page_views', 'bookings', ...INQUIRY]
const STABILITY_CORE = ['engagements', 'engagement_rate', 'outbound_clicks', 'outbound_ctr', 'landing_page_views', 'bookings']
const COSTS = ['cost_per_engagement', 'outbound_cpc', 'cost_per_lpv', 'cost_per_booking', 'cost_per_purchase', ...INQUIRY_COSTS]

function expected(key: string) {
  const native = nativeDefinitions.get(key), ratio = ratioDefinitions.get(key)
  if (native) return { label: native.label, definition: metaNativeMetricDescription(native), unit: native.unit,
    event: native.event ?? null, attributed: !!(native.event || native.action || native.attributed), derived: false }
  if (!ratio) return null
  const [, label, numerator, denominator, scale, unit] = ratio
  const a = nativeDefinitions.get(numerator)!, b = nativeDefinitions.get(denominator)!
  return { label, unit, event: a.event ?? b.event ?? null, derived: true,
    attributed: !!(a.event || a.action || a.attributed || b.event || b.action || b.attributed),
    definition: `${a.label} / ${b.label}${scale !== 1 ? ` × ${scale}` : ''}; matching Meta population and period with complete input coverage.` }
}

function observation(data: ReportingData, entity: ReportEntity, ref: ReviewEvidence | null, key: string, period: Period): Observation | null {
  const metric = ref?.metric, claim = metric?.[period], definition = expected(key)
  if (!metric || !claim || !definition) return null
  const range = period === 'current' ? data.context.range : data.context.comparison
  if (metric.key !== key || metric.label !== definition.label || metric.event !== definition.event || metric.definition !== definition.definition
    || claim.metricKey !== `meta.${key}` || claim.claimId !== `report:meta:ad:${entity.id}:${key}:${range.from}:${range.to}`
    || claim.label !== definition.label || claim.formula !== definition.definition || claim.unit !== definition.unit || claim.definitionVersion !== 1
    || claim.entity.level !== 'ad' || claim.entity.id !== entity.id || claim.source.system !== 'meta'
    || claim.source.role !== 'delivery_truth' || claim.source.evidencePlane !== 'meta_delivery'
    || claim.attributionScope !== (definition.attributed ? 'meta_platform_modelled' : 'none')
    || claim.measurementKind !== (definition.derived ? 'derived' : definition.attributed ? 'modelled' : 'measured')
    || claim.window.start !== range.from || claim.window.end !== range.to || claim.window.basis !== 'impression_date_et'
    || claim.window.timezone !== data.context.timezone || claim.authority.state !== 'diagnostic' || claim.authority.policyVersion !== 'reporting-v1'
    || claim.availability.state !== 'available' || typeof claim.value !== 'number' || !Number.isFinite(claim.value) || claim.value < 0
    || definition.unit === 'count' && !Number.isSafeInteger(claim.value)
    || claim.source.head !== (definition.derived ? null : `meta-live:${data.context.account.metaAccountId}:${claim.asOf}`)
    || !definition.derived && claim.inputClaimIds.length !== 0) return null
  try {
    if (!data.meta.asOf || compareCreativeEvidenceInstants(claim.asOf, data.meta.asOf) !== 0
      || compareCreativeEvidenceInstants(claim.asOf, data.context.asOf) > 0
      || !claim.freshness.observedAt || compareCreativeEvidenceInstants(claim.freshness.observedAt, claim.asOf) !== 0) return null
  } catch { return null }
  const complete = claim.coverage.state === 'complete' && claim.freshness.state === 'fresh' && claim.maturity.state !== 'partial'
  return definition.derived && !complete ? null : { value: claim.value, claim, complete }
}

function field(data: ReportingData, entity: ReportEntity, index: number, key: string, fields: Record<string, Field>): Field {
  const ref = metricEvidence(data, 'meta', ['entities', index, 'metrics', key])
  const ratio = ratioDefinitions.get(key)
  const read = (period: Period): Observation | null => {
    const value = observation(data, entity, ref, key, period)
    if (!value || !ratio) return value
    const [, , numerator, denominator, scale] = ratio
    const a = fields[numerator]?.[period], b = fields[denominator]?.[period]
    if (!a?.complete || !b?.complete || b.value <= 0 || a.claim.source.head !== b.claim.source.head) return null
    const inputs = value.claim.inputClaimIds, expected = a.value / b.value * scale
    return inputs.length === 2 && new Set(inputs).size === 2 && inputs.includes(a.claim.claimId) && inputs.includes(b.claim.claimId)
      && Number.isFinite(expected) && Math.abs(value.value - expected) <= Number.EPSILON * Math.max(Math.abs(value.value), Math.abs(expected)) * 8 ? value : null
  }
  const current = read('current'), previous = read('previous'), comparison = current?.claim.comparison
  return { ref: current || previous ? ref : null, current, previous,
    comparable: !!(current?.complete && previous?.complete && comparison?.method === 'prior_equal_period'
      && (!ratio || fields[ratio[2]].comparable && fields[ratio[3]].comparable)
      && comparison.window?.start === data.context.comparison.from && comparison.window.end === data.context.comparison.to
      && comparison.window.basis === 'impression_date_et' && comparison.window.timezone === data.context.timezone) }
}

function outcomeField(field: PlatformField): Field {
  const read = (value: PlatformField['current']): Observation | null => value && { value: value.value, claim: value.claim,
    complete: value.eligible || value.qualifications.every(reason => reason === 'settling period'), qualifications: value.qualifications }
  return { ref: field.ref, current: read(field.current), previous: read(field.prior), comparable: field.change !== null }
}

function format(observation: Observation | null): string {
  if (!observation) return 'unavailable'
  const { value, claim } = observation
  const minorUnit = 10 ** -currencyFractionDigits()
  const formatted = claim.unit === 'money' && value > 0 && value < minorUnit / 2 ? `<${formatMoney(minorUnit)}`
    : claim.unit !== 'money' && value > 0 && value < 0.005 ? '<0.01%'
    : claim.unit === 'money' ? formatMoney(value, { minimumFractionDigits: value % 1 ? currencyFractionDigits() : 0, maximumFractionDigits: currencyFractionDigits() })
    : `${value.toLocaleString('en-US', { maximumFractionDigits: 2 })}${claim.unit === 'percent' ? '%' : ''}`
  const qualifications = [...new Set([claim.coverage.state !== 'complete' ? `${claim.coverage.state === 'unknown' ? 'unverified' : 'partial'} coverage` : '',
    claim.freshness.state !== 'fresh' ? `${claim.freshness.state} freshness` : '', claim.maturity.state === 'partial' ? 'partial period' : '',
    ...(observation.qualifications ?? [])].filter(Boolean))]
  return `${formatted}${qualifications.length ? ` [${qualifications.join('; ')}]` : ''}`
}
function change(field: Field): number | null {
  if (!field.comparable) return null
  const a = field.current!.value, b = field.previous!.value
  return field.current!.claim.unit !== 'count' && Math.abs(a - b) <= Number.EPSILON * Math.max(Math.abs(a), Math.abs(b)) * 8 ? 0 : Math.sign(a - b)
}
function responseDirection(fields: Record<string, Field>): ReviewFinding['direction'] {
  const rates = [fields.engagement_rate, fields.outbound_ctr]
  const changes = rates.filter(rate => rate.comparable).map(rate => change(rate)!)
  return changes.some(value => value > 0) && changes.some(value => value < 0) ? 'mixed' : changes.some(change => change > 0) ? 'improved'
    : changes.some(change => change < 0) ? 'declined' : undefined
}
function direction(fields: Record<string, Field>): ReviewFinding['direction'] {
  const response = [change(fields.engagement_rate), change(fields.outbound_ctr),
    ...COSTS.map(key => change(fields[key]) === null ? null : -change(fields[key])!)]
  const changes = [...response, change(fields.landing_page_views), ...OUTCOMES.map(key => change(fields[key]))]
  const gain = changes.some(value => value !== null && value > 0), decline = changes.some(value => value !== null && value < 0)
  return gain && decline ? 'mixed' : gain ? 'improved' : decline ? 'declined' : undefined
}
function relationship(fields: Record<string, Field>, movement: ReviewFinding['direction']): string {
  if (!fields.engagement_rate.comparable || !fields.outbound_ctr.comparable) {
    return [['engagement_rate', 'Engagement per impression'], ['outbound_ctr', 'Outbound CTR']].map(([key, label]) => {
      const movement = change(fields[key])
      return movement === null ? `${label} has no compatible same-ad prior comparison; independent current and prior observations remain descriptive.`
        : `${label} ${movement > 0 ? 'increased' : movement < 0 ? 'decreased' : 'was unchanged'} in its compatible same-ad comparison.`
    }).join(' ')
  }
  if (movement === 'mixed') return fields.engagement_rate.current!.value > fields.engagement_rate.previous!.value
    ? 'Engagement per impression increased while outbound CTR decreased.' : 'Engagement per impression decreased while outbound CTR increased.'
  if (movement === 'improved') return 'Engagement per impression and outbound CTR improved or held steady, with at least one gain.'
  if (movement === 'declined') return 'Engagement per impression and outbound CTR declined or held steady, with at least one decline.'
  return 'Engagement per impression and outbound CTR were unchanged.'
}

function assessment(data: ReportingData, entity: ReportEntity, index: number): { finding: ReviewFinding; evaluated: boolean; limited: boolean } {
  const outcomes = mediaEntityFields(data, index)
  const fields: Record<string, Field> = Object.fromEntries(SHARED.map(key => [key, outcomeField(outcomes[key])]))
  // Native fields precede ratios so every dependent calculation sees independently validated inputs.
  const responseKeys = KEYS.filter(key => !SHARED.includes(key))
  for (const key of [...responseKeys.filter(key => nativeDefinitions.has(key)), ...responseKeys.filter(key => ratioDefinitions.has(key))]) {
    fields[key] = field(data, entity, index, key, fields)
  }
  const evaluated = [...CORE, ...OUTCOMES].some(key => fields[key].current || fields[key].previous)
  const limited = [...CORE, ...OUTCOMES].some(key => !fields[key].comparable)
  const movement = direction(fields), responseMovement = responseDirection(fields)
  const stable = !movement && [...STABILITY_CORE, 'spend', 'impressions'].every(key => change(fields[key]) === 0)
    && OUTCOMES.every(key => !fields[key].ref || change(fields[key]) === 0)
  const evidence = KEYS.map(key => fields[key].ref)
  const evidencePeriods = Object.fromEntries(KEYS.flatMap(key => fields[key].ref ? [[fields[key].ref!.id,
    [...(fields[key].current ? ['current' as const] : []), ...(fields[key].previous ? ['prior' as const] : [])]]] : []))
  const describe = (key: string) => `${key === 'bookings' ? 'AppointmentConfirmed' : expected(key)!.label} ${format(fields[key].current)} (prior ${format(fields[key].previous)})`
  const measured = ['engagements', 'engagement_rate', 'cost_per_engagement', 'outbound_clicks', 'outbound_ctr', 'landing_page_views', 'bookings', 'spend']
    .filter(key => CORE.includes(key) || fields[key].current || fields[key].previous).map(describe).join('; ')
  const social = ['reactions', 'comments', 'shares', 'saves'].filter(key => fields[key].current || fields[key].previous).map(describe).join('; ')
  const inquiry = [...INQUIRY, ...INQUIRY_COSTS].filter(key => fields[key].current || fields[key].previous).map(describe).join('; ')
  const namedOutcomes = [...OUTCOMES, 'cost_per_purchase'].filter(key => key !== 'bookings').map(key => platformPeriod(outcomes[key])).join('; ')
  const provisional = OUTCOMES.some(key => outcomes[key].change !== null
    && (outcomes[key].current?.qualifications.length || outcomes[key].prior?.qualifications.length))
  const purchaseCostChange = change(fields.cost_per_purchase)
  const purchaseCostText = purchaseCostChange ? ` Purchase CPA ${purchaseCostChange > 0 ? 'increased' : 'decreased'} in the compatible comparison.` : ''
  const bookingChange = change(fields.bookings), costIncrease = COSTS.filter(key => key !== 'cost_per_purchase' && change(fields[key]) === 1)
  const namedChanges = [-1, 1].flatMap(sign => {
    const names = OUTCOMES.filter(key => key !== 'bookings' && change(fields[key]) === sign).map(key => outcomes[key].label)
    return names.length ? [`${names.join(', ')} ${sign < 0 ? 'decreased' : 'increased'}.`] : []
  }).join(' ')
  const outcome = `${bookingChange ? ` Reported AppointmentConfirmed ${bookingChange < 0 ? 'decreased' : 'increased'}.` : ''}${costIncrease.length
    ? ` ${costIncrease.map(key => expected(key)!.label).join(', ')} increased in the compatible comparison.` : ''}${namedChanges ? ` ${namedChanges}` : ''}${purchaseCostText}`
  const coexistence = movement === 'mixed' ? ' Supported response, cost, arrival and named-event comparisons include gains and declines; these movements coexist and do not form a joined funnel.' : ''
  const zero = fields.bookings.current?.value === 0
  const spend = fields.spend.current, spendRef = fields.spend.ref
  const impressions = fields.impressions.current, impressionsRef = fields.impressions.ref
  const exposure = spend && spendRef ? { value: spend.value, unit: 'money' as const, evidence: [spendRef] }
    : impressions && impressionsRef ? { value: impressions.value, unit: 'count' as const, evidence: [impressionsRef] } : null
  const sections = [
    { paragraphs: [`${entity.name}: ${relationship(fields, responseMovement)}${outcome}${coexistence}${provisional ? ' Observed comparisons are provisional; outcomes are still settling and may be revised.' : ''}`] },
    { paragraphs: [`${measured}.`] },
    ...(inquiry ? [{ paragraphs: [`Named social/inquiry response: ${inquiry}.`] }] : []),
    { paragraphs: [`${namedOutcomes}. Prior means the prior equal period for this same ad.`] },
  ]
  const finding: ReviewFinding = {
    id: `creative_response:${entity.id}`, area: 'creative', entity: { id: entity.id, level: 'ad', name: entity.name },
    title: `Creative response: ${entity.name}`, status: !evaluated ? 'unavailable' : movement === 'mixed' ? 'mixed' : stable ? 'unchanged' : 'observed',
    priority: movement === 'mixed' || movement === 'declined' ? 'investigate' : 'context', ...(movement ? { direction: movement } : {}),
    observation: { ...statement(observationSectionText(sections), ...evidence), sections },
    evidencePeriods,
    materiality: { ...statement(exposure ? `${spend ? 'Reported spend' : 'Reported impressions'} ${format(spend ?? impressions)} describes this execution’s exposure; it is not recoverable money or a sample-sufficiency threshold.`
      : 'Current spend and impression exposure are unavailable; independently supported response observations remain usable.', spendRef, impressionsRef),
    priorityReason: 'Every supplied ad is assessed. Response, arrival and named-outcome movements are descriptive evidence, without a spend cutoff or assumed business target.' },
    explanations: movement ? [{ hypothesis: responseMovement === 'mixed'
      ? 'Engagement and outbound response can reflect different actions; message, audience or placement composition may explain the opposite movements.'
      : 'The observed response or reported-outcome movement may reflect message, audience, placement or delivery changes.',
    evidence: evidence.filter((ref): ref is ReviewEvidence => !!ref),
    missing: ['Comparable delivery conditions or a controlled creative test', 'Verified historical delivered-asset and audience composition'] }] : [],
    counterEvidence: statement(`${stable ? `Stable compatible primary response, spend and reported-${OW.one} evidence does not justify an intervention by itself. ` : ''}${zero
      ? `Meta reports zero AppointmentConfirmed for this ad; that zero does not establish zero all-source business ${OW.many} or negate its recorded response.`
      : fields.bookings.current ? `AppointmentConfirmed remains a separate Meta-reported event; response does not establish acquired customers or causal ${OW.many}.`
        : 'AppointmentConfirmed is unavailable for this ad; missing outcomes cannot be treated as zero.'} AppointmentConfirmed, Purchase, messaging, profile and video action counts are separate Meta-reported measures; none substitutes for customers, sales, outcome business truth or a causal response-to-${OW.one} path. ${responseMovement === 'mixed'
      ? 'The stronger response rate is contrary evidence to a blanket creative failure; the weaker one prevents treating all response as a gain.'
      : 'An unknown business target cannot establish healthy performance. Unequal delivery and separate count definitions remain alternative explanations.'}${social ? ` Named social counts: ${social}.` : ''}`, ...evidence),
    nextInspection: { question: stable ? `Optional: inspect the exact response evidence for ${entity.name}; these assessed observations alone do not justify intervention.`
      : movement ? `Optional: inspect ${entity.name}’s exact response, arrival and named-event evidence; the supported movements are stated above, while their cause remains unverified.`
        : `Optional: inspect ${entity.name}’s available response fields and their individual comparison limits.`,
    href: reportLink(data, '/creative', { ad: entity.id, group: 'response' }), outcomes: [
      { result: 'The response pattern persists with compatible definitions and comparable delivery.', interpretation: 'A specific test hypothesis may be useful; the pattern still does not establish a causal creative effect.' },
      { result: 'Missing coverage, changed delivery or incompatible evidence explains the apparent pattern.', interpretation: 'Qualify the affected comparison and retain the independent observations; no automatic creative or budget change follows.' },
    ] },
    limitations: [
      'Post engagement, reactions, comments, shares, saves, outbound clicks and landing-page views are separate Meta action counts, not unique people or a joined funnel; social components are not added to reconstruct engagement.',
      'Messaging actions, Instagram profile actions and Meta actions: video_view are named response signals only. Their exact deduplication, inactivity and short-video semantics are not inferred from the field names.',
      'Engagements and shares per impression are count ratios, not unique-person percentages, quality scores, qualified leads or causal lift.',
      'Meta AppointmentConfirmed and Purchase are separate platform-reported attribution measures, not outcome business truth. No account-specific 2026 attribution-definition transition or historical stability is inferred.',
      'Purchase CPA uses only matching Meta spend and Purchase count; unavailable Purchase value limits ROAS, not valid CPA. It is an average platform-reported cost, not a verified customer acquisition cost or a business target.',
      'Same-ad periods do not establish unchanged historical creative, audience, placement or attribution settings. These observations do not authorize a buying action.',
      ...(limited ? ['Some fields lack a complete compatible current/prior pair. Partial or unverified coverage leaves raw counts qualified; their dependent rates and directions are withheld.'] : []),
      ...[...OUTCOMES, 'cost_per_purchase'].flatMap(key => outcomes[key].limits),
    ], exposure, authority: { state: 'diagnostic', executable: false },
  }
  return { finding, evaluated, limited }
}

export function deriveCreativeResponseReview(data: ReportingData): { findings: ReviewFinding[]; coverage: ReviewPopulationCoverage } {
  const assessments = ['available', 'partial'].includes(data.meta.state) ? (data.meta.data?.entities ?? []).flatMap((entity, index) =>
    entity.level === 'ad' ? [assessment(data, entity, index)] : []) : []
  return { findings: assessments.map(row => row.finding), coverage: { family: 'Creative response', level: 'ad', supplied: assessments.length,
    evaluated: assessments.filter(row => row.evaluated).length, limited: assessments.filter(row => row.limited).length } }
}
