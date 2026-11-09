import { formatMoneyTrim } from '@/lib/utils/format-currency'
import { ReportMetricSchema, type ReportMetric, type ReportingData, type ReportingSectionName } from '../contracts'
import type { ReviewAudienceEvidence, ReviewBudgetEvidence, ReviewEvidence, ReviewFinding, ReviewStatement } from './contracts'
import { matchingObservationSections } from './observation'
import { ReportAudienceEvidenceSchema, validateReportAudienceEvidence } from '../audience-evidence'
import { ReportBudgetEvidenceSchema, validateReportBudgetEvidence } from '../budget-evidence'
import { websiteRowAnchor, websiteEventAnchor } from '../website-identity'
import { outcomeWords } from '@/config/outcome-nouns'

// What this business calls its outcomes (NEXT_PUBLIC_OUTCOME_NOUN).
const OW = outcomeWords()

function atPath(root: unknown, path: readonly (string | number)[]): unknown {
  let value = root
  for (const part of path) {
    if (['__proto__', 'constructor', 'prototype'].includes(String(part)) || value === null || typeof value !== 'object'
      || !Object.prototype.hasOwnProperty.call(value, part)) return undefined
    value = (value as Record<string | number, unknown>)[part]
  }
  return value
}
const escapePointer = (part: string | number) => String(part).replaceAll('~', '~0').replaceAll('/', '~1')

function populationLabel(data: ReportingData, source: ReportingSectionName, path: readonly (string | number)[], metric: ReportMetric): string {
  const parent = atPath(data[source]?.data, path.slice(0, -2)) as Record<string, unknown> | undefined
  if (source === 'meta' && path[0] === 'entities' && typeof parent?.name === 'string') return `${metric.current.entity.level}: ${parent.name}`
  if (source === 'business' && path[0] === 'types' && typeof parent?.name === 'string') return `${OW.One} type: ${parent.name}`
  if (source === 'website' && ['rows', 'events'].includes(String(path[0])) && parent) {
    return [path[0] === 'rows' ? parent.landingPage : parent.name, parent.device, parent.channel].filter(value => typeof value === 'string').join(' · ')
  }
  return `${data.context.account.name ?? data.context.account.id} · ${source === 'measurement'
    ? path[0] === 'capi' ? 'Confirmation delivery cohort' : `Paid ${OW.one} association cohort`
    : source === 'business' ? `All-source ${OW.one} cohort` : 'Account totals'}`
}

export function metricEvidence(data: ReportingData, source: ReportingSectionName, path: readonly (string | number)[]): ReviewEvidence | null {
  const section = data[source]
  if (!section?.data || !['available', 'partial'].includes(section.state)) return null
  const parsed = ReportMetricSchema.safeParse(atPath(section.data, path))
  if (!parsed.success) return null
  const pointer = `/${source}/data/${path.map(escapePointer).join('/')}`
  return { id: pointer, source, path: pointer, sourceAsOf: section.asOf,
    populationLabel: populationLabel(data, source, path, parsed.data), metric: parsed.data }
}

export function numeric(metric?: ReportMetric | null, prior = false): number | null {
  const claim = prior ? metric?.previous : metric?.current
  return claim?.availability.state === 'available' && typeof claim.value === 'number' && Number.isFinite(claim.value) ? claim.value : null
}

export function audienceConfigurationEvidence(data: ReportingData, index: number): ReviewAudienceEvidence | null {
  const entity = data.meta?.data?.entities[index]
  if (!entity || entity.level !== 'adset' || !['available', 'partial'].includes(data.meta.state)) return null
  const parsed = ReportAudienceEvidenceSchema.safeParse(entity.audienceEvidence)
  if (!parsed.success) return null
  try { validateReportAudienceEvidence(parsed.data, data.context, entity.id, entity.configurationAsOf) } catch { return null }
  return { source: 'meta', path: `/meta/data/entities/${index}/audienceEvidence`, sourceAsOf: data.meta.asOf,
    populationLabel: `Ad set: ${entity.name} · ${entity.id}`, value: parsed.data }
}
export function budgetConfigurationEvidence(data: ReportingData, index: number): ReviewBudgetEvidence | null {
  const entity = data.meta?.data?.entities[index]
  if (!entity || entity.level === 'ad' || !['available', 'partial'].includes(data.meta.state)) return null
  const parsed = ReportBudgetEvidenceSchema.safeParse(entity.budgetEvidence)
  if (!parsed.success) return null
  try { validateReportBudgetEvidence(parsed.data, data.context, entity) } catch { return null }
  return { source: 'meta', path: `/meta/data/entities/${index}/budgetEvidence`, sourceAsOf: data.meta.asOf,
    populationLabel: `${entity.level === 'campaign' ? 'Campaign' : 'Ad set'}: ${entity.name} · ${entity.id}`, value: parsed.data }
}
export function display(metric?: ReportMetric | null, prior = false): string {
  const value = numeric(metric, prior)
  if (value === null) return 'unavailable'
  const unit = (prior ? metric?.previous : metric?.current)?.unit
  const suffix = unit === 'percent' ? '%' : unit === 'ratio' ? '×' : unit === 'seconds' ? ' seconds' : unit === 'days' ? ' days' : unit === 'hours' ? ' hours' : ''
  return `${unit === 'money' ? formatMoneyTrim(value) : value.toLocaleString('en-US', { maximumFractionDigits: 2 })}${suffix}`
}

