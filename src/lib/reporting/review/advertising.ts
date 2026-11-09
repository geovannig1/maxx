import { accountCurrency, accountLocale } from '@/config/business-config'
import { deriveMediaMovement } from './media-movement'
import type { ReportEntity, ReportMetric, ReportMetricMap, ReportingData } from '../contracts'
import type { ReviewEvidence, ReviewFinding } from './contracts'
import { comparable, display, metricEvidence, numeric, reportLink, statement, unavailableFinding } from './evidence'
import { outcomeWords } from '@/config/outcome-nouns'

// What this business calls its outcomes (NEXT_PUBLIC_OUTCOME_NOUN).
const OW = outcomeWords()

type Row = { id: string; name: string; level: ReportEntity['level'] | 'account'; metrics: ReportMetricMap; path: (string | number)[] }
const OUTCOMES = ['bookings', 'bookings_click', 'bookings_view'] as const
const LIMITATIONS = [
  'Meta optimizer selection and unequal exposure can change who sees each ad; these rows are not an equal-exposure experiment.',
  'Current configuration cannot establish historical targeting, placements or attribution settings for the selected period.',
  `Meta AppointmentConfirmed estimates use the report’s impression-date window; outcome business ${OW.many} remain a separate population.`,
  'Observed spend and outcomes do not establish the results of transferring budget between ads or ad sets.',
]

export function currentMetric(data: ReportingData, row: Pick<Row, 'id' | 'level' | 'metrics'>, key: string): ReportMetric | null {
  const metric = row.metrics[key], claim = metric?.current
  const event = OUTCOMES.includes(key as typeof OUTCOMES[number]) ? 'AppointmentConfirmed' : null
  if (!claim || !comparable(metric, metric) || numeric(metric)! < 0 || metric.event !== event
    || claim.metricKey !== `meta.${key}` || claim.source.system !== 'meta'
    || claim.source.role !== 'delivery_truth' || claim.source.evidencePlane !== 'meta_delivery'
    || claim.entity.id !== row.id || claim.entity.level !== row.level
    || claim.window.start !== data.context.range.from || claim.window.end !== data.context.range.to
    || claim.window.basis !== 'impression_date_et' || claim.window.timezone !== data.context.timezone
    || claim.unit !== (key === 'spend' ? 'money' : 'count')) return null
  return metric
}

function ref(data: ReportingData, row: Row, key: string): ReviewEvidence | null {
  return currentMetric(data, row, key) ? metricEvidence(data, 'meta', [...row.path, key]) : null
}
function accountRow(data: ReportingData): Row {
  return { id: data.context.account.id, name: 'Meta account', level: 'account', metrics: data.meta.data?.metrics ?? {}, path: ['metrics'] }
}
function link(data: ReportingData, rows: Row[]): string {
  const first = rows[0]
  return reportLink(data, '/performance', { group: 'results', ...(first?.level !== 'account' ? {
    level: first?.level ?? 'ad', ...(rows.length === 2 ? { view: 'compare', compare: rows.map(row => row.id).join(',') }
      : first?.level === 'ad' ? { ad: first.id } : first?.level === 'campaign' ? { campaign: first.id } : first ? { adset: first.id } : {}),
  } : {}) })
}
function exposure(data: ReportingData, rows: Row[]): ReviewFinding['exposure'] {
  const refs = rows.flatMap(row => { const evidence = ref(data, row, 'spend'); return evidence ? [evidence] : [] })
  return refs.length === rows.length && refs.length > 0
    ? { value: refs.reduce((sum, evidence) => sum + numeric(evidence.metric)!, 0), unit: 'money', evidence: refs } : null
}
function period(data: ReportingData): string {
  return `${data.context.range.from}–${data.context.range.to}, ${data.context.timezone}; source as of ${data.meta.asOf ?? 'unknown'}`
}

