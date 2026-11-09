import { accountCurrency, accountLocale } from '@/config/business-config'
import { currencyFractionDigits } from '@/lib/utils/format-currency'
import type { MetricClaim } from '@/lib/cockpit/contracts'
import { BUSINESS_ACCOUNT_METRIC_DEFINITIONS } from '../business-metric-definitions'
import { makeReportMetric } from '../claims'
import { projectCampaignAuthority } from '../meta-campaign-authority'
import { classifyWindowSettle } from '@/lib/insights/settle-window'
import type { ReportMetric, ReportMetricMap, ReportingContext, ReportingData } from '../contracts'
import { compareCreativeEvidenceInstants as compareInstants } from '../creative-assignment-contract'
import { META_NATIVE_METRIC_DEFINITIONS, META_RATIO_METRIC_DEFINITIONS, metaNativeMetricDescription } from '../meta-metric-definitions'
import type { ReviewEvidence } from './contracts'
import { metricEvidence } from './evidence'
import { outcomeWords } from '@/config/outcome-nouns'

// What this business calls its outcomes (NEXT_PUBLIC_OUTCOME_NOUN).
const OW = outcomeWords()

type Observation = { value: number; claim: MetricClaim; eligible: boolean; qualifications: string[] }
export type PlatformField = {
  label: string; ref: ReviewEvidence | null; current: Observation | null; prior: Observation | null
  change: number | null; limits: string[]
}
export const BUSINESS_PLATFORM_KEYS = ['booked_value', 'active_appointments', 'amount_paid', 'paid_bookings'] as const
export const META_PLATFORM_KEYS = ['spend', 'bookings', 'appointment_value', 'purchase_count', 'purchase_value', 'appointment_roas', 'purchase_roas', 'cost_per_purchase'] as const
const LABELS: Record<string, string> = { booked_value: 'Booked value', active_appointments: `Active ${OW.many}`,
  amount_paid: 'Recorded amount paid', paid_bookings: `Paid ${OW.many}`, spend: 'Meta spend', bookings: 'AppointmentConfirmed count',
  appointment_value: 'AppointmentConfirmed value', appointment_roas: 'AppointmentConfirmed ROAS',
  purchase_count: 'Purchase count', purchase_value: 'Purchase value', purchase_roas: 'Purchase ROAS', cost_per_purchase: 'Purchase CPA' }
const ratios: Record<string, readonly [string, string]> = { appointment_roas: ['appointment_value', 'spend'],
  purchase_roas: ['purchase_value', 'spend'], cost_per_purchase: ['spend', 'purchase_count'] }
const close = (a: number, b: number, terms = 1) => Math.abs(a - b) <= Number.EPSILON * Math.max(Math.abs(a), Math.abs(b)) * Math.max(8, terms * 2)
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const canonical = (claim: MetricClaim) => claim.claimId.endsWith(':campaign-canonical')
const sameInputs = (a: string[], b: string[]) => new Set(a).size === a.length && same([...a].sort(), [...b].sort())

