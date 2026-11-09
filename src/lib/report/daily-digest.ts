import { formatMoney } from '@/lib/utils/format-currency'
import type { ExecutiveEvidenceSnapshotV1 } from '@/lib/report/executive-evidence'
import {
  RATE_THRESHOLD_PCT,
  deriveDigestDescriptiveStates,
  gateCountDelta,
  gateRateDelta,
  unclassifiedSpendContextLines,
  type DeltaState,
  type DigestDescriptiveStates,
  type GatedDelta,
  type PacingBand,
  type StoplightStatus,
} from './daily-digest-signals'
import { buildDeterministicDigestNarrative, type DeterministicDigestNarrative } from './digest-narrative'
import { outcomeWords } from '@/config/outcome-nouns'

// What this business calls its outcomes (NEXT_PUBLIC_OUTCOME_NOUN).
const OW = outcomeWords()

type DigestPlanes = {
  spend: number | null
  leads: number | null
  bookings: number | null
  ctr: number | null
  cpl: number | null
  bookingsReal?: number | null
}

export interface DailyDigestInput {
  reportDate: string
  accountName: string
  today: DigestPlanes
  sevenDayDailyAverage: DigestPlanes | null
  dailyBudgetTarget: number | null
  executiveEvidence: ExecutiveEvidenceSnapshotV1
}

interface DailyDigestEnvelope {
  report_date: string
  generated_from: 'committed_report_facts'
  action_authority_tier: 'diagnostic_only'
  prescriptions: []
  change_reporting_threshold_pct: 20
  subject: string
  markdown: string
}

export interface DailyDigest extends DailyDigestEnvelope { contract_version: 1 }
export type DailyDigestKpiKey = 'spend' | 'leads' | 'bookings_real' | 'bookings_meta' | 'ctr' | 'cpl'
export type DailyDigestKpiUnit = 'money' | 'count' | 'pct'

export interface DailyDigestKpi {
  key: DailyDigestKpiKey
  label: string
  value: number | null
  unit: DailyDigestKpiUnit
  delta_pct: number | null
  noise_gated: boolean
  state: DeltaState
}

export interface DailyDigestV2 extends DailyDigestEnvelope {
  contract_version: 2
  account_name: string
  verdict: { status: StoplightStatus; line: string }
  pacing: { spend: number | null; target: number | null; band: PacingBand }
  kpis: DailyDigestKpi[]
  flags: string[]
  creative: string[]
  decisions: string[]
  narrative: { text: string; source: 'llm' | 'deterministic_fallback' }
}

export interface DailyDigestV3 extends DailyDigestEnvelope {
  contract_version: 3
  account_name: string
  states: DigestDescriptiveStates
  pacing: { spend: number | null; target: number | null; band: PacingBand }
  kpis: DailyDigestKpi[]
  flags: string[]
  creative: string[]
  decisions: string[]
  narrative: DeterministicDigestNarrative
  evidence_snapshot: {
    contract: 'executive_evidence_snapshot'
    version: 1
    generated_at: string
    as_of: string
    last_complete_date: string
  }
}

function section(title: string, lines: string[]): string {
  return `## ${title}\n${lines.join('\n')}`
}
function bulleted(lines: string[]): string[] {
  return lines.map((line) => `- ${line}`)
}
function finiteOrNull(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}
function buildKpis(input: DailyDigestInput): DailyDigestKpi[] {
  const baseline = input.sevenDayDailyAverage
  const rows: Array<{
    key: DailyDigestKpiKey
    label: string
    unit: DailyDigestKpiUnit
    value: number | null
    prior: number | null
    gate: (current: number | null, baseline: number | null) => GatedDelta
  }> = [
    { key: 'spend', label: 'Amount Spent', unit: 'money', value: finiteOrNull(input.today.spend), prior: finiteOrNull(baseline?.spend), gate: gateRateDelta },
    { key: 'leads', label: 'Leads', unit: 'count', value: finiteOrNull(input.today.leads), prior: finiteOrNull(baseline?.leads), gate: gateCountDelta },
    { key: 'bookings_real', label: `Value-bearing ${OW.many} (outcome ledger)`, unit: 'count', value: finiteOrNull(input.today.bookingsReal), prior: finiteOrNull(baseline?.bookingsReal), gate: gateCountDelta },
    { key: 'bookings_meta', label: `Meta-modelled ${OW.many}`, unit: 'count', value: finiteOrNull(input.today.bookings), prior: finiteOrNull(baseline?.bookings), gate: gateCountDelta },
    { key: 'ctr', label: 'Link CTR (Meta)', unit: 'pct', value: finiteOrNull(input.today.ctr), prior: finiteOrNull(baseline?.ctr), gate: gateRateDelta },
    { key: 'cpl', label: 'Cost per lead', unit: 'money', value: finiteOrNull(input.today.cpl), prior: finiteOrNull(baseline?.cpl), gate: gateRateDelta },
  ]
  return rows.map(({ gate, prior, ...row }) => ({ ...row, ...gate(row.value, prior) }))
}