/** Eligibility for describing an observed contrast; never a causal or significance test. */
export function comparable(a?: ReportMetric | null, b?: ReportMetric | null, prior = false): boolean {
  const x = a?.current, y = prior ? b?.previous : b?.current
  if (!x || !y || numeric(a) === null || numeric(b, prior) === null) return false
  if ([x, y].some(claim => claim.coverage.state !== 'complete' || claim.freshness.state === 'stale' || claim.maturity.state === 'partial')) return false
  return a?.event === b?.event && x.metricKey === y.metricKey && x.unit === y.unit && x.definitionVersion === y.definitionVersion
    && x.formula === y.formula && x.measurementKind === y.measurementKind && x.source.system === y.source.system
    && x.source.evidencePlane === y.source.evidencePlane && x.source.role === y.source.role
    && x.attributionScope === y.attributionScope && x.window.basis === y.window.basis && x.window.timezone === y.window.timezone
    && x.entity.level === y.entity.level
    && (prior ? x.entity.id === y.entity.id && x.comparison.method === 'prior_equal_period'
      && x.comparison.window?.start === y.window.start && x.comparison.window?.end === y.window.end
      && x.comparison.window?.basis === y.window.basis
      : x.window.start === y.window.start && x.window.end === y.window.end)
}
export function delta(metric?: ReportMetric | null): number | null {
  return comparable(metric, metric, true) ? numeric(metric)! - numeric(metric, true)! : null
}
export function statement(text: string, ...refs: Array<ReviewEvidence | null | undefined>): ReviewStatement {
  const evidence = refs.filter((ref): ref is ReviewEvidence => !!ref)
  return { text, evidence: [...new Map(evidence.map(ref => [ref.id, ref])).values()] }
}
export function reportLink(data: Pick<ReportingData, 'context'>, path: string, filters: Record<string, string> = {}): string {
  return `${path}?${new URLSearchParams({ ...filters, from: data.context.range.from, to: data.context.range.to })}`
}
export function unavailableFinding(data: ReportingData, input: {
  id: string; area: ReviewFinding['area']; title: string; reason: string; href: string
}): ReviewFinding {
  return {
    id: input.id, area: input.area, title: input.title, status: 'unavailable', observation: statement(input.reason),
    materiality: { ...statement('The affected amount or population cannot be established from this evidence.'), priorityReason: 'Unavailable evidence follows usable observations.' },
    explanations: [], counterEvidence: statement('Missing evidence cannot establish a good or bad result.'),
    nextInspection: { question: 'Which required evidence is missing for this check?', href: reportLink(data, input.href), outcomes: [
      { result: 'The scoped source supplies the missing evidence.', interpretation: 'Reassess this question using the returned measurements.' },
      { result: 'The source still cannot supply it.', interpretation: 'Keep this conclusion unavailable; other source observations remain usable.' },
    ] }, limitations: [input.reason], exposure: null, authority: { state: 'diagnostic', executable: false },
  }
}
export function findingEvidence(finding: ReviewFinding): ReviewEvidence[] {
  return [...new Map([
    ...finding.observation.evidence, ...finding.materiality.evidence, ...finding.counterEvidence.evidence,
    ...finding.explanations.flatMap(item => item.evidence), ...(finding.exposure?.evidence ?? []),
  ].map(ref => [ref.id, ref])).values()]
}