function observe(data: ReportingData, source: 'business' | 'meta', ref: ReviewEvidence | null,
  expected: ReportMetric, period: 'current' | 'previous'): Observation | null {
  const metric = ref?.metric, claim = metric?.[period], native = expected[period]
  if (!metric || !claim || !native || metric.key !== expected.key || metric.label !== expected.label
    || metric.definition !== expected.definition || metric.event !== expected.event
    || claim.claimId !== native.claimId || claim.metricKey !== native.metricKey || claim.label !== native.label
    || claim.formula !== native.formula || claim.definitionVersion !== native.definitionVersion || claim.unit !== native.unit
    || !same(claim.entity, native.entity) || !same(claim.source, native.source) || !same(claim.window, native.window)
    || claim.attributionScope !== native.attributionScope || claim.measurementKind !== native.measurementKind
    || !same(claim.authority, native.authority) || claim.setupFingerprint !== native.setupFingerprint
    || period === 'previous' && !same(claim.comparison, native.comparison)
    || claim.measurementKind !== 'derived' && claim.inputClaimIds.length !== 0
    || claim.availability.state !== 'available' || typeof claim.value !== 'number' || !Number.isFinite(claim.value)
    || claim.value < 0 && metric.key !== 'amount_paid'
    || claim.unit === 'count' && !Number.isSafeInteger(claim.value)) return null
  if (canonical(native) && (typeof native.value !== 'number' || !Number.isFinite(native.value)
    || !close(claim.value, native.value, native.inputClaimIds.length)
    || !sameInputs(claim.inputClaimIds, native.inputClaimIds) || !same(claim.coverage, native.coverage))) return null
  try {
    if (!ref.sourceAsOf || compareInstants(claim.asOf, ref.sourceAsOf) !== 0 || compareInstants(claim.asOf, data.context.asOf) > 0
      || !claim.freshness.observedAt || compareInstants(claim.freshness.observedAt, claim.asOf) !== 0) return null
  } catch { return null }
  const qualifications = [claim.coverage.state !== 'complete' ? `${claim.coverage.state} coverage${source === 'business' && ['amount_paid', 'paid_bookings'].includes(metric.key) ? '; observed lower bound' : ''}` : '',
    claim.freshness.state === 'stale' || source === 'meta' && claim.freshness.state !== 'fresh' ? `${claim.freshness.state} freshness` : '',
    ['partial', 'settling'].includes(claim.maturity.state) ? `${claim.maturity.state} period` : '',
    source === 'meta' && ['partial', 'settling'].includes(native.maturity.state) && native.maturity.state !== claim.maturity.state
      ? `${native.maturity.state} native observation window` : '',
    source === 'meta' && claim.maturity.state === 'not_applicable' ? 'unverified outcome maturity' : ''].filter(Boolean)
  return { value: claim.value, claim, eligible: qualifications.length === 0, qualifications }
}

function field(data: ReportingData, source: 'business' | 'meta', key: string, expected: ReportMetric,
  fields: Record<string, PlatformField>, entityIndex?: number): PlatformField {
  const ref = metricEvidence(data, source, entityIndex === undefined ? ['metrics', key] : ['entities', entityIndex, 'metrics', key]), label = LABELS[key]
  const read = (period: 'current' | 'previous') => {
    const native = observe(data, source, ref, expected, period), inputs = ratios[key]
    const mismatch = native && entityIndex !== undefined && !same(native.claim.maturity, expected[period]?.maturity)
    const observed = mismatch ? { ...native, eligible: false, qualifications: [...native.qualifications, 'maturity differs from the native window'] } : native
    if (!observed || !inputs) return observed
    if (key === 'cost_per_purchase' && observed.claim.coverage.state !== 'complete') return null
    const which = period === 'current' ? 'current' : 'prior'
    const a = fields[inputs[0]]?.[which], b = fields[inputs[1]]?.[which]
    if (!a || !b || a.claim.coverage.state !== 'complete' || b.claim.coverage.state !== 'complete' || b.value <= 0
      || !canonical(expected[period]!) && a.claim.source.head !== b.claim.source.head
      || !same(observed.claim.inputClaimIds, [a.claim.claimId, b.claim.claimId])
      || !Number.isFinite(a.value / b.value) || !close(observed.value, a.value / b.value)) return null
    const qualifications = [...new Set([...observed.qualifications, ...a.qualifications, ...b.qualifications])]
    return { ...observed, eligible: qualifications.length === 0, qualifications }
  }
  const current = read('current'), observedPrior = read('previous')
  // A rejected or ineligible prior must not reappear through a full native evidence card.
  const prior = observedPrior && (entityIndex !== undefined || observedPrior.eligible) ? observedPrior : null
  // Entity snapshots may show provisional settling differences; account E1 stays settled-only.
  const eligible = (value: Observation | null) => !!value && (value.eligible || entityIndex !== undefined
    && value.qualifications.length > 0 && value.qualifications.every(reason => reason === 'settling period'))
  const compatibleInputs = key !== 'cost_per_purchase' || ratios[key].every(input => fields[input]?.change !== null)
  const paired = compatibleInputs && eligible(current) && eligible(prior) && same(current!.claim.comparison, expected.current.comparison)
  const change = paired ? close(current!.value, prior!.value) ? 0 : current!.value - prior!.value : null
  const reasons = [!current ? 'current native observation is missing or invalid' : current.qualifications.join('; '),
    !observedPrior ? 'prior native observation is missing or invalid' : observedPrior.qualifications.map(reason => `prior ${reason}`).join('; '),
    !compatibleInputs ? 'native spend and Purchase count lack a compatible prior comparison' : '',
    current && !same(current.claim.comparison, expected.current.comparison) ? 'comparison window does not match the prior equal period' : ''].filter(Boolean)
  return { label, ref: current || prior ? ref : null, current, prior, change,
    limits: change === null ? [`${label} comparison unavailable: ${reasons.join('; ') || 'the required compatible pair is unavailable'}.`]
      : current?.qualifications.length || prior?.qualifications.length ? [`${label} difference is provisional; outcomes are still settling and may be revised.`] : [] }
}