export function formatKpiValue(kpi: DailyDigestKpi): string {
  if (kpi.value === null) return 'unavailable'
  if (kpi.unit === 'money') return formatMoney(kpi.value)
  if (kpi.unit === 'pct') return `${kpi.value.toFixed(2)}%`
  return `${kpi.value}`
}

function formatDelta(kpi: DailyDigestKpi): string {
  if (kpi.state === 'no_baseline' || kpi.delta_pct === null) {
    return 'no comparable prior seven-day daily average'
  }
  const signed = `${kpi.delta_pct > 0 ? '+' : ''}${kpi.delta_pct.toFixed(1)}%`
  const versus = `${signed} versus the prior seven-day daily average`
  return kpi.state === 'within_noise' ? `${versus} — within noise` : versus
}

function kpiLines(kpis: DailyDigestKpi[]): string[] {
  return kpis.map((kpi) => `- ${kpi.label}: ${formatKpiValue(kpi)} — ${formatDelta(kpi)}.`)
}

const SOURCE_LABELS: Record<keyof ExecutiveEvidenceSnapshotV1['sources'], string> = {
  setupChanges: 'Setup history',
  outcomes: 'Outcomes',
  meta: 'Meta',
  metaColdWarm: 'Cold/Warm Meta breakdown',
  metaPlacements: 'Meta placement breakdown',
  tracking: 'Paid-touch tracking',
  capi: 'CAPI',
  gaIdentity: `GA ${OW.one} identity`,
  paidCohort: 'Paid cohort',
}

function evidenceFlags(evidence: ExecutiveEvidenceSnapshotV1 | null): string[] {
  if (!evidence) return ['Executive evidence snapshot unavailable; no setup or tracking status is inferred.']
  const lines = Object.entries(evidence.sources).flatMap(([key, source]) => {
    if (source.availability === 'available' && source.blockerCodes.length === 0) return []
    const blockers = source.blockerCodes.length > 0 ? source.blockerCodes.join(', ') : 'no source head'
    return [`${SOURCE_LABELS[key as keyof typeof SOURCE_LABELS]}: ${source.availability}; blockers: ${blockers}.`]
  })
  const change = evidence.setupChanges?.latest_material_change
  if (change?.status === 'known') {
    lines.push(`Latest material change at ${change.occurredAt}: ${change.reason}`)
  } else if (change?.status === 'unknown') {
    lines.push(`Latest material-change reason unavailable: ${change.reasonCode}.`)
  }
  return lines
}

function evidenceCreativeLines(evidence: ExecutiveEvidenceSnapshotV1 | null): string[] {
  const setup = evidence?.setupChanges
  if (!setup) return ['Creative setup unavailable in the committed executive evidence.']
  const reuse = setup.creative_reuse
  const mediaText = reuse.distinct_active_media === null
    ? 'distinct observed media unavailable'
    : `${reuse.distinct_active_media} distinct observed media`
  const lines = [
    `${reuse.distinct_active_ad_wrappers} active ad wrappers; ${mediaText}; ${reuse.concept_coverage_complete ? `${reuse.distinct_known_concepts ?? 0} known concepts` : 'concept coverage unavailable'}.`,
  ]
  for (const wrapper of [...setup.active_ad_wrappers]
    .sort((left, right) => left.meta_ad_id.localeCompare(right.meta_ad_id))
    .slice(0, 4)) {
    const media = wrapper.underlying_media.status.replaceAll('_', ' ')
    const destination = wrapper.landing_destination.ad_level_read_available
      ? `destination UTM ${wrapper.landing_destination.utm_status}`
      : 'current destination and UTM unavailable'
    lines.push(`${wrapper.name ?? wrapper.meta_ad_id}: ${wrapper.identity_summary.replaceAll('_', ' ')}; media ${media}; ${destination}.`)
  }
  return lines
}

function governedDecisionLines(evidence: ExecutiveEvidenceSnapshotV1 | null): string[] {
  if (!evidence) return ['Governed actions unavailable — executive evidence snapshot unavailable.']
  const blockers = evidence.governedActions.blockerCodes.join(', ') || 'governed action projection unavailable'
  return [`Governed actions unavailable — ${blockers}.`]
}