function outcome(data: ReportingData, row: Row, key: typeof OUTCOMES[number]): ReportMetric | null {
  const metric = currentMetric(data, row, key)
  return metric && Number.isSafeInteger(numeric(metric)) && metric.current.measurementKind === 'modelled'
    && metric.current.attributionScope === 'meta_platform_modelled' ? metric : null
}
function splitMetric(data: ReportingData, row: Row, key: 'bookings_click' | 'bookings_view'): ReportMetric | null {
  const total = outcome(data, row, 'bookings'), split = outcome(data, row, key)
  return total && split && total.current.source.head === split.current.source.head
    && total.current.asOf === split.current.asOf && total.current.setupFingerprint === split.current.setupFingerprint ? split : null
}
function splitRef(data: ReportingData, row: Row, key: typeof OUTCOMES[number]): ReviewEvidence | null {
  return (key === 'bookings' ? outcome(data, row, key) : splitMetric(data, row, key)) ? ref(data, row, key) : null
}
const exactOrder = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0
const rowIdentity = (row: Row): string => JSON.stringify([row.level, row.id])
function attributionRows(data: ReportingData): { rows: Row[]; limits: string[] } {
  if (!data.meta.data || !['available', 'partial'].includes(data.meta.state)) return { rows: [], limits: [] }
  const rows = data.meta.data.entities.map((entity, index): Row => ({ ...entity, path: ['entities', index, 'metrics'] }))
    .filter(row => outcome(data, row, 'bookings'))
  const account = accountRow(data)
  const selected = rows.length ? rows : outcome(data, account, 'bookings') ? [account] : []
  return { rows: selected.sort((a, b) => exactOrder(rowIdentity(a), rowIdentity(b))), limits: [
    'All returned eligible members at each native hierarchy level are reviewed independently; their counts and spend are not summed across hierarchy levels. Coverage of omitted source rows is not established.',
    ...(selected[0]?.level === 'account' ? ['Account-level outcome composition is not assigned to an ad or ad set.'] : []),
  ] }
}
/** Same selected-period definitions only: this signature does not establish historical continuity. */
function metricSignature(metric: ReportMetric): string {
  const claim = metric.current
  return JSON.stringify([metric.event, claim.metricKey, claim.unit, claim.formula, claim.definitionVersion,
    claim.source.system, claim.source.role, claim.source.evidencePlane, claim.source.head, claim.asOf,
    claim.entity.level, claim.window.start, claim.window.end, claim.window.basis, claim.window.timezone,
    claim.attributionScope, claim.measurementKind, claim.setupFingerprint])
}
type Member = { row: Row; total: number; click: number; signature: string }
type Composition = { witnesses: Map<string, Row>; compared: Set<string>; groups: Map<Row['level'], number> }
function composition(data: ReportingData, rows: Row[]): Composition {
  const members: Member[] = rows.flatMap(row => {
    const total = outcome(data, row, 'bookings')!, click = splitMetric(data, row, 'bookings_click')
    if (!click) return []
    const signature = JSON.stringify([metricSignature(total), metricSignature(click)])
    return [{ row, total: numeric(total)!, click: numeric(click)!, signature }]
  }).sort((a, b) => exactOrder(a.signature, b.signature) || a.total - b.total || exactOrder(a.row.id, b.row.id))
  const witnesses = new Map<string, Row>(), compared = new Set<string>()
  const remember = (member: Member, other: Member) => {
    const identity = rowIdentity(member.row), existing = witnesses.get(identity)
    const spend = (row: Row) => numeric(currentMetric(data, row, 'spend')) ?? -1
    if (!existing || spend(other.row) > spend(existing) || (spend(other.row) === spend(existing) && other.row.id < existing.id)) {
      witnesses.set(identity, other.row)
    }
  }
  const groups = new Map<Row['level'], number>()
  for (let groupStart = 0; groupStart < members.length;) {
    let groupEnd = groupStart + 1
    while (groupEnd < members.length && members[groupEnd].signature === members[groupStart].signature) groupEnd++
    const sorted = members.slice(groupStart, groupEnd)
    groupStart = groupEnd
    const level = sorted[0].row.level
    groups.set(level, (groups.get(level) ?? 0) + 1)
    if (sorted.length < 2) continue
    sorted.forEach(member => compared.add(rowIdentity(member.row)))
    // Query equal-total batches before advancing the extreme: ties never become reversals.
    for (const ascending of [true, false]) {
      const ordered = ascending ? sorted : [...sorted].reverse()
      let extreme: Member | undefined
      for (let start = 0; start < ordered.length;) {
        let end = start + 1
        while (end < ordered.length && ordered[end].total === ordered[start].total) end++
        for (let index = start; index < end; index++) {
          const member = ordered[index]
          if (extreme && (ascending ? extreme.click > member.click : extreme.click < member.click)) remember(member, extreme)
        }
        for (let index = start; index < end; index++) {
          const member = ordered[index]
          if (!extreme || (ascending ? member.click > extreme.click : member.click < extreme.click)
            || (member.click === extreme.click && member.row.id < extreme.row.id)) extreme = member
        }
        start = end
      }
    }
  }
  return { witnesses, compared, groups }
}
function compositionExposure(data: ReportingData, rows: Row[]): ReviewFinding['exposure'] {
  const metrics = rows.map(row => currentMetric(data, row, 'spend'))
  if (!metrics.length || metrics.some((metric, index) => !metric || !comparable(metrics[0], metric)
    || metric.current.measurementKind !== 'measured' || metric.current.attributionScope !== 'none'
    || metric.current.source.head !== outcome(data, rows[index], 'bookings')?.current.source.head
    || metric.current.asOf !== outcome(data, rows[index], 'bookings')?.current.asOf
    || metricSignature(metric) !== metricSignature(metrics[0]!))) return null
  const affected = exposure(data, rows)
  return affected && Number.isFinite(affected.value) ? affected : null
}
function compositionText(data: ReportingData, rows: Row[]): string {
  return `${rows.map(row => `${row.name}: ${display(outcome(data, row, 'bookings'))} total`).join('; ')}. ${rows.map(row =>
    `${row.name}: click-attributed ${display(splitMetric(data, row, 'bookings_click'))}; view-attributed ${display(splitMetric(data, row, 'bookings_view'))}`).join('. ')}.`
}
function attributionFinding(data: ReportingData, input: {
  id: string; rows: Row[]; evidenceRows?: Row[]; observation: string; counter?: string; reversed: boolean; compared: boolean; limits: string[]; entity?: Row
}): ReviewFinding {
  const refs = (input.evidenceRows ?? input.rows).flatMap(row => OUTCOMES.map(key => splitRef(data, row, key)))
  const affected = compositionExposure(data, input.entity ? [input.entity] : input.rows)
  const complete = (input.evidenceRows ?? input.rows).every(row => splitMetric(data, row, 'bookings_click') && splitMetric(data, row, 'bookings_view'))
  return {
    id: input.id, area: 'advertising', title: input.entity ? `${input.entity.name}: click and view attribution` : 'Click and view attribution',
    ...(input.entity && input.entity.level !== 'account' ? { entity: { id: input.entity.id, name: input.entity.name, level: input.entity.level } } : {}),
    status: input.reversed || !complete || !input.compared ? 'mixed' : 'observed',
    priority: input.reversed ? 'investigate' : 'context', ...(input.reversed ? { direction: 'mixed' as const } : {}),
    observation: statement(`Meta AppointmentConfirmed report fields: ${input.observation} ${period(data)}.`, ...refs),
    materiality: { ...statement(affected ? `${affected.value.toLocaleString(accountLocale(), { style: 'currency', currency: accountCurrency() })} measured spend accompanies ${input.entity ? 'this member' : 'the displayed example'}; this is not total affected or recoverable spend.`
      : 'These reported event counts remain inspectable; matching comparable measured spend is unavailable.', ...(affected?.evidence ?? [])),
      priorityReason: input.reversed ? 'The ordering changes on the same reported event; measured exposure gives its scale without estimating a budget-transfer return.'
        : 'Composition alone does not supply a performance target or grounds for intervention.' },
    explanations: input.reversed ? [{ hypothesis: 'The reported attribution composition accounts for this difference between total and click-attributed ordering; its business cause is not established.',
      evidence: refs.filter((evidence): evidence is ReviewEvidence => !!evidence),
      missing: ['Effective historical attribution definitions and independently matched conversion populations.', 'A causal comparison at equivalent exposure.'] }] : [],
    counterEvidence: statement(`${input.counter ?? ''}Click-attributed outcomes remain Meta estimates, not incremental ${OW.many} or independently joined outcome records. Missing split fields stay unknown; no remainder is calculated. A higher click share is not a trust score.`, ...refs),
    nextInspection: { question: 'Optional: inspect these exact native fields and their attribution definitions; the supported ordering is already stated above.', href: link(data, input.rows), outcomes: [
      { result: 'The supplied total and click-attributed ordering reverse with compatible definitions.', interpretation: 'Retain both orderings; total attributed count alone does not establish the stronger independent business response.' },
      { result: 'Compatible orderings agree, or a required split or definition is unavailable.', interpretation: 'Agreement alone does not justify intervention; unavailable fields leave the affected comparison unresolved.' },
    ] }, limitations: [...LIMITATIONS, ...input.limits,
      'These are the reporting adapter’s attribution-composition fields, not independently observed conversion populations; raw-bin independence is not established.',
      'Historical attribution-definition continuity, including whether Meta’s 2026 definition rollout applied to this account, is unverified. Matching current columns do not establish it.',
    ], exposure: affected, authority: { state: 'diagnostic', executable: false },
  }
}
function attribution(data: ReportingData): ReviewFinding[] {
  const { rows, limits } = attributionRows(data)
  if (!rows.length) return [unavailableFinding(data, { id: 'advertising.attribution', area: 'advertising',
    title: 'Click and view attribution', reason: 'AppointmentConfirmed totals and their click/view composition cannot be assessed from the returned Meta fields. Purchase metrics do not substitute for this event.', href: '/performance' })]
  const { witnesses, compared, groups } = composition(data, rows)
  const pairs = rows.flatMap(row => { const witness = witnesses.get(rowIdentity(row)); return witness ? [[row, witness].sort((a, b) => exactOrder(a.id, b.id))] : [] })
    .map(members => ({ members, spend: compositionExposure(data, members)?.value ?? -1, key: JSON.stringify(members.map(rowIdentity)) }))
    .sort((a, b) => b.spend - a.spend || exactOrder(a.key, b.key))
  const example = pairs[0]?.members ?? (rows.length === 1 ? rows : [])
  const comparedCount = compared.size
  const populations = (['campaign', 'adset', 'ad', 'account'] as const).flatMap(level => {
    const members = rows.filter(row => row.level === level)
    return members.length ? [{ level: level === 'adset' ? 'ad-set' : level, eligible: members.length,
      compared: members.filter(row => compared.has(rowIdentity(row))).length,
      reversed: members.filter(row => witnesses.has(rowIdentity(row))).length, groups: groups.get(level) ?? 0 }] : []
  })
  const overview = populations.map(population => `${population.eligible} eligible native ${population.level} populations reviewed independently; ${population.compared} have a compatible total/click peer across ${population.groups} definition groups; ${population.reversed} reversal members. ${population.eligible - population.compared} lack a usable split or compatible peer.`).join(' ') + ' '
    + (witnesses.size ? `One qualifying same-level example: ${compositionText(data, example)} Total and click-attributed ${OW.many} reverse the ordering of these rows.`
      : `${example.length ? `${compositionText(data, example)} ` : ''}${comparedCount ? 'No total-versus-click ordering reversal is present among compatible peers; this composition evidence does not justify intervention.' : 'A cross-entity ordering comparison is unavailable.'}`)
  const summary = attributionFinding(data, { id: 'advertising.attribution', rows: example, evidenceRows: rows, observation: overview,
    counter: populations.map(population => `${population.level}: ${population.compared - population.reversed} compatible members have no total-versus-click reversal in this returned population.`).join(' ') + ' This does not establish an approved performance target. ',
    reversed: witnesses.size > 0, compared: comparedCount === rows.length,
    limits: [...limits, ...([...groups.values()].some(count => count > 1) ? ['Members in different definition groups are not compared against each other.'] : [])] })
  // Without an example, the summary opens the whole native level rather than selecting an arbitrary row.
  const scopedSummary = example.length ? summary : { ...summary, nextInspection: { ...summary.nextInspection,
    href: reportLink(data, '/performance', { group: 'results', level: rows[0].level }) } }
  return [scopedSummary, ...rows.filter(row => row.level !== 'account').map(row => {
    const identity = rowIdentity(row), witness = witnesses.get(identity), members = witness ? [row, witness] : [row]
    const conclusion = witness ? ` Total and click-attributed ${OW.many} reverse the ordering of these rows.`
      : compared.has(identity) ? ' No total-versus-click ordering reversal involves this member among compatible peers; composition alone does not justify intervention.'
        : ' A compatible total/click peer is unavailable; this comparison remains unresolved.'
    return attributionFinding(data, { id: `advertising.attribution:${row.level}:${row.id}`, rows: members, entity: row,
      observation: compositionText(data, members) + conclusion, reversed: !!witness, compared: compared.has(identity), limits })
  })]
}

export function deriveAdvertisingReview(data: ReportingData): ReviewFinding[] {
  return [deriveMediaMovement(data), ...attribution(data)]
}