function metaDefinitions(context: ReportingContext, entity?: MetricClaim['entity']): ReportMetricMap {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: context.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(context.asOf))
  const maturity = (prior: boolean, spend: boolean): MetricClaim['maturity'] => {
    const range = prior ? context.comparison : context.range, settle = classifyWindowSettle({ ...range, today })
    return settle.includes_today ? { state: 'partial', matureThrough: null }
      : spend ? { state: 'settled', matureThrough: range.to } : { state: settle.state, matureThrough: settle.settled_through }
  }
  const common = { context, entity, source: 'meta' as const, current: null, previous: null, basis: 'impression_date_et' as const,
    freshness: { state: 'fresh' as const, observedAt: context.asOf, maxAgeHours: 24 } }
  const native = Object.fromEntries(META_NATIVE_METRIC_DEFINITIONS.map(definition => [definition.key, makeReportMetric({
    ...common, ...definition, definition: metaNativeMetricDescription(definition),
    maturity: maturity(false, definition.key === 'spend'), previousMaturity: maturity(true, definition.key === 'spend'),
    attributionScope: definition.event || definition.action || definition.attributed ? 'meta_platform_modelled' : 'none',
    measurementKind: definition.event || definition.action || definition.attributed || ['reach', 'frequency'].includes(definition.key) ? 'modelled' : 'measured',
    sourceHead: `meta-live:${context.account.metaAccountId}:${context.asOf}`,
  })]))
  return { ...native, ...Object.fromEntries(META_RATIO_METRIC_DEFINITIONS.filter(([key]) => key in ratios || key === 'cost_per_booking')
    .map(([key, label, numerator, denominator, scale, unit]) => {
      const a = native[numerator], b = native[denominator]
      return [key, makeReportMetric({ ...common, key, label, unit, event: a.event ?? b.event,
        definition: `${a.label} / ${b.label}${scale !== 1 ? ` × ${scale}` : ''}; matching Meta population and period with complete input coverage.`,
        measurementKind: 'derived', attributionScope: 'meta_platform_modelled', inputMetrics: [a, b],
        maturity: maturity(false, false), previousMaturity: maturity(true, false),
      })]
    })) }
}

/** Validate the existing adapter projection, including its independently observed campaign inputs. */
function canonicalMetaDefinitions(data: ReportingData, context: ReportingContext, native: ReportMetricMap): ReportMetricMap {
  const report = data.meta.data
  const keys = ['bookings', 'appointment_value', 'bookings_click', 'bookings_view']
  if (!report || !keys.some(key => report.metrics[key] && canonical(report.metrics[key].current))) return native
  const campaigns = report.entities.map((entity, index) => ({ entity, index }))
    .filter(row => row.entity.level === 'campaign')
  const unique = new Set(campaigns.map(row => row.entity.id)).size === campaigns.length
  if (!unique) return native
  const definitions = new Map(campaigns.map(({ entity }) => [entity.id, metaDefinitions(context, { level: entity.level, id: entity.id })]))
  const members = (period: 'current' | 'previous') => {
    const supplied = new Set(keys.flatMap(key => report.metrics[key]?.[period]?.inputClaimIds ?? []))
    return campaigns.filter(({ entity }) => Object.values(entity.metrics).some(metric => metric[period]?.availability.state === 'available')
      || keys.some(key => supplied.has(entity.metrics[key]?.[period]?.claimId ?? '')))
  }
  const current = members('current'), previous = members('previous')
  const reads = new Map([['current:campaign', current.map(row => ({ campaign_id: row.entity.id }))],
    ['previous:campaign', previous.map(row => ({ campaign_id: row.entity.id }))]])
  const validInput = (row: typeof campaigns[number], key: string, period: 'current' | 'previous') => {
    const expected = definitions.get(row.entity.id)![key]
    const ref = metricEvidence(data, 'meta', ['entities', row.index, 'metrics', key])
    const observed = observe(data, 'meta', ref, expected, period)
    return !!observed && observed.claim.coverage.state === 'complete' && observed.claim.freshness.state === 'fresh'
      && same(observed.claim.maturity, expected[period]?.maturity)
      && same(observed.claim.comparison, expected[period]?.comparison)
  }
  const cleanCampaigns = campaigns.map(row => ({ ...row.entity, metrics: {
    ...row.entity.metrics, ...Object.fromEntries(keys.map(key => {
      const expected = definitions.get(row.entity.id)![key], actual = row.entity.metrics[key]
      return [key, { ...expected, current: validInput(row, key, 'current') ? actual.current : expected.current,
        previous: validInput(row, key, 'previous') ? actual.previous : expected.previous }]
    })),
  } }))
  const spend = observe(data, 'meta', metricEvidence(data, 'meta', ['metrics', 'spend']), native.spend, 'current')
  const priorSpend = observe(data, 'meta', metricEvidence(data, 'meta', ['metrics', 'spend']), native.spend, 'previous')
  const safeSpend = { ...native.spend, current: spend?.claim ?? native.spend.current, previous: priorSpend?.claim ?? native.spend.previous }
  const projected = projectCampaignAuthority(context, { ...report, entities: cleanCampaigns,
    metrics: { ...native, spend: safeSpend } }, reads).report.metrics
  return { ...native, ...Object.fromEntries([...keys, 'appointment_roas'].map(key => {
    const expected = projected[key], input = key === 'appointment_roas' ? 'appointment_value' : key
    const eligible = (rows: typeof campaigns, period: 'current' | 'previous') => unique && rows.length > 0 && rows.every(row => validInput(row, input, period))
    return [key, { ...expected,
      current: eligible(current, 'current') ? expected.current : { ...expected.current, value: null },
      previous: expected.previous && (eligible(previous, 'previous') ? expected.previous : { ...expected.previous, value: null }),
    }]
  })) }
}