export function renderDailyDigestMarkdown(digest: Omit<DailyDigestV3, 'markdown'>): string {
  return [
    `# ${digest.subject}`,
    '',
    digest.account_name,
    '',
    section('Business', [digest.states.business.line]),
    '',
    section('Paid delivery', [digest.states.paid_delivery.line]),
    '',
    section('Data confidence', [digest.states.data_confidence.line]),
    '',
    section('Spend context', unclassifiedSpendContextLines(digest.pacing)),
    '',
    section('What changed', kpiLines(digest.kpis)),
    '',
    section('Observed flags', digest.flags.length > 0 ? bulleted(digest.flags) : ['No observed flag was emitted.']),
    '',
    section('Creative evidence', bulleted(digest.creative)),
    '',
    section('Deterministic read', [digest.narrative.text]),
    '',
    section('Governed actions', bulleted(digest.decisions)),
    '',
    '_Deterministic evidence summary. Diagnostic only; no new action authority is created here._',
  ].join('\n')
}

function evidenceSnapshotRef(
  evidence: ExecutiveEvidenceSnapshotV1,
): DailyDigestV3['evidence_snapshot'] {
  return {
    contract: 'executive_evidence_snapshot',
    version: 1,
    generated_at: evidence.generatedAt,
    as_of: evidence.asOf,
    last_complete_date: evidence.lastCompleteDate,
  }
}

export function buildDailyDigest(input: DailyDigestInput): DailyDigestV3 {
  if (!input.executiveEvidence) {
    throw new Error('Executive evidence snapshot is required for a Daily V3 digest')
  }
  const subject = `Maxx daily digest — ${input.reportDate}`
  const pacing = {
    spend: finiteOrNull(input.today.spend),
    // V3 cannot compare a single reported day with a CURRENT daily budget. Until an exact
    // budget-effective interval covers the trailing seven-day window, the classification is absent.
    target: null,
    band: 'unavailable' as const,
  }
  const states = deriveDigestDescriptiveStates(input.executiveEvidence)
  const parts: Omit<DailyDigestV3, 'markdown'> = {
    contract_version: 3,
    report_date: input.reportDate,
    account_name: input.accountName,
    generated_from: 'committed_report_facts',
    action_authority_tier: 'diagnostic_only',
    prescriptions: [],
    change_reporting_threshold_pct: RATE_THRESHOLD_PCT,
    subject,
    states,
    pacing,
    kpis: buildKpis(input),
    flags: evidenceFlags(input.executiveEvidence),
    creative: evidenceCreativeLines(input.executiveEvidence),
    decisions: governedDecisionLines(input.executiveEvidence),
    narrative: buildDeterministicDigestNarrative(states),
    evidence_snapshot: evidenceSnapshotRef(input.executiveEvidence),
  }

  return { ...parts, markdown: renderDailyDigestMarkdown(parts) }
}

