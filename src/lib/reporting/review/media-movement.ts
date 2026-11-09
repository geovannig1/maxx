import { formatMoneyTrim } from '@/lib/utils/format-currency'
import type { ReportingData } from '../contracts'
import { businessPlatformFields, mediaEntityFields, platformEvidencePeriods, platformPeriod, platformValue, type PlatformField } from './business-platform-evidence'
import type { ReviewFinding, ReviewObservationSection } from './contracts'
import { observationSectionText } from './observation'
import { reportLink, statement } from './evidence'

const KEYS = ['spend', 'bookings', 'appointment_value', 'purchase_count', 'purchase_value'] as const
const eligible = (value: PlatformField['current']) => !!value && (value.eligible || value.qualifications.length > 0
  && value.qualifications.every(reason => ['settling period', 'partial period'].includes(reason)))
const formatted = (value: number, unit: string) => (unit === 'money' ? formatMoneyTrim(Math.abs(value)) : Math.abs(value).toLocaleString('en-US', { maximumFractionDigits: 2 }))
const signed = (value: number, unit: string) => `${value < 0 ? '-' : value > 0 ? '+' : ''}${formatted(value, unit)}`
const difference = (a: number, b: number, terms: number) => Math.abs(a - b) <= Number.EPSILON * Math.max(1, Math.abs(a), Math.abs(b)) * Math.max(8, terms * 2) ? 0 : a - b