/** Pure canonical projections; no source parser, request or supplied claim rewriting. */
export function businessPlatformFields(data: ReportingData): Record<string, PlatformField> {
  const fields: Record<string, PlatformField> = {}
  const context = (source: 'business' | 'meta') => ({ ...data.context, asOf: data[source].asOf ?? data.context.asOf })
  const meta = canonicalMetaDefinitions(data, context('meta'), metaDefinitions(context('meta')))
  for (const key of BUSINESS_PLATFORM_KEYS) {
    const expected = makeReportMetric({ context: context('business'), source: 'outcomes', current: null, previous: null,
      ...BUSINESS_ACCOUNT_METRIC_DEFINITIONS[key] })
    fields[key] = field(data, 'business', key, expected, fields)
  }
  for (const key of META_PLATFORM_KEYS) fields[key] = field(data, 'meta', key, meta[key], fields)
  return fields
}

/** Exact entity observations, preserving independent periods and explicitly provisional settling differences. */
export function mediaEntityFields(data: ReportingData, index: number): Record<string, PlatformField> {
  const entity = data.meta.data!.entities[index]
  const context = { ...data.context, asOf: data.meta.asOf ?? data.context.asOf }
  const definitions = metaDefinitions(context, { id: entity.id, level: entity.level })
  const fields: Record<string, PlatformField> = {}
  for (const key of META_PLATFORM_KEYS) fields[key] = field(data, 'meta', key, definitions[key], fields, index)
  return fields
}

export function platformEvidencePeriods(fields: PlatformField[]): Record<string, Array<'current' | 'prior'>> {
  return Object.fromEntries(fields.flatMap(field => field.ref ? [[field.ref.id,
    [...(field.current ? ['current' as const] : []), ...(field.prior ? ['prior' as const] : [])]]] : []))
}

export function platformValue(observation: Observation | null): string {
  if (!observation) return 'unavailable'
  const { value, claim, qualifications } = observation
  const formatted = claim.unit === 'money' ? value.toLocaleString(accountLocale(), { style: 'currency', currency: accountCurrency(), maximumFractionDigits: value % 1 ? currencyFractionDigits() : 0 })
    : `${value.toLocaleString('en-US', { maximumFractionDigits: 2 })}${claim.unit === 'ratio' ? '×' : ''}`
  return `${formatted}${qualifications.length ? ` [${qualifications.join('; ')}]` : ''}`
}
export function platformPeriod(field: PlatformField): string {
  return `${field.label}: ${platformValue(field.current)} (prior ${platformValue(field.prior)})`
}