const KPI_KEYS = new Set<string>(['spend', 'leads', 'bookings_real', 'bookings_meta', 'ctr', 'cpl'])
const KPI_UNITS = new Set<string>(['money', 'count', 'pct'])
const DELTA_STATES = new Set<string>(['no_baseline', 'within_noise', 'significant'])
const PACING_BANDS = new Set<string>(['green', 'yellow', 'orange', 'red', 'unavailable'])
const VERDICT_STATUSES = new Set<string>(['green', 'amber', 'red'])
const NARRATIVE_SOURCES = new Set<string>(['llm', 'deterministic_fallback'])
const BUSINESS_STATES = new Set<string>(['higher', 'lower', 'mixed', 'stable', 'insufficient_evidence', 'unavailable'])
const PAID_DELIVERY_STATES = new Set<string>(['improving', 'declining', 'mixed', 'stable', 'insufficient_evidence', 'unavailable'])
const DATA_CONFIDENCE_STATES = new Set<string>(['complete', 'degraded', 'unavailable'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function isNullableFinite(value: unknown): boolean {
  return value === null || (typeof value === 'number' && Number.isFinite(value))
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
}

/** Arity matters: a snapshot missing `bookings_real`, or carrying it twice, is not a valid KPI set. */
function hasEveryKpiExactlyOnce(value: unknown[]): boolean {
  const keys = value.map((entry) => (isRecord(entry) ? entry.key : undefined))
  const unique = new Set(keys)
  return unique.size === value.length && KPI_KEYS.size === unique.size
    && [...KPI_KEYS].every((key) => unique.has(key))
}

function isKpiArray(value: unknown): boolean {
  return Array.isArray(value) && hasEveryKpiExactlyOnce(value) && value.every((entry) =>
    isRecord(entry)
    && typeof entry.key === 'string' && KPI_KEYS.has(entry.key)
    && typeof entry.label === 'string'
    && isNullableFinite(entry.value)
    && typeof entry.unit === 'string' && KPI_UNITS.has(entry.unit)
    && isNullableFinite(entry.delta_pct)
    && typeof entry.noise_gated === 'boolean'
    && typeof entry.state === 'string' && DELTA_STATES.has(entry.state),
  )
}

function hasCommonEnvelope(row: Record<string, unknown>): boolean {
  return typeof row.report_date === 'string'
    && row.generated_from === 'committed_report_facts'
    && row.action_authority_tier === 'diagnostic_only'
    && Array.isArray(row.prescriptions)
    && row.prescriptions.length === 0
    && row.change_reporting_threshold_pct === RATE_THRESHOLD_PCT
    && typeof row.subject === 'string'
    && typeof row.markdown === 'string'
}

function hasV2Body(row: Record<string, unknown>): boolean {
  const verdict = row.verdict
  const pacing = row.pacing
  const narrative = row.narrative
  return typeof row.account_name === 'string'
    && isRecord(verdict)
    && typeof verdict.status === 'string' && VERDICT_STATUSES.has(verdict.status)
    && typeof verdict.line === 'string'
    && isRecord(pacing)
    && isNullableFinite(pacing.spend)
    && isNullableFinite(pacing.target)
    && typeof pacing.band === 'string' && PACING_BANDS.has(pacing.band)
    && isKpiArray(row.kpis)
    && isStringArray(row.flags)
    && isStringArray(row.creative)
    && isStringArray(row.decisions)
    && isRecord(narrative)
    && typeof narrative.text === 'string'
    && typeof narrative.source === 'string' && NARRATIVE_SOURCES.has(narrative.source)
}

function isDescriptiveState(value: unknown, allowed: Set<string>): boolean {
  return isRecord(value)
    && typeof value.state === 'string'
    && allowed.has(value.state)
    && typeof value.line === 'string'
}

function isEvidenceSnapshotRef(value: unknown): boolean {
  return isRecord(value)
    && value.contract === 'executive_evidence_snapshot'
    && value.version === 1
    && typeof value.generated_at === 'string'
    && typeof value.as_of === 'string'
    && typeof value.last_complete_date === 'string'
}

function hasV3Body(row: Record<string, unknown>): boolean {
  const states = row.states
  const pacing = row.pacing
  const narrative = row.narrative
  return typeof row.account_name === 'string'
    && isRecord(states)
    && isDescriptiveState(states.business, BUSINESS_STATES)
    && isDescriptiveState(states.paid_delivery, PAID_DELIVERY_STATES)
    && isDescriptiveState(states.data_confidence, DATA_CONFIDENCE_STATES)
    && isRecord(pacing)
    && isNullableFinite(pacing.spend)
    && pacing.target === null
    && pacing.band === 'unavailable'
    && isKpiArray(row.kpis)
    && isStringArray(row.flags)
    && isStringArray(row.creative)
    && isStringArray(row.decisions)
    && isRecord(narrative)
    && typeof narrative.text === 'string'
    && narrative.source === 'deterministic'
    && narrative.text === [
      (states.business as Record<string, unknown>).line,
      (states.paid_delivery as Record<string, unknown>).line,
      (states.data_confidence as Record<string, unknown>).line,
    ].join(' ')
    && row.subject === `Maxx daily digest — ${row.report_date}`
    && isEvidenceSnapshotRef(row.evidence_snapshot)
}

export function readDailyDigestSnapshot(value: unknown): DailyDigest | DailyDigestV2 | DailyDigestV3 | null {
  if (!isRecord(value)) return null
  if (!hasCommonEnvelope(value)) return null
  if (value.contract_version === 1) return value as unknown as DailyDigest
  if (value.contract_version === 2 && hasV2Body(value)) return value as unknown as DailyDigestV2
  if (value.contract_version === 3 && hasV3Body(value)) {
    const digest = value as unknown as DailyDigestV3
    return digest.markdown === renderDailyDigestMarkdown(digest) ? digest : null
  }
  return null
}

export function isDailyDigestV2(digest: DailyDigest | DailyDigestV2 | DailyDigestV3): digest is DailyDigestV2 {
  return digest.contract_version === 2
}

export function isDailyDigestV3(digest: DailyDigest | DailyDigestV2 | DailyDigestV3): digest is DailyDigestV3 {
  return digest.contract_version === 3
}