/** Campaign population explanation; no overlapping hierarchy totals or reconstructed efficiency. */
export function deriveMediaMovement(data: ReportingData): ReviewFinding {
  const account = businessPlatformFields(data)
  const rows = ['available', 'partial'].includes(data.meta.state) ? (data.meta.data?.entities ?? []).map((entity, index) => ({ entity, index }))
    .filter(row => row.entity.level === 'campaign').map(row => ({ ...row, fields: mediaEntityFields(data, row.index) })) : []
  const unique = new Set(rows.map(row => row.entity.id)).size === rows.length
  const fields = [...Object.values(account).filter(field => field.ref?.source === 'meta'), ...(unique ? rows.flatMap(row => Object.values(row.fields)) : [])]
  const refs = fields.map(field => field.ref)
  const summaries: ReviewObservationSection[] = [], contributions: string[] = []
  let offset = false, moving = Object.values(account).some(field => field.ref?.source === 'meta' && field.change !== null && field.change !== 0), limited = !rows.length || !unique, provisional = false
  for (const key of KEYS) {
    const headline = account[key], unit = headline.current?.claim.unit ?? headline.prior?.claim.unit ?? (key.includes('value') || key === 'spend' ? 'money' : 'count')
    const members = unique ? rows.map(row => ({ name: row.entity.name, field: row.fields[key] })) : []
    const totals = (period: 'current' | 'prior') => {
      const observed = members.flatMap(row => eligible(row.field[period]) ? [row.field[period]!] : [])
      const sum = observed.reduce((sum, value) => sum + value.value, 0)
      const known = observed.length > 0 && Number.isFinite(sum), total = headline[period]
      if (observed.some(value => value.qualifications.length)) provisional = true
      if (observed.length !== rows.length || !known) limited = true
      const residual = known && eligible(total) ? difference(total!.value, sum, observed.length) : null
      if (residual !== 0) limited = true
      const qualifications = [...new Set(observed.flatMap(value => value.qualifications))]
      return `${known ? formatted(sum, unit) : 'unavailable'} (${observed.length}/${rows.length} campaigns)${qualifications.length ? ` [${qualifications.join('; ')}]` : ''}${residual === null ? '; account reconciliation unavailable'
        : residual === 0 ? '; matches the supplied account field' : `; unresolved account difference ${signed(residual, unit)}`}`
    }
    const comparable = members.filter(row => row.field.change !== null)
    const gains = comparable.reduce((sum, row) => sum + Math.max(0, row.field.change!), 0)
    const losses = comparable.reduce((sum, row) => sum + Math.min(0, row.field.change!), 0)
    const leaders = [1, -1].flatMap(sign => {
      const ordered = comparable.filter(row => Math.sign(row.field.change!) === sign)
        .sort((a, b) => Math.abs(b.field.change!) - Math.abs(a.field.change!) || a.name.localeCompare(b.name))
      const first = ordered[0]
      return first ? [`Largest ${sign > 0 ? 'gain' : 'loss'}: ${first.name} (${signed(first.field.change!, unit)}).`] : []
    }).join(' ')
    if (gains > 0 && losses < 0) offset = true
    if (gains || losses) moving = true
    const changes = comparable.length && Number.isFinite(gains) && Number.isFinite(losses)
      ? `Matched member movements: gains ${signed(gains, unit)}, losses ${signed(losses, unit)}, net ${signed(gains + losses, unit)} (${comparable.length}/${rows.length}). ${leaders}`
      : 'Compatible member movements unavailable.'
    summaries.push({ heading: headline.label as ReviewObservationSection['heading'], paragraphs: [
      `${headline.label}: current ${totals('current')};`, `prior ${totals('prior')}.`, changes,
    ] })
    contributions.push(`${headline.label} by campaign: ${members.length ? members.map(({ name, field }) => `${name}: ${platformValue(field.current)} (prior ${platformValue(field.prior)}); ${field.change === null ? 'change unavailable' : `change ${signed(field.change, unit)}`}`).join('; ') : 'unavailable'}.`)
  }
  const accountText = ['spend', 'appointment_roas', 'purchase_roas', 'cost_per_purchase'].map(key => platformPeriod(account[key])).join('; ')
  const available = refs.some(Boolean), spend = account.spend
  const exposure = spend.ref && spend.current ? { value: spend.current.value, unit: 'money' as const, evidence: [spend.ref] } : null
  const text = !rows.length ? `Campaign observations are unavailable. ${accountText}. Account outcomes are not assigned to an ad set or ad.`
    : !unique ? `The ${rows.length} supplied campaign rows contain duplicate campaign identities; campaign sums and contributions are withheld. ${accountText}.`
      : `${rows.length} supplied campaigns reviewed.${offset ? ' Opposing member gains and losses offset one another; the headline alone hides that movement.' : ''}${provisional ? ' Qualified campaign snapshots cover partial or settling periods; partial-period changes are withheld and settling differences remain provisional.' : ''}`
  const sections: ReviewObservationSection[] = [{ paragraphs: [text] }, ...(rows.length && unique ? [
    ...summaries, { heading: 'Account efficiency' as const, paragraphs: [`Account efficiency: ${accountText}.`] },
  ] : [])]
  return {
    id: 'advertising.allocation', area: 'advertising', title: 'Media results and campaign drivers',
    status: !available ? 'unavailable' : limited || offset ? 'mixed' : moving ? 'observed' : 'unchanged',
    priority: offset ? 'investigate' : 'context',
    observation: { ...statement(observationSectionText(sections), ...refs), sections }, evidencePeriods: platformEvidencePeriods(fields),
    materiality: { ...statement(exposure ? `${platformValue(spend.current)} native account spend. Campaign contributions are assessed at one hierarchy level; ad sets and ads retain complete independent assessments.`
      : 'Account spend is unavailable; valid campaign and named-event observations remain separate.', spend.ref),
      priorityReason: 'Explain the full supplied campaign population and opposing contributions before any smaller set of entity highlights.' },
    explanations: [],
    counterEvidence: statement(`${contributions.join(' ')} AppointmentConfirmed and Purchase stay separate. A change in reported value, count or average ROAS is not incremental recorded revenue or a prediction of moving budget.`, ...refs),
    nextInspection: { question: 'Inspect all campaigns and their ad sets, ads and native event definitions behind these contributions.',
      href: reportLink(data, '/performance', { level: 'campaign', group: 'results' }), outcomes: [
        { result: 'Compatible smaller members offset the headline movement.', interpretation: 'Retain both gains and losses and inspect their exact ad-set or creative evidence; account averages do not clear them.' },
        { result: 'Fields are incomplete or differ from the account population.', interpretation: 'Keep observed members visible and the specific difference unresolved, without assigning it to a campaign.' },
      ] }, limitations: [
      'Only supplied campaign observations are assessed; explicit lineage and reconciliation do not independently prove upstream population completeness.',
      'Each metric and period has its own observed population. Missing fields and inventory-only rows are unknown, never zero; signed movements require the same member in both compatible periods.',
      'Account-minus-observed-campaign differences are unresolved reconciliation differences, not attributed revenue, lost sales or recoverable budget.',
      'Campaigns, ad sets and ads overlap. No cross-level sum is an account total, and ROAS or CPA values are not summed or averaged.',
      'Unequal optimizer delivery and current configuration cannot establish historical exposure, targeting or a causal budget-transfer result.',
      'Settling outcomes may be revised. Partial periods have no signed comparison; matching fields do not prove historical attribution-definition continuity.',
      ...(!unique ? ['Duplicate campaign identities prevent campaign arithmetic.'] : []),
    ], exposure, authority: { state: 'diagnostic', executable: false },
  }
}