/** Compare content, not an ID whose source value can change on the next retrieval. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`
  return JSON.stringify(value)
}
export function verifyFindingReferences(data: ReportingData, finding: ReviewFinding): void {
  if (finding.observation.sections !== undefined && !matchingObservationSections(finding.observation)) {
    throw new Error('Review presentation does not preserve the original observation.')
  }
  // Check every occurrence before deduplication, including conflicting reuse of an ID.
  const refs = [...finding.observation.evidence, ...finding.materiality.evidence, ...finding.counterEvidence.evidence,
    ...finding.explanations.flatMap(item => item.evidence), ...(finding.exposure?.evidence ?? [])]
  for (const ref of refs) {
    const parts = ref.path.split('/').slice(1).map(part => part.replaceAll('~1', '/').replaceAll('~0', '~'))
    const expected = parts[0] === ref.source && parts[1] === 'data' ? metricEvidence(data, ref.source, parts.slice(2)) : null
    if (!expected || canonical(expected) !== canonical(ref)) throw new Error('Review evidence does not match the supplied report.')
  }
  const url = new URL(finding.nextInspection.href, 'https://maxx.local')
  for (const ref of finding.configurationEvidence ?? []) {
    const index = /^\/meta\/data\/entities\/(\d+)\/audienceEvidence$/.exec(ref.path)?.[1]
    const expected = index === undefined ? null : audienceConfigurationEvidence(data, Number(index))
    if (!expected || canonical(expected) !== canonical(ref) || finding.area !== 'audience'
      || finding.entity?.level !== 'adset' || finding.entity.id !== ref.value.adsetId
      || url.pathname !== '/reports' || url.searchParams.get('report') !== 'audience'
      || url.hash !== `#audience-adset-${encodeURIComponent(ref.value.adsetId)}`) {
      throw new Error('Review configuration evidence or inspection does not match the supplied report.')
    }
  }
  const budgetRefs = finding.budgetEvidence ?? []
  for (const ref of budgetRefs) {
    const index = /^\/meta\/data\/entities\/(\d+)\/budgetEvidence$/.exec(ref.path)?.[1]
    const expected = index === undefined ? null : budgetConfigurationEvidence(data, Number(index))
    const ownEntity = finding.entity && ref.value.entity.level === finding.entity.level && ref.value.entity.id === finding.entity.id
    const parentEntity = finding.entity?.level === 'adset' && ref.value.entity.level === 'campaign'
      && ref.value.entity.id === data.meta.data?.entities.find(entity => entity.level === 'adset' && entity.id === finding.entity?.id)?.campaignId
    if (!expected || canonical(expected) !== canonical(ref) || finding.area !== 'advertising'
      || !finding.entity || finding.entity.level === 'ad' || (!ownEntity && !parentEntity)) {
      throw new Error('Review budget evidence does not match the supplied report.')
    }
  }
  if (budgetRefs.length > 2 || new Set(budgetRefs.map(ref => ref.path)).size !== budgetRefs.length
    || (budgetRefs.length && (url.pathname !== '/performance' || url.searchParams.get('view') !== 'detail'
      || url.searchParams.get('level') !== finding.entity?.level
      || url.searchParams.get(finding.entity?.level ?? '') !== finding.entity?.id))) {
    throw new Error('Review budget evidence or inspection does not match the supplied entity.')
  }
  if (url.origin !== 'https://maxx.local' || !['/performance', '/creative', '/reports'].includes(url.pathname)
    || url.searchParams.get('from') !== data.context.range.from || url.searchParams.get('to') !== data.context.range.to) {
    throw new Error('Review inspection does not match the supplied report scope.')
  }
  const websiteFilters = ['website_page', 'website_device', 'website_channel', 'website_event']
  const reportKeys = ['from', 'to', 'report', ...(url.searchParams.get('report') === 'website' ? websiteFilters : [])]
  if (url.pathname === '/reports' && ([...url.searchParams.keys()].some(key => !reportKeys.includes(key))
    || (url.searchParams.has('report') && !['results', 'business', 'creative', 'website', 'audience'].includes(url.searchParams.get('report')!)))) {
    throw new Error('Review inspection uses an unsupported report selection.')
  }
  if (url.pathname === '/reports' && url.searchParams.get('report') === 'website') {
    const populations = refs.flatMap(ref => {
      const match = /^\/website\/data\/(rows|events)\/(\d+)\/metrics\//.exec(ref.path)
      if (!match) return []
      const kind = match[1] as 'rows' | 'events', row = data.website.data?.[kind][Number(match[2])]
      return row ? [{ kind, row }] : []
    })
    const selected = websiteFilters.filter(key => url.searchParams.has(key))
    const field = { website_page: 'landingPage', website_device: 'device', website_channel: 'channel', website_event: 'name' } as const
    if (selected.length && (!populations.length || populations.some(({ row }) => selected.some(key =>
      (row as unknown as Record<string, unknown>)[field[key as keyof typeof field]] !== url.searchParams.get(key))))) {
      throw new Error('Website inspection filters do not match the measured rows.')
    }
    if (url.hash.startsWith('#website-') && !['#website-pages', '#website-events'].includes(url.hash)
      && !populations.some(({ kind, row }) => url.hash === `#${kind === 'rows'
        ? websiteRowAnchor(row as Parameters<typeof websiteRowAnchor>[0]) : websiteEventAnchor(row as Parameters<typeof websiteEventAnchor>[0])}`)) {
      throw new Error('Website inspection anchor does not match the measured row.')
    }
  }
  if (finding.authority.state !== 'diagnostic' || finding.authority.executable !== false
    || (finding.status !== 'unavailable' && finding.area !== 'coverage' && finding.observation.evidence.length === 0 && !finding.configurationEvidence?.length && !finding.budgetEvidence?.length)
    || (finding.exposure && (!Number.isFinite(finding.exposure.value) || finding.exposure.value < 0 || !finding.exposure.evidence.length))) {
    throw new Error('Invalid diagnostic review authority or evidence.')
  }
  if (finding.exposure) verifyExposure(finding.exposure)
}

function verifyExposure(exposure: NonNullable<ReviewFinding['exposure']>): void {
  const refs = exposure.evidence
  const expectedUnit = exposure.unit === 'money' ? 'money' : 'count'
  const additive = ['spend', 'amount_paid', 'booked_value', 'sessions', 'impressions', 'active_appointments', 'paid_bookings',
    'value_bearing_bookings', 'eligible_website_confirmations', 'event_count', 'linked_value_bearing_bookings']
  if (!refs.length || new Set(refs.map(ref => ref.id)).size !== refs.length
    || refs.some(ref => ref.metric.current.unit !== expectedUnit || numeric(ref.metric) === null || numeric(ref.metric)! < 0)
    || (exposure.unit === 'sessions' && refs.some(ref => ref.metric.key !== 'sessions'))
    || (refs.length > 1 && (refs.some(ref => !additive.includes(ref.metric.key) || !comparable(refs[0].metric, ref.metric))
      || !exposureFamily(refs[0]) || refs.some(ref => exposureFamily(ref) !== exposureFamily(refs[0]))
      || new Set(refs.map(ref => ref.metric.current.entity.id)).size !== refs.length))) {
    throw new Error('Review exposure does not have compatible additive inputs.')
  }
  const total = refs.reduce((sum, ref) => sum + numeric(ref.metric)!, 0)
  if (Math.abs(total - exposure.value) > Number.EPSILON * Math.max(1, Math.abs(total)) * refs.length * 4) {
    throw new Error('Review exposure does not match its measured inputs.')
  }
}

function exposureFamily(ref: ReviewEvidence): string | null {
  const parts = ref.path.split('/').slice(1)
  const family = `${parts[0]}:${parts[2]}`
  return parts.length === 6 && parts[4] === 'metrics' && ['meta:entities', 'business:types', 'website:rows'].includes(family) ? family : null
}

export function evidenceLimitations(finding: ReviewFinding): string[] {
  const claims = findingEvidence(finding).flatMap(ref => [ref.metric.current, ...(ref.metric.previous ? [ref.metric.previous] : [])])
  return [
    claims.some(c => c.coverage.state === 'partial') ? 'Some observations have partial coverage; recorded amounts and counts can be incomplete.' : '',
    claims.some(c => c.coverage.state === 'unknown') ? 'Coverage is unverified for some observations.' : '',
    claims.some(c => c.freshness.state === 'stale') ? 'Some source evidence is stale.' : '',
    claims.some(c => c.freshness.state === 'unknown') ? 'Source freshness is unverified for some observations.' : '',
    claims.some(c => c.maturity.state === 'settling') ? 'Recent attributed outcomes are settling and may be revised.' : '',
    claims.some(c => c.maturity.state === 'partial') ? 'Some observations cover a partial period.' : '',
  ].filter(Boolean)
}
