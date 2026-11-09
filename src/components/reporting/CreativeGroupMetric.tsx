'use client'

import { useId, useState } from 'react'
import type { CreativeGroupInput, CreativeGroupMetric as GroupMetric, CreativeGroupMetricPeriod } from '@/lib/reporting/creative-group-metrics'
import { reportCurrencyValue, reportMetricValue } from './MetricValue'

const REASONS: Record<string, string> = {
  assignment_history_missing: 'Assignment history is unavailable for this window.',
  assignment_identity_missing: 'Historical creative identity is missing.',
  assignment_changed: 'The creative assignment changed during this window.',
  ad_mutation_ambiguous: 'An ad change prevents a stable historical assignment.',
  assignment_evidence_invalid: 'Assignment evidence could not be validated.',
  prior_membership_unproven: 'Previous membership is not established for the same executions.',
  prior_creative_differs: 'The same executions used a different creative in the previous period.',
  missing_input: 'A required native input is unavailable.',
  incompatible_native_input: 'Native input definitions or periods do not match.',
  invalid_native_value: 'A native input does not contain a valid measured amount.',
  incomplete_input_coverage: 'The selected executions do not have complete input coverage.',
  partial_input_period: 'A required input covers an incomplete period.',
  incompatible_source_observations: 'The native inputs were not observed at the same time.',
  native_combined_population_required: 'Meta has not supplied a combined measure for these executions; this metric cannot be added across ads.',
  zero_denominator: 'The denominator is an observed zero, so the rate is unavailable.',
  invalid_retention_inputs: 'The reported watch inputs do not establish a valid retention rate.',
  source_ratio_withheld: 'The native source withheld this rate.',
  missing_source_ratio: 'This report did not include this cost measure for every selected ad.',
  nonfinite_result: 'These inputs do not establish a finite result.',
  unsafe_aggregate_value: 'The aggregate exceeds the supported exact numeric range.',
}
export const creativeEvidenceReason = (reason: string | null) => reason ? REASONS[reason] ?? 'The required evidence could not be established.' : ''

export function creativeGroupMetricValue(metric: GroupMetric, period: 'current' | 'previous' = 'current'): string {
  const { value, unavailableReason } = metric[period]
  if (unavailableReason || value === null || !Number.isFinite(value)) return 'Unavailable'
  switch (metric.unit) {
    case 'money': return reportCurrencyValue(value, metric.key)
    case 'percent': return `${value.toFixed(1)}%`
    case 'ratio': return `${value.toFixed(2)}×`
    case 'seconds': return `${value.toFixed(1)} s`
    default: return value.toLocaleString('en-US', { maximumFractionDigits: 1 })
  }
}

function NativeInput({ input, period }: { input: CreativeGroupInput; period: 'current' | 'previous' }) {
  const claim = input.claim
  const [expanded, setExpanded] = useState(false)
  return <li data-native-input className="space-y-1 border-t border-[var(--border)] py-3 text-xs break-words">
    <p className="font-semibold">Ad {input.adId} · {input.metric?.label ?? input.metricKey} · {input.role}</p>
    <p>{reportMetricValue(input.metric ?? undefined, period === 'previous')}{input.reason ? ` · ${creativeEvidenceReason(input.reason)}` : ''}</p>
    <p>{input.path}</p>
    {claim && <>
      <p>{claim.window.start} – {claim.window.end} · {claim.window.timezone} · {claim.window.basis}</p>
      <p>Source: {claim.source.system} · {claim.source.head} · {claim.attributionScope}{input.metric?.event ? ` · ${input.metric.event}` : ''}</p>
      <p>Claim as of {claim.asOf} · Meta report as of {input.sourceAsOf}</p>
      <p>Coverage: {claim.coverage.state} · Maturity: {claim.maturity.state} · Freshness: {claim.freshness.state}</p>
    </>}
    <details onToggle={event => setExpanded(event.currentTarget.open)}>
      <summary className="inline-flex min-h-11 cursor-pointer items-center underline underline-offset-4">Exact native metric and claim</summary>
      {expanded && <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-all rounded bg-[var(--bg-subtle)] p-3">{JSON.stringify({ metric: input.metric, claim }, null, 2)}</pre>}
    </details>
  </li>
}

function PeriodInputs({ value, period }: { value: CreativeGroupMetricPeriod; period: 'current' | 'previous' }) {
  return <section className="min-w-0">
    <h5 className="font-semibold">{period === 'current' ? 'Current inputs' : 'Previous inputs'}</h5>
    <p className="text-xs">Coverage: {value.coverage}</p>
    {value.unavailableReason && <p className="mt-1 text-xs">{creativeEvidenceReason(value.unavailableReason)}</p>}
    <ul>{value.inputs.map((input, index) => <NativeInput key={`${input.adId}:${input.metricKey}:${index}`} input={input} period={period} />)}</ul>
    {value.limitations.map(note => <p className="mt-2 text-xs" key={note}>{note}</p>)}
  </section>
}

/** Calculations are rendered separately from native ReportMetric claims. Inputs mount on demand. */
export function CreativeGroupMetric({ metric }: { metric: GroupMetric }) {
  const [expanded, setExpanded] = useState(false), detailsId = useId()
  const notices = (['current', 'previous'] as const).flatMap(period => {
    const value = metric[period], prefix = period === 'current' ? 'Current' : 'Previous'
    return (value.unavailableReason ? [creativeEvidenceReason(value.unavailableReason)] : value.limitations.slice(1)).map(note => `${prefix}: ${note}`)
  })
  return <section className="min-w-0 rounded-xl border border-[var(--border)] p-4" aria-label={metric.label}>
    <h4 className="text-sm font-medium">{metric.label}</h4>
    <div className="mt-2 grid grid-cols-2 gap-3 tabular-nums">
      <div><p className="text-xs text-[var(--text-secondary)]">Current</p><p className="text-lg font-semibold">{creativeGroupMetricValue(metric)}</p></div>
      <div><p className="text-xs text-[var(--text-secondary)]">Previous</p><p className="text-lg font-semibold">{creativeGroupMetricValue(metric, 'previous')}</p></div>
    </div>
    {notices.map(note => <p className="mt-2 text-xs leading-5 text-[var(--text-secondary)]" key={note}>{note}</p>)}
    <button type="button" aria-label={`Inputs for ${metric.label}`} aria-expanded={expanded} aria-controls={detailsId}
      onClick={() => setExpanded(value => !value)} className="min-h-11 text-xs underline underline-offset-4">Calculation and inputs</button>
    {expanded && <div id={detailsId} className="space-y-4 border-t border-[var(--border)] pt-3">
      <p className="text-xs leading-5">{metric.definition}</p>
      <p className="text-xs">Calculation: {metric.calculation === 'ratio_of_sums' ? 'Ratio of summed native inputs; individual ad rates are not averaged.'
        : metric.calculation === 'sum' ? 'Sum of compatible native inputs for these executions.' : 'Native measure for a single execution population.'}</p>
      {metric.event && <p className="text-xs">Named event: {metric.event}</p>}
      <PeriodInputs value={metric.current} period="current" /><PeriodInputs value={metric.previous} period="previous" />
    </div>}
  </section>
}
