import { createMetricClaim, type MetricClaim, type MetricClaimInput } from '@/lib/cockpit/contracts'
import type { ReportMetric, ReportingContext, ReportingRange } from './contracts'

export interface ReportMetricInput {
  context: ReportingContext
  key: string
  label: string
  definition: string
  source: MetricClaim['source']['system']
  unit: MetricClaim['unit']
  current: number | string | null
  previous?: number | string | null
  event?: string | null
  entity?: MetricClaim['entity']
  coverage?: MetricClaim['coverage']
  previousCoverage?: MetricClaim['coverage']
  reason?: string
  previousReason?: string
  currentAsOf?: string
  previousAsOf?: string
  sourceHead?: string | null
  measurementKind?: MetricClaim['measurementKind']
  attributionScope?: MetricClaim['attributionScope']
  basis?: MetricClaim['window']['basis']
  inputMetrics?: readonly ReportMetric[]
  maturity?: MetricClaim['maturity']
  previousMaturity?: MetricClaim['maturity']
  freshness?: MetricClaim['freshness']
  comparison?: 'none'
}

const SOURCES: Record<ReportMetricInput['source'], Pick<MetricClaim['source'], 'role' | 'evidencePlane'>> = {
  meta: { role: 'delivery_truth', evidencePlane: 'meta_delivery' },
  outcomes: { role: 'business_truth', evidencePlane: 'outcome_business' },
  ga4: { role: 'measurement_qa', evidencePlane: 'ga4_telemetry' },
  first_party_attribution: { role: 'association_truth', evidencePlane: 'paid_association' },
  capi: { role: 'delivery_transport', evidencePlane: 'capi_delivery' },
  maxx: { role: 'decision_context', evidencePlane: 'decision' },
}
export const COMPLETE_FIELD_COVERAGE: MetricClaim['coverage'] = { state: 'complete', numerator: 1, denominator: 1 }
export const UNKNOWN_FIELD_COVERAGE: MetricClaim['coverage'] = { state: 'unknown', numerator: null, denominator: null }

function claim(input: ReportMetricInput, prior: boolean): MetricClaim {
  const range: ReportingRange = prior ? input.context.comparison : input.context.range
  const coverage = (prior ? input.previousCoverage : input.coverage) ?? UNKNOWN_FIELD_COVERAGE
  const raw = (prior ? input.previous : input.current) ?? null
  const valid = (typeof raw === 'number' && Number.isFinite(raw)) || (typeof raw === 'string' && raw.trim().length > 0)
  const ratioBlocked = (input.unit === 'ratio' || input.unit === 'percent') && coverage.state !== 'complete'
  const value = valid && !ratioBlocked ? raw : null
  const entity = input.entity ?? { level: input.source === 'outcomes' ? 'business' : 'account', id: input.context.account.id }
  const asOf = (prior ? input.previousAsOf : input.currentAsOf) ?? input.context.asOf
  const basis = input.basis ?? (input.source === 'outcomes' ? 'booking_created_date_et' : 'closed_account_days')
  const reason = (prior ? input.previousReason : input.reason)
    ?? (ratioBlocked ? 'report_metric_coverage_incomplete' : 'report_metric_not_supplied')
  const inputClaimIds = (input.inputMetrics ?? []).flatMap(metric => {
    const value = prior ? metric.previous : metric.current
    return value ? [value.claimId] : []
  })
  const window = { start: range.from, end: range.to, basis, timezone: input.context.timezone }
  const shape: MetricClaimInput = {
    claimId: `report:${input.source}:${entity.level}:${entity.id}:${input.key}:${range.from}:${range.to}`,
    metricKey: `${input.source}.${input.key}`, label: input.label, value, unit: input.unit,
    formula: input.definition.slice(0, 500), definitionVersion: 1,
    source: { system: input.source, ...SOURCES[input.source], head: input.sourceHead ?? null },
    entity,
    attributionScope: input.attributionScope ?? (input.source === 'outcomes' ? 'all_sources' : input.source === 'ga4' ? 'ga4_session_classified' : 'none'),
    window,
    comparison: prior || input.comparison === 'none' ? { method: 'none', window: null } : {
      method: 'prior_equal_period',
      window: { start: input.context.comparison.from, end: input.context.comparison.to, basis, timezone: input.context.timezone },
    },
    asOf,
    availability: value === null
      ? { state: 'unavailable', blockerCodes: [reason.slice(0, 160)] }
      : { state: 'available', blockerCodes: [] },
    coverage,
    maturity: (prior ? input.previousMaturity ?? input.maturity : input.maturity) ?? { state: 'not_applicable', matureThrough: null },
    freshness: input.freshness ?? { state: 'unknown', observedAt: asOf, maxAgeHours: null },
    setupFingerprint: null,
    authority: { state: 'diagnostic', policyVersion: 'reporting-v1' },
    measurementKind: input.measurementKind ?? (input.source === 'ga4' ? 'telemetry' : input.source === 'outcomes' ? 'operational' : 'measured'),
    inputClaimIds,
  }
  return createMetricClaim(shape)
}

export function makeReportMetric(input: ReportMetricInput): ReportMetric {
  return {
    key: input.key, label: input.label, definition: input.definition, event: input.event ?? null,
    current: claim(input, false), previous: input.previous === undefined ? null : claim(input, true),
  }
}
